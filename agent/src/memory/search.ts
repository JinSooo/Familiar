import { Database } from 'bun:sqlite'
import { stat } from 'node:fs/promises'
import type { MemoryEntry, MemoryStore } from './store'

/**
 * Search index over the memory Markdown. It is only a cache: any change to the files (by
 * Familiar or by hand) changes the fingerprint and the whole index is rebuilt on the next
 * search, which is cheap at the size of one person's memory.
 *
 * FTS5's trigram tokenizer handles Chinese without a segmenter, but only for runs of three or
 * more characters; two-character words ("美式") are matched with LIKE instead.
 */
const stopwords = new Set(
  '什么 怎么 一般 一下 这个 那个 我的 你的 我们 他们 有没 没有 是不 不是 知道 记得 之前 以前 上次 关于 喜欢'.split(
    ' ',
  ),
)

export interface SearchHit extends MemoryEntry {
  score: number
}

export class MemoryIndex {
  private db: Database
  constructor(
    private store: MemoryStore,
    dbPath: string,
  ) {
    this.db = new Database(dbPath, { create: true })
    this.db.run('PRAGMA journal_mode = WAL')
    this.db.run(
      "CREATE VIRTUAL TABLE IF NOT EXISTS memory USING fts5(text, id UNINDEXED, entry UNINDEXED, tokenize='trigram')",
    )
    this.db.run(
      'CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)',
    )
  }

  private async fingerprint(): Promise<string> {
    const parts = [this.store.dir]
    for (const { path } of await this.store.files()) {
      try {
        const s = await stat(path)
        parts.push(`${path}:${s.size}:${s.mtimeMs}`)
      } catch {
        /* Not created yet. */
      }
    }
    return parts.join('\n')
  }

  /** Rebuilds when the files changed since the last build; returns whether it did. */
  async refresh(): Promise<boolean> {
    const print = await this.fingerprint()
    const row = this.db
      .query<{ value: string }, [string]>(
        'SELECT value FROM meta WHERE key = ?',
      )
      .get('fingerprint')
    if (row?.value === print) return false
    const entries = await this.store.list()
    const insert = this.db.prepare(
      'INSERT INTO memory (text, id, entry) VALUES (?, ?, ?)',
    )
    this.db.transaction(() => {
      this.db.run('DELETE FROM memory')
      for (const e of entries) {
        const where = e.key ? `${e.key} ` : ''
        insert.run(`${where}${e.text}`, e.id, JSON.stringify(e))
      }
      this.db
        .query('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)')
        .run('fingerprint', print)
    })()
    return true
  }

  /** Kept and pending memories that best match the query; superseded ones are history only. */
  async search(query: string, limit = 8): Promise<SearchHit[]> {
    await this.refresh()
    const { grams, shorts } = terms(query)
    const scores = new Map<string, number>()
    const add = (id: string, value: number) =>
      scores.set(id, (scores.get(id) ?? 0) + value)
    if (grams.length) {
      const match = grams.map((g) => `"${g.replace(/"/g, '""')}"`).join(' OR ')
      for (const row of this.db
        .query<{ id: string; rank: number }, [string]>(
          'SELECT id, bm25(memory) AS rank FROM memory WHERE memory MATCH ?',
        )
        .all(match))
        add(row.id, 2 + Math.min(3, -row.rank))
    }
    for (const short of shorts)
      for (const row of this.db
        .query<{ id: string }, [string]>(
          "SELECT id FROM memory WHERE text LIKE ? ESCAPE '\\'",
        )
        .all(`%${short.replace(/[\\%_]/g, (c) => `\\${c}`)}%`))
        add(row.id, 1)
    if (!scores.size) return []
    const entries = new Map(
      this.db
        .query<{ id: string; entry: string }, []>(
          'SELECT id, entry FROM memory',
        )
        .all()
        .map((r) => [r.id, JSON.parse(r.entry) as MemoryEntry]),
    )
    return [...scores]
      .map(([id, score]) => ({ ...entries.get(id)!, score }))
      .filter((e) => e.id && e.status !== 'superseded')
      .sort((a, b) => b.score - a.score || b.at.localeCompare(a.at))
      .slice(0, limit)
  }

  close(): void {
    this.db.close()
  }
}

/** Splits a query into FTS trigrams (CJK runs, ASCII words) and two-character LIKE terms. */
export function terms(query: string): { grams: string[]; shorts: string[] } {
  const grams = new Set<string>()
  const shorts = new Set<string>()
  for (const word of query
    .toLowerCase()
    .split(/[\s\p{P}\p{S}]+/u)
    .filter(Boolean)) {
    // Mixed words split into CJK and non-CJK runs: "用tauri做" → 用, tauri, 做.
    for (const run of word.match(/\p{Script=Han}+|[^\p{Script=Han}]+/gu) ??
      []) {
      const chars = [...run]
      if (chars.length === 1 && /\p{Script=Han}/u.test(run)) shorts.add(run)
      if (!/\p{Script=Han}/u.test(run)) {
        if (chars.length >= 3) grams.add(run)
        else if (chars.length === 2) shorts.add(run)
        continue
      }
      for (let i = 0; i + 3 <= chars.length; i++)
        grams.add(chars.slice(i, i + 3).join(''))
      for (let i = 0; i + 2 <= chars.length; i++) {
        const pair = chars.slice(i, i + 2).join('')
        if (!stopwords.has(pair)) shorts.add(pair)
      }
    }
  }
  return { grams: [...grams], shorts: [...shorts] }
}
