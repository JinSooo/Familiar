import { createHash, randomBytes } from 'node:crypto'
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { sensitiveReason } from './sensitive'

/**
 * Memory lives in Markdown under `<workspace>/memory/`; these files are the only truth and the
 * user may edit them by hand. One file per category, one `- ` list item per memory; the
 * trailing `<!-- familiar {...} -->` comment carries metadata. Every other line (headings,
 * the user's own notes) is kept as is. A list item without the comment counts as written by
 * the user and confirmed; its id is derived from its text so it stays stable until rewritten.
 */
export type MemoryCategory = 'profile' | 'habits' | 'topic'
export type MemoryStatus = 'confirmed' | 'superseded'

export interface MemoryMeta {
  id: string
  /** YYYY-MM-DD the memory was written. */
  at: string
  /** user: the user asked to remember it, or wrote it into the file. */
  source: 'user'
  status: MemoryStatus
  /** For a superseded memory: the id that replaced it. */
  by?: string
}
export interface MemoryEntry extends MemoryMeta {
  text: string
  category: MemoryCategory
  topic?: string
}

const marker = / <!-- familiar (\{.*\}) -->$/
const titles: Record<Exclude<MemoryCategory, 'topic'>, string> = {
  profile: '画像',
  habits: '习惯',
}

