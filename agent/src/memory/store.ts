import { createHash, randomBytes } from 'node:crypto'
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { sensitiveReason } from './sensitive'

/**
 * Memory lives in Markdown under `<workspace>/memory/`; these files are the only truth and the
 * user may edit them by hand. One file per category, one `- ` list item per memory; the
 * trailing `<!-- familiar {...} -->` comment carries metadata. Every other line (headings,
 * the user's own notes) is kept as is. A list item without the comment counts as written by
 * the user and confirmed; its id is derived from its text so it stays stable until rewritten.
 *
 * Files: profile.md, habits.md, lessons.md, topics/<topic>.md, pending.md (inferred, waiting for the user)
 * and timeline/<period>.md, where a period is a day (2026-10-27), ISO week (2026-W44) or
 * month (2026-10).
 */
export type MemoryCategory =
  'profile' | 'habits' | 'lessons' | 'topic' | 'pending' | 'timeline'
/** Where a confirmed memory can live. */
export type KeptCategory = 'profile' | 'habits' | 'lessons' | 'topic'
export type MemoryStatus = 'confirmed' | 'superseded' | 'pending'

export interface MemoryMeta {
  id: string
  /** YYYY-MM-DD the memory was written. */
  at: string
  /** user: asked for or written by the user; reflection: inferred from conversations. */
  source: 'user' | 'reflection'
  status: MemoryStatus
  /** For a superseded memory: the id that replaced it. */
  by?: string
  /** Pending only: where it goes once confirmed, how sure, why, and which conversations saw it. */
  target?: KeptCategory
  targetTopic?: string
  confidence?: number
  evidence?: string
  seen?: string[]
  /** Timeline entries written from Computer History: the period they cover and its apps. */
  activity?: ActivityMeta
  /** Timeline entries written from a conversation: its id, so the entry can open it again. */
  conversation?: string
  /** A rolled-up timeline line: every conversation the lines merged into it came from. */
  conversations?: string[]
}
export interface ActivityMeta {
  title: string
  start: number
  end: number
  apps: { bundleId: string; name: string }[]
}
export interface MemoryEntry extends MemoryMeta {
  text: string
  category: MemoryCategory
  /** The topic name for topics, the period for timeline entries. */
  key?: string
}

const marker = / <!-- familiar (\{.*\}) -->$/
const titles = {
  profile: '画像',
  habits: '习惯',
  lessons: '经验',
  pending: '待确认（它对我的判断）',
} as const
/** Distinct conversations that must show the same inference before it is kept unasked. */
export const promoteAfter = 3

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
const period = /^\d{4}-(\d{2}-\d{2}|W\d{2}|\d{2})$/

interface Item {
  line: number
  entry: Omit<MemoryEntry, 'category' | 'key'>
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
    const status: MemoryStatus =
      meta.status === 'superseded' || meta.status === 'pending'
        ? meta.status
        : 'confirmed'
    items.push({
      line,
      entry: {
        ...meta,
        id:
          typeof meta.id === 'string'
            ? meta.id
            : `m-${createHash('sha1').update(body).digest('hex').slice(0, 6)}`,
        at: typeof meta.at === 'string' ? meta.at : '',
        source: meta.source === 'reflection' ? 'reflection' : 'user',
        status,
        text: body,
      },
    })
  })
  return items
}
export function formatLine(
  entry: Omit<MemoryEntry, 'category' | 'key'> &
    Partial<Pick<MemoryEntry, 'category' | 'key'>>,
): string {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { text, category, key, ...meta } = entry
  const body = entry.status === 'superseded' ? `~~${text}~~` : text
  return `- ${body} <!-- familiar ${JSON.stringify(meta)} -->`
}
function checked(text: string): string {
  const clean = cleanText(text)
  if (!clean) throw new Error('记忆内容为空')
  const reason = sensitiveReason(clean)
  if (reason) throw new Error(`${reason}，不能写入记忆`)
  return clean
}

export class MemoryStore {
  // Writes are read-modify-write on whole files; run them one at a time.
  private queue: Promise<unknown> = Promise.resolve()
  /**
   * Kept memories deleted in this process, so a reflection already under way cannot write them
   * back. Held in memory only: writing down what the user asked to forget would defeat it.
   */
  private forgotten: { text: string; at: number }[] = []
  constructor(readonly dir: string) {}

