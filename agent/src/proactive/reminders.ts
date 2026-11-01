import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Reminder } from '../../../src/shared'
import { dataDir } from '../system'

/**
 * Reminders in ~/.familiar/reminders.md, one per line, readable and editable:
 *   - [ ] 2026-11-02 10:00 交周报 <!-- {"id":"r1a2b","kind":"reminder"} -->
 * A line without the comment is one the user wrote; it counts as a reminder.
 */
const file = () => join(dataDir, 'reminders.md')
const header =
  '# 提醒\n\n<!-- 由 Familiar 维护，可以直接编辑：- [ ] 日期 时间 内容。勾上 [x] 就算完成。 -->\n'
const line =
  /^- \[( |x)\] (\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}) (.+?)(?: <!-- (\{.*\}) -->)?$/

const pad = (n: number) => String(n).padStart(2, '0')
export function stamp(at: number): string {
  const d = new Date(at)
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}
export const newReminderId = () =>
  `r${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`

export function parseReminders(text: string): Reminder[] {
  const list: Reminder[] = []
  for (const raw of text.split('\n')) {
    const m = line.exec(raw.trim())
    if (!m) continue
    const at = new Date(`${m[2]}T${m[3]}:00`).getTime()
    if (!Number.isFinite(at)) continue
    let meta: { id?: string; kind?: string; done?: number } = {}
    try {
      meta = m[5] ? (JSON.parse(m[5]) as typeof meta) : {}
    } catch {
      // A hand-broken comment: keep the reminder, give it a fresh id.
    }
    list.push({
      id: typeof meta.id === 'string' ? meta.id : `h${at.toString(36)}`,
      at,
      text: m[4]!.trim(),
      kind: meta.kind === 'follow-up' ? 'follow-up' : 'reminder',
      ...(m[1] === 'x'
        ? { done: typeof meta.done === 'number' ? meta.done : at }
        : {}),
    })
  }
  return list.sort((a, b) => a.at - b.at)
}

export function formatReminders(list: Reminder[]): string {
  const rows = [...list]
    .sort((a, b) => a.at - b.at)
    .map(
      (r) =>
        `- [${r.done ? 'x' : ' '}] ${stamp(r.at)} ${r.text.replace(/\s+/g, ' ')} <!-- ${JSON.stringify(
          {
            id: r.id,
            kind: r.kind,
            ...(r.done ? { done: r.done } : {}),
          },
        )} -->`,
    )
  return `${header}\n${rows.join('\n')}${rows.length ? '\n' : ''}`
}

let queue: Promise<unknown> = Promise.resolve()
/** Read-modify-write, one at a time; finished reminders older than a day are dropped. */
export function updateReminders<T>(
  change: (list: Reminder[]) => { list: Reminder[]; result: T },
): Promise<T> {
  const work = async () => {
    const { list, result } = change(await readReminders())
    const day = Date.now() - 86400000
    const kept = list.filter((r) => !r.done || r.done > day)
    await mkdir(dataDir, { recursive: true })
    await writeFile(`${file()}.tmp`, formatReminders(kept), { mode: 0o600 })
    await rename(`${file()}.tmp`, file())
    return result
  }
  const next = queue.then(work, work)
  queue = next.catch(() => {})
  return next
}

export async function readReminders(): Promise<Reminder[]> {
  try {
    return parseReminders(await readFile(file(), 'utf8'))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
}
