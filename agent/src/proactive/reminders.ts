import { createHash } from 'node:crypto'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
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
/** Reject normalized dates (including nonexistent local times at DST transitions). */
export function parseReminderTime(value: string): number | undefined {
  if (!/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(value)) return undefined
  const date = new Date(`${value.replace(' ', 'T')}:00`)
  if (!Number.isFinite(date.getTime()) || stamp(date.getTime()) !== value)
    return undefined
  return date.getTime()
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
      const at = parseReminderTime(`${m[2]} ${m[3]}`)
      if (at === undefined) continue
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
/** Serialized read-modify-write. The callback may be retried and must have no side effects. */
export function updateReminders<T>(
  change: (list: Reminder[]) => { list: Reminder[]; result: T },
): Promise<T> {
  const work = async () => {
    await mkdir(dataDir, { recursive: true })
    try {
      for (let attempt = 0; attempt < 5; attempt++) {
        const before = await readText()
        const { list, result } = change(parseReminders(before ?? ''))
        const day = Date.now() - 86400000
        const kept = list.filter((r) => !r.done || r.done > day)
        await writeFile(`${file()}.tmp`, formatReminders(kept), { mode: 0o600 })
        // Editors do not share our queue. Reapply the operation to their latest save.
        if ((await readText()) !== before) continue
        await rename(`${file()}.tmp`, file())
        return result
      }
      throw new Error('提醒文件正在被修改，请稍后再试')
    } finally {
      await rm(`${file()}.tmp`, { force: true })
    }
  }
  const next = queue.then(work, work)
  queue = next.catch(() => {})
  return next
}

async function readText(): Promise<string | undefined> {
  try {
    return await readFile(file(), 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
}

export async function readReminders(): Promise<Reminder[]> {
  return parseReminders((await readText()) ?? '')
}