export function newMemoryId(): string {
  return `m-${randomBytes(3).toString('hex')}`
}
export function today(now = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`
}

/** One line of text: no newlines, and nothing that could close or fake our comment. */
export function cleanText(text: string): string {
  return text
    .replace(/<!--|-->/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}
/** A topic name usable as a file name; keeps CJK, letters, digits, - and _. */
export function topicFileName(topic: string): string {
  const name = [
    ...topic
      .trim()
      .replace(/[^\p{L}\p{N}_-]+/gu, '-')
      .replace(/^-+|-+$/g, ''),
  ]
    .slice(0, 40)
    .join('')
  if (!name) throw new Error('主题名无效')
  return name
}

interface Item {
  line: number
  entry: Omit<MemoryEntry, 'category' | 'topic'>
}
export function parseLines(lines: string[]): Item[] {
  const items: Item[] = []
  lines.forEach((raw, line) => {
    if (!raw.startsWith('- ')) return
    const match = marker.exec(raw)
    let body = (match ? raw.slice(0, match.index) : raw).slice(2).trim()
    let meta: Partial<MemoryMeta> = {}
    if (match)
      try {
        meta = JSON.parse(match[1]!) as Partial<MemoryMeta>
      } catch {
        /* A damaged comment: treat the line as hand-written. */
      }
    const struck = /^~~(.*)~~$/.exec(body)
    if (struck) body = struck[1]!.trim()
    if (!body) return
    items.push({
      line,
      entry: {
        id:
          typeof meta.id === 'string'
            ? meta.id
            : `m-${createHash('sha1').update(body).digest('hex').slice(0, 6)}`,
        at: typeof meta.at === 'string' ? meta.at : '',
        source: 'user',
        status: meta.status === 'superseded' ? 'superseded' : 'confirmed',
        ...(typeof meta.by === 'string' ? { by: meta.by } : {}),
        text: body,
      },
    })
  })
  return items
}
export function formatLine(
  entry: Omit<MemoryEntry, 'category' | 'topic'>,
): string {
  const { text, ...meta } = entry
  const body = entry.status === 'superseded' ? `~~${text}~~` : text
  return `- ${body} <!-- familiar ${JSON.stringify(meta)} -->`
}

export class MemoryStore {
  // Writes are read-modify-write on whole files; run them one at a time.
  private queue: Promise<unknown> = Promise.resolve()
  constructor(readonly dir: string) {}

  private file(category: MemoryCategory, topic?: string): string {
    return category === 'topic'
      ? join(this.dir, 'topics', `${topicFileName(topic ?? '')}.md`)
      : join(this.dir, `${category}.md`)
  }
  private header(category: MemoryCategory, topic?: string): string {
    const title =
      category === 'topic'
        ? `主题：${topicFileName(topic ?? '')}`
        : titles[category]
    return `# ${title}\n\n<!-- 由 Familiar 维护，可以直接编辑。每行末尾的注释是元数据；没有注释的条目算作你写的、已确认的记忆。 -->\n`
  }
  private async lines(path: string): Promise<string[] | null> {
    try {
      return (await readFile(path, 'utf8')).split('\n')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw error
    }
  }
  private serial<T>(work: () => Promise<T>): Promise<T> {
    const next = this.queue.then(work, work)
    this.queue = next.catch(() => {})
    return next
  }

  async topics(): Promise<string[]> {
    try {
      return (await readdir(join(this.dir, 'topics')))
        .filter((name) => name.endsWith('.md'))
        .map((name) => name.slice(0, -3))
        .sort()
    } catch {
      return []
    }
  }

  async list(): Promise<MemoryEntry[]> {
    const files: { category: MemoryCategory; topic?: string }[] = [
      { category: 'profile' },
      { category: 'habits' },
      ...(await this.topics()).map((topic) => ({
        category: 'topic' as const,
        topic,
      })),
    ]
    const entries: MemoryEntry[] = []
    for (const { category, topic } of files) {
      const lines = await this.lines(this.file(category, topic))
      if (lines)
        for (const { entry } of parseLines(lines))
          entries.push({ ...entry, category, ...(topic ? { topic } : {}) })
    }
    return entries
  }

  /** Adds a confirmed memory; with `replaces`, marks that one superseded instead of deleting it. */
  add(input: {
    category: MemoryCategory
    topic?: string
    text: string
    replaces?: string
  }): Promise<MemoryEntry> {
    return this.serial(async () => {
      const text = cleanText(input.text)
      if (!text) throw new Error('记忆内容为空')
      const reason = sensitiveReason(text)
      if (reason) throw new Error(`${reason}，不能写入记忆`)
      const entry: MemoryEntry = {
        id: newMemoryId(),
        at: today(),
        source: 'user',
        status: 'confirmed',
        text,
        category: input.category,
        ...(input.category === 'topic'
          ? { topic: topicFileName(input.topic ?? '') }
          : {}),
      }
      if (input.replaces) {
        const found = await this.locate(input.replaces)
        if (!found) throw new Error(`没有找到记忆 ${input.replaces}`)
        found.lines[found.line] = formatLine({
          ...found.entry,
          status: 'superseded',
          by: entry.id,
        })
        await writeFile(found.path, found.lines.join('\n'))
      }
      const path = this.file(entry.category, entry.topic)
      await mkdir(join(path, '..'), { recursive: true })
      const lines =
        (await this.lines(path)) ??
        this.header(entry.category, entry.topic).split('\n')
      while (lines.length && lines.at(-1) === '') lines.pop()
      const last = parseLines(lines).at(-1)?.line
      // Keep the list together: append after the last item, or after the header block.
      if (last === undefined) lines.push('', formatLine(entry))
      else lines.splice(last + 1, 0, formatLine(entry))
      await writeFile(path, `${lines.join('\n')}\n`)
      return entry
    })
  }

  /** Deletes a memory for good (the git snapshot still has it). */
  remove(id: string): Promise<MemoryEntry> {
    return this.serial(async () => {
      const found = await this.locate(id)
      if (!found) throw new Error(`没有找到记忆 ${id}`)
      found.lines.splice(found.line, 1)
      await writeFile(found.path, found.lines.join('\n'))
      return found.entry
    })
  }

  private async locate(id: string) {
    for (const entry of await this.list()) {
      if (entry.id !== id) continue
      const path = this.file(entry.category, entry.topic)
      const lines = (await this.lines(path)) ?? []
      const item = parseLines(lines).find((i) => i.entry.id === id)
      if (item) return { path, lines, line: item.line, entry }
    }
    return null
  }
}

/** What goes into the system prompt every turn: confirmed profile and habits, plus topic names. */
export async function memoryContext(
  store: MemoryStore,
  limit = 3000,
): Promise<string> {
  const entries = (await store.list()).filter((e) => e.status === 'confirmed')
  const topics = await store.topics()
  const sections: string[] = []
  let used = 0
  let dropped = 0
  for (const category of ['profile', 'habits'] as const) {
    const lines: string[] = []
    for (const e of entries.filter((e) => e.category === category)) {
      const line = `- [${e.id}] ${e.text}`
      if (used + line.length > limit) {
        dropped++
        continue
      }
      used += line.length
      lines.push(line)
    }
    if (lines.length)
      sections.push(`${titles[category]}：\n${lines.join('\n')}`)
  }
  if (topics.length) sections.push(`已有主题：${topics.join('、')}`)
  if (dropped) sections.push(`（还有 ${dropped} 条未列出）`)
  return sections.join('\n')
}