  /** Texts of kept memories deleted in the last 24 hours. */
  recentlyForgotten(now = Date.now()): string[] {
    this.forgotten = this.forgotten.filter((f) => now - f.at < 86400000)
    return this.forgotten.map((f) => f.text)
  }

  file(category: MemoryCategory, key?: string): string {
    if (category === 'topic')
      return join(this.dir, 'topics', `${topicFileName(key ?? '')}.md`)
    if (category === 'timeline') {
      if (!key || !period.test(key)) throw new Error('时间线时段无效')
      return join(this.dir, 'timeline', `${key}.md`)
    }
    return join(this.dir, `${category}.md`)
  }
  private header(category: MemoryCategory, key?: string): string {
    const title =
      category === 'topic'
        ? `主题：${topicFileName(key ?? '')}`
        : category === 'timeline'
          ? `时间线：${key}`
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
  private async names(sub: string): Promise<string[]> {
    try {
      return (await readdir(join(this.dir, sub)))
        .filter((name) => name.endsWith('.md'))
        .map((name) => name.slice(0, -3))
        .sort()
    } catch {
      return []
    }
  }

  topics(): Promise<string[]> {
    return this.names('topics')
  }
  async periods(): Promise<string[]> {
    return (await this.names('timeline')).filter((p) => period.test(p))
  }

  /** Every memory file and its current lines; also the index's change fingerprint source. */
  async files(): Promise<
    { category: MemoryCategory; key?: string; path: string }[]
  > {
    return [
      ...(['profile', 'habits', 'lessons', 'pending'] as const).map(
        (category) => ({
          category,
          path: this.file(category),
        }),
      ),
      ...(await this.topics()).map((key) => ({
        category: 'topic' as const,
        key,
        path: this.file('topic', key),
      })),
      ...(await this.periods()).map((key) => ({
        category: 'timeline' as const,
        key,
        path: this.file('timeline', key),
      })),
    ]
  }

  async list(): Promise<MemoryEntry[]> {
    const entries: MemoryEntry[] = []
    for (const { category, key, path } of await this.files()) {
      const lines = await this.lines(path)
      if (lines)
        for (const { entry } of parseLines(lines))
          entries.push({ ...entry, category, ...(key ? { key } : {}) })
    }
    return entries
  }

  private async append(entry: MemoryEntry): Promise<void> {
    const path = this.file(entry.category, entry.key)
    await mkdir(dirname(path), { recursive: true })
    const lines =
      (await this.lines(path)) ??
      this.header(entry.category, entry.key).split('\n')
    while (lines.length && lines.at(-1) === '') lines.pop()
    const last = parseLines(lines).at(-1)?.line
    // Keep the list together: append after the last item, or after the header block.
    if (last === undefined) lines.push('', formatLine(entry))
    else lines.splice(last + 1, 0, formatLine(entry))
    await writeFile(path, `${lines.join('\n')}\n`)
  }
  private async rewrite(
    id: string,
    change: (entry: MemoryEntry) => MemoryEntry | null,
  ): Promise<MemoryEntry> {
    const found = await this.locate(id)
    if (!found) throw new Error(`没有找到记忆 ${id}`)
    const next = change(found.entry)
    if (next) found.lines[found.line] = formatLine(next)
    else found.lines.splice(found.line, 1)
    await writeFile(found.path, found.lines.join('\n'))
    return found.entry
  }

  /** Adds a confirmed memory; with `replaces`, marks that one superseded instead of deleting it. */
  add(input: {
    category: KeptCategory
    topic?: string
    text: string
    replaces?: string
    source?: MemoryMeta['source']
  }): Promise<MemoryEntry> {
    return this.serial(() => this.addNow(input))
  }
  private async addNow(input: {
    category: KeptCategory
    topic?: string
    text: string
    replaces?: string
    source?: MemoryMeta['source']
  }): Promise<MemoryEntry> {
    const entry: MemoryEntry = {
      id: newMemoryId(),
      at: today(),
      source: input.source ?? 'user',
      status: 'confirmed',
      text: checked(input.text),
      category: input.category,
      ...(input.category === 'topic'
        ? { key: topicFileName(input.topic ?? '') }
        : {}),
    }
    if (input.replaces) {
      const old = (await this.locate(input.replaces))?.entry
      if (!old || old.status !== 'confirmed')
        throw new Error(`没有找到可替换的记忆 ${input.replaces}`)
      await this.rewrite(input.replaces, (e) => ({
        ...e,
        status: 'superseded',
        by: entry.id,
      }))
    }
    await this.append(entry)
    return entry
  }

  /**
   * Records an inference from a conversation. `sameAs` names an existing pending item that says
   * the same thing; once `promoteAfter` conversations have seen it, it is kept without asking.
   */
  infer(input: {
    target: KeptCategory
    topic?: string
    text: string
    confidence: number
    evidence: string
    conversation: string
    sameAs?: string
  }): Promise<{ entry: MemoryEntry; promoted: boolean }> {
    return this.serial(async () => {
      const text = checked(input.text)
      const evidence = cleanText(input.evidence).slice(0, 120)
      if (sensitiveReason(evidence)) throw new Error('依据包含敏感信息')
      const existing = input.sameAs
        ? (await this.locate(input.sameAs))?.entry
        : undefined
      if (existing?.status === 'pending') {
        const seen = [
          ...new Set([...(existing.seen ?? []), input.conversation]),
        ]
        if (seen.length >= promoteAfter) {
          await this.rewrite(existing.id, () => null)
          return { entry: await this.keep(existing), promoted: true }
        }
        const updated = await this.rewrite(existing.id, (e) => ({
          ...e,
          seen,
          confidence: Math.max(e.confidence ?? 0, input.confidence),
          evidence: evidence || e.evidence,
        }))
        return { entry: { ...updated, seen }, promoted: false }
      }
      const entry: MemoryEntry = {
        id: newMemoryId(),
        at: today(),
        source: 'reflection',
        status: 'pending',
        text,
        category: 'pending',
        target: input.target,
        ...(input.target === 'topic'
          ? { targetTopic: topicFileName(input.topic ?? '') }
          : {}),
        confidence: Math.min(1, Math.max(0, input.confidence)),
        evidence,
        seen: [input.conversation],
      }
      await this.append(entry)
      return { entry, promoted: false }
    })
  }
  private keep(
    pending: MemoryEntry,
    text = pending.text,
  ): Promise<MemoryEntry> {
    return this.addNow({
      category: pending.target ?? 'profile',
      ...(pending.targetTopic ? { topic: pending.targetTopic } : {}),
      text,
      source: pending.source,
    })
  }

  /** The user agrees with a pending inference (optionally reworded): it becomes a kept memory. */
  confirm(id: string, text?: string): Promise<MemoryEntry> {
    return this.serial(async () => {
      const found = (await this.locate(id))?.entry
      if (found?.status !== 'pending')
        throw new Error(`没有找到待确认的记忆 ${id}`)
      const kept = await this.keep(found, text ?? found.text)
      await this.rewrite(id, () => null)
      return kept
    })
  }

  /** A corrected kept memory: the new text replaces it, the old line stays struck through. */
  correct(id: string, text: string): Promise<MemoryEntry> {
    return this.serial(async () => {
      const old = (await this.locate(id))?.entry
      if (
        !old ||
        old.status !== 'confirmed' ||
        old.category === 'pending' ||
        old.category === 'timeline'
      )
        throw new Error(`没有找到可修改的记忆 ${id}`)
      return this.addNow({
        category: old.category,
        ...(old.key ? { topic: old.key } : {}),
        text,
        replaces: id,
      })
    })
  }

  /** Deletes a memory for good (the git snapshot still has it). */
  remove(id: string): Promise<MemoryEntry> {
    return this.serial(async () => {
      const entry = await this.rewrite(id, () => null)
      if (entry.status === 'confirmed' && entry.category !== 'timeline')
        this.forgotten.push({ text: entry.text, at: Date.now() })
      return entry
    })
  }

  appendTimeline(
    day: string,
    text: string,
    activity?: ActivityMeta,
    conversation?: string,
    conversations?: string[],
  ): Promise<MemoryEntry> {
    return this.serial(async () => {
      const entry: MemoryEntry = {
        id: newMemoryId(),
        at: today(),
        source: 'reflection',
        status: 'confirmed',
        text: checked(text),
        category: 'timeline',
        key: day,
        ...(activity
          ? { activity: { ...activity, title: checked(activity.title) } }
          : {}),
        ...(conversation ? { conversation } : {}),
        ...(conversations?.length ? { conversations } : {}),
      }
      await this.append(entry)
      return entry
    })
  }

  /** Deletes Computer History entries that reach past `from`; returns when each removed one started. */
  removeActivity(from: number): Promise<number[]> {
    return this.serial(async () => {
      const removed: number[] = []
      for (const key of await this.periods()) {
        const path = this.file('timeline', key)
        const lines = await this.lines(path)
        if (!lines) continue
        const hit = parseLines(lines).filter(
          (i) => i.entry.activity && i.entry.activity.end > from,
        )
        if (!hit.length) continue
        const drop = new Set(hit.map((i) => i.line))
        removed.push(...hit.map((i) => i.entry.activity!.start))
        await writeFile(path, lines.filter((_, i) => !drop.has(i)).join('\n'))
      }
      return removed
    })
  }

  /** Replaces finer timeline files with one coarser summary (the old files stay in git history). */
  rollUp(
    into: string,
    from: string[],
    lines: string[],
    conversations: string[] = [],
  ): Promise<void> {
    return this.serial(async () => {
      // Check everything before removing anything; `from` may include `into` itself.
      const texts = lines.map(checked)
      if (
        !from.includes(into) &&
        (await this.lines(this.file('timeline', into)))
      )
        throw new Error(`时间线 ${into} 已存在`)
      for (const key of from)
        await rm(this.file('timeline', key), { force: true })
      for (const text of texts)
        await this.append({
          id: newMemoryId(),
          at: today(),
          source: 'reflection',
          status: 'confirmed',
          text,
          category: 'timeline',
          key: into,
          ...(conversations.length ? { conversations } : {}),
        })
    })
  }

  async get(id: string): Promise<MemoryEntry | undefined> {
    return (await this.locate(id))?.entry
  }
  private async locate(id: string) {
    for (const { category, key, path } of await this.files()) {
      const lines = await this.lines(path)
      if (!lines) continue
      const item = parseLines(lines).find((i) => i.entry.id === id)
      if (item)
        return {
          path,
          lines,
          line: item.line,
          entry: {
            ...item.entry,
            category,
            ...(key ? { key } : {}),
          } as MemoryEntry,
        }
    }
    return null
  }
}

/**
 * What goes into the system prompt every turn: confirmed profile and habits, plus topic names.
 * Lessons have a budget of their own (newest first; 0 leaves them out), since they are read
 * before acting and must not crowd out the profile.
 */
export async function memoryContext(
  store: MemoryStore,
  limit = 3000,
  lessonLimit = 800,
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
  if (lessonLimit > 0) {
    const lessons: string[] = []
    let lessonUsed = 0
    for (const e of entries
      .filter((e) => e.category === 'lessons')
      .sort((a, b) => b.at.localeCompare(a.at))) {
      const line = `- [${e.id}] ${e.text}`
      if (lessonUsed + line.length > lessonLimit) {
        dropped++
        continue
      }
      lessonUsed += line.length
      lessons.push(line)
    }
    if (lessons.length)
      sections.push(`${titles.lessons}：\n${lessons.join('\n')}`)
  }
  if (topics.length) sections.push(`已有主题：${topics.join('、')}`)
  if (dropped) sections.push(`（还有 ${dropped} 条未列出）`)
  return sections.join('\n')
}

/**
 * Timeline lines that restate a memory, so deleting the memory can offer to delete them too:
 * at least 60% of the memory's two-character pieces (ignoring 用户 and filler) appear in the line.
 */
export function mentions(
  entries: MemoryEntry[],
  removed: Pick<MemoryEntry, 'id' | 'text'>,
): MemoryEntry[] {
  return entries.filter(
    (e) =>
      e.id !== removed.id &&
      e.category === 'timeline' &&
      e.status === 'confirmed' &&
      restates(e.text, removed.text),
  )
}

/** Whether `text` repeats `memory`: at least half of its two-character pieces appear in it. */
export function restates(text: string, memory: string): boolean {
  const pieces = (value: string) => {
    const chars = [...value.toLowerCase().replace(/用户|[\s\p{P}\p{S}]/gu, '')]
    const set = new Set<string>()
    for (let i = 0; i + 2 <= chars.length; i++)
      set.add(chars.slice(i, i + 2).join(''))
    return set
  }
  const wanted = pieces(memory)
  if (wanted.size < 2) return false
  const have = pieces(text)
  let hit = 0
  for (const p of wanted) if (have.has(p)) hit++
  return hit / wanted.size >= 0.5
}
