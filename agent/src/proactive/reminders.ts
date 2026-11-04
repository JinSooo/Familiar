import { createHash } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Reminder } from '../../../src/shared'
import { dataDir } from '../system'

/**
 * Reminders in ~/.familiar/reminders.md, one per line, readable and editable:
 *   - [ ] 2026-11-02 10:00 交周报 <!-- {"id":"r1a2b","kind":"reminder"} -->
 * A line without the comment is one the user wrote; it counts as a reminder.
 * A line with no date and time is a to-do: it has no due time and never goes off by itself.
 *   - [ ] 买牛奶
 */
const file = () => join(dataDir, 'reminders.md')
const header =
  '# 提醒\n\n<!-- 由 Familiar 维护，可以直接编辑：- [ ] 日期 时间 内容；不写日期时间就是待办：- [ ] 内容。勾上 [x] 就算完成。 -->\n'
const line =
  /^- \[( |x)\] (\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}) (.+?)(?: <!-- (\{.*\}) -->)?$/
/** A to-do: no date and time up front. A malformed date and time is neither this nor a reminder. */
const todoLine =
  /^- \[( |x)\] (?!\d{4}-\d{2}-\d{2} \d{2}:\d{2} )(.+?)(?: <!-- (\{.*\}) -->)?$/

const pad = (n: number) => String(n).padStart(2, '0')
export function stamp(at: number): string {
  const d = new Date(at)
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}
export const newReminderId = () =>
  `r${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`

type Meta = { id?: string; kind?: string; done?: number }
function metaOf(json: string | undefined): Meta {
  if (!json) return {}
  try {
    return JSON.parse(json) as Meta
  } catch {
    // A hand-broken comment: keep the line, give it a fresh id.
    return {}
  }
}

/** Dated lines by time; to-dos after them, in file order. */
const byTime = (a: Reminder, b: Reminder) =>
  a.at === undefined || b.at === undefined
    ? Number(a.at === undefined) - Number(b.at === undefined)
    : a.at - b.at

export function parseReminders(text: string): Reminder[] {
  const list: Reminder[] = []
  // Hand-written lines can share a time or a text; every line still needs an id of its own.
  const used = new Set<string>()
  const unique = (id: string) => {
    let next = id
    for (let n = 1; used.has(next); n++) next = `${id}-${n}`
    used.add(next)
    return next
  }
  for (const raw of text.split('\n')) {
    const trimmed = raw.trim()
    const m = line.exec(trimmed)
    if (m) {
      const at = new Date(`${m[2]}T${m[3]}:00`).getTime()
      if (!Number.isFinite(at)) continue
      const meta = metaOf(m[5])
      list.push({
        id: unique(
          typeof meta.id === 'string' ? meta.id : `h${at.toString(36)}`,
        ),
        at,
        text: m[4]!.trim(),
        kind: meta.kind === 'follow-up' ? 'follow-up' : 'reminder',
        ...(m[1] === 'x'
          ? { done: typeof meta.done === 'number' ? meta.done : at }
          : {}),
      })
      continue
    }
    const t = todoLine.exec(trimmed)
    if (!t) continue
    const body = t[2]!.trim()
    const meta = metaOf(t[3])
    list.push({
      id: unique(
        typeof meta.id === 'string'
          ? meta.id
          : `t${createHash('sha1').update(body).digest('hex').slice(0, 6)}`,
      ),
      text: body,
      kind: 'todo',
      ...(t[1] === 'x'
        ? { done: typeof meta.done === 'number' ? meta.done : Date.now() }
        : {}),
    })
  }
  return list.sort(byTime)
}

export function formatReminders(list: Reminder[]): string {
  const rows = [...list].sort(byTime).map((r) => {
    const meta = JSON.stringify({
      id: r.id,
      kind: r.kind,
      ...(r.done ? { done: r.done } : {}),
    })
    const when = r.at === undefined ? '' : `${stamp(r.at)} `
    return `- [${r.done ? 'x' : ' '}] ${when}${r.text.replace(/\s+/g, ' ')} <!-- ${meta} -->`
  })
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
