import { Database } from 'bun:sqlite'
import { stat } from 'node:fs/promises'
import type { KnowledgeFolder } from '../../../src/shared'
import {
  closest,
  dot,
  hashText,
  VectorCache,
  type Embedder,
} from '../embedding'
import { terms } from '../memory/search'
import { sensitiveReason } from '../memory/sensitive'
import {
  chunk,
  extract,
  searchText,
  titleOf,
  walk,
  type FileKind,
} from './files'

export interface KnowledgeHit {
  path: string
  title: string
  heading: string
  kind: FileKind
  start: number
  end: number
  text: string
  score: number
}

/**
 * Index of the knowledge folders, in the same SQLite file as the memory index (separate
 * tables). Unlike memory it is updated file by file: a vault can hold thousands of files and
 * re-embedding them all on every change would be slow and cost money. Everything here can be
 * rebuilt from the folders; the vectors are cached by text hash, so a rebuild only pays for
 * text it has not seen.
 */
export class KnowledgeIndex {
  private db: Database
  private vectors: VectorCache
  constructor(dbPath: string) {
    this.db = new Database(dbPath, { create: true })
    this.db.run('PRAGMA journal_mode = WAL')
    this.db.run(
      'CREATE TABLE IF NOT EXISTS kfiles (path TEXT PRIMARY KEY, root TEXT NOT NULL, kind TEXT NOT NULL, size INTEGER NOT NULL, mtime REAL NOT NULL, title TEXT NOT NULL, error TEXT)',
    )
    this.db.run(
      'CREATE TABLE IF NOT EXISTS kchunks (id INTEGER PRIMARY KEY, path TEXT NOT NULL, heading TEXT NOT NULL, start INTEGER NOT NULL, end INTEGER NOT NULL, text TEXT NOT NULL, hash TEXT NOT NULL, local INTEGER NOT NULL DEFAULT 0)',
    )
    this.db.run('CREATE INDEX IF NOT EXISTS kchunks_path ON kchunks (path)')
    this.db.run(
      "CREATE VIRTUAL TABLE IF NOT EXISTS kchunks_fts USING fts5(text, tokenize='trigram')",
    )
    this.db.run(
      'CREATE TABLE IF NOT EXISTS kroots (root TEXT PRIMARY KEY, truncated INTEGER NOT NULL)',
    )
    this.vectors = new VectorCache(this.db, 'knowledge_vectors')
  }

  /**
   * Brings the index in line with the folders: new and changed files are read again, files
   * that are gone (or whose folder was removed) are dropped. Returns whether anything changed.
   */
  async sync(roots: string[], signal?: AbortSignal): Promise<boolean> {
    let changed = false
    const known = new Map(
      this.db
        .query<{ path: string; root: string; size: number; mtime: number }, []>(
          'SELECT path, root, size, mtime FROM kfiles',
        )
        .all()
        .map((r) => [r.path, r]),
    )
    const seen = new Set<string>()
    for (const root of roots) {
      signal?.throwIfAborted()
      const { files, truncated } = await walk(root)
      this.db
        .query('INSERT OR REPLACE INTO kroots (root, truncated) VALUES (?, ?)')
        .run(root, truncated ? 1 : 0)
      for (const file of files) {
        // A file under two added folders belongs to the first.
        if (seen.has(file.path)) continue
        seen.add(file.path)
        const old = known.get(file.path)
        if (
          old &&
          old.root === root &&
          old.size === file.size &&
          old.mtime === file.mtime
        )
          continue
        signal?.throwIfAborted()
        let pages: string[] = []
        let error: string | null = null
        try {
          pages = await extract(file.path, file.kind)
        } catch (e) {
          error = e instanceof Error ? e.message : String(e)
        }
        const chunks = error ? [] : chunk(pages, file.kind)
        if (!error && !chunks.length && file.kind === 'pdf')
          error = '没有可读的文字（可能是扫描件）'
        this.replace(
          file.path,
          {
            root,
            kind: file.kind,
            size: file.size,
            mtime: file.mtime,
            title: titleOf(file.path, pages),
            error,
          },
          chunks.map((c) => {
            const text = searchText(file.path, c)
            return {
              ...c,
              search: text,
              hash: hashText(text),
              // Never sent to the embedding service; still found by full-text search.
              local: sensitiveReason(c.text) ? 1 : 0,
            }
          }),
        )
        changed = true
      }
    }
    for (const path of known.keys())
      if (!seen.has(path)) {
        this.replace(path, null, [])
        changed = true
      }
    const keepRoots = new Set(roots)
    for (const { root } of this.db
      .query<{ root: string }, []>('SELECT root FROM kroots')
      .all())
      if (!keepRoots.has(root))
        this.db.query('DELETE FROM kroots WHERE root = ?').run(root)
    if (changed) {
      const live = new Set(
        this.db
          .query<{ hash: string }, []>('SELECT hash FROM kchunks')
          .all()
          .map((r) => r.hash),
      )
      this.vectors.prune((hash) => live.has(hash))
    }
    return changed
  }

  private replace(
    path: string,
    file: {
      root: string
      kind: FileKind
      size: number
      mtime: number
      title: string
      error: string | null
    } | null,
    chunks: {
      heading: string
      start: number
      end: number
      text: string
      search: string
      hash: string
      local: number
    }[],
  ) {
    const ids = this.db
      .query<{ id: number }, [string]>('SELECT id FROM kchunks WHERE path = ?')
      .all(path)
    const dropFts = this.db.prepare('DELETE FROM kchunks_fts WHERE rowid = ?')
    const addChunk = this.db.prepare(
      'INSERT INTO kchunks (path, heading, start, end, text, hash, local) VALUES (?, ?, ?, ?, ?, ?, ?)',
    )
    const addFts = this.db.prepare(
      'INSERT INTO kchunks_fts (rowid, text) VALUES (?, ?)',
    )
    this.db.transaction(() => {
      for (const { id } of ids) dropFts.run(id)
      this.db.query('DELETE FROM kchunks WHERE path = ?').run(path)
      if (!file) {
        this.db.query('DELETE FROM kfiles WHERE path = ?').run(path)
        return
      }
      this.db
        .query(
          'INSERT OR REPLACE INTO kfiles (path, root, kind, size, mtime, title, error) VALUES (?, ?, ?, ?, ?, ?, ?)',
        )
        .run(
          path,
          file.root,
          file.kind,
          file.size,
          file.mtime,
          file.title,
          file.error,
        )
      for (const c of chunks) {
        const { lastInsertRowid } = addChunk.run(
          path,
          c.heading,
          c.start,
          c.end,
          c.text,
          c.hash,
          c.local,
        )
        addFts.run(lastInsertRowid, c.search)
      }
    })()
  }

  /** Makes the next sync read every file again. */
  invalidate(): void {
    this.db.run('UPDATE kfiles SET mtime = -1')
  }

  /** Embeds chunks that have no vector for this model yet; returns how many it added. */
  async embed(embedder: Embedder, signal?: AbortSignal): Promise<number> {
    const rows = this.db
      .query<{ hash: string; path: string; heading: string; text: string }, []>(
        'SELECT hash, path, heading, text FROM kchunks WHERE local = 0',
      )
      .all()
    const missing = rows
      .filter((r) => !this.vectors.has(embedder.key, r.hash))
      .map((r) => ({
        hash: r.hash,
        text: searchText(r.path, {
          heading: r.heading,
          text: r.text,
          start: 0,
          end: 0,
        }),
      }))
    return this.vectors.fill(embedder, missing, { signal })
  }

  /** Chunks that best match the query: full-text and vector matches merged by rank. */
  async search(
    query: string,
    options: { limit?: number; embedder?: Embedder; signal?: AbortSignal } = {},
  ): Promise<KnowledgeHit[]> {
    const limit = options.limit ?? 6
    const ranked: number[][] = []
    const text = this.fullText(query)
    if (text.length) ranked.push(text)
    if (options.embedder) {
      try {
        // 20 s: a local model may have to start first.
        const q = await options.embedder.query(
          query,
          options.signal ?? AbortSignal.timeout(20_000),
        )
        {
          const key = options.embedder.key
          const scored = this.db
            .query<{ id: number; hash: string }, []>(
              'SELECT id, hash FROM kchunks WHERE local = 0',
            )
            .all()
            .flatMap((r) => {
              const v = this.vectors.get(key, r.hash)
              return v ? [{ item: r.id, score: dot(q, v) }] : []
            })
          const near = closest(scored, 30).map((s) => s.item)
          if (near.length) ranked.push(near)
        }
      } catch (error) {
        // The embedding service being down must not break search; full text still works.
        console.error(
          'Knowledge vector search failed:',
          error instanceof Error ? error.message : error,
        )
      }
    }
    // Reciprocal rank fusion: a chunk high in either list, or present in both, comes first.
    const fused = new Map<number, number>()
    for (const list of ranked)
      list.forEach((id, rank) =>
        fused.set(id, (fused.get(id) ?? 0) + 1 / (60 + rank)),
      )
    const top = [...fused].sort((a, b) => b[1] - a[1]).slice(0, limit)
    if (!top.length) return []
    const get = this.db.query<
      {
        path: string
        title: string
        kind: FileKind
        heading: string
        start: number
        end: number
        text: string
      },
      [number]
    >(
      'SELECT c.path, f.title, f.kind, c.heading, c.start, c.end, c.text FROM kchunks c JOIN kfiles f ON f.path = c.path WHERE c.id = ?',
    )
    return top.flatMap(([id, score]) => {
      const row = get.get(id)
      return row ? [{ ...row, score }] : []
    })
  }

  /** Chunk ids by full-text score: trigrams through FTS5, two-character words through LIKE. */
  private fullText(query: string): number[] {
    const { grams, shorts } = terms(query)
    const scores = new Map<number, number>()
    const add = (id: number, value: number) =>
      scores.set(id, (scores.get(id) ?? 0) + value)
    if (grams.length) {
      const match = grams.map((g) => `"${g.replace(/"/g, '""')}"`).join(' OR ')
      for (const row of this.db
        .query<{ id: number; rank: number }, [string]>(
          'SELECT rowid AS id, bm25(kchunks_fts) AS rank FROM kchunks_fts WHERE kchunks_fts MATCH ? ORDER BY rank LIMIT 200',
        )
        .all(match))
        add(row.id, 2 + Math.min(3, -row.rank))
    }
    for (const short of shorts)
      for (const row of this.db
        .query<{ id: number }, [string]>(
          "SELECT rowid AS id FROM kchunks_fts WHERE text LIKE ? ESCAPE '\\' LIMIT 200",
        )
        .all(`%${short.replace(/[\\%_]/g, (c) => `\\${c}`)}%`))
        add(row.id, 1)
    return [...scores].sort((a, b) => b[1] - a[1]).map(([id]) => id)
  }

  /** Whether a path is a file the index knows (read_knowledge only reads those). */
  file(path: string): { kind: FileKind; title: string } | undefined {
    return (
      this.db
        .query<{ kind: FileKind; title: string }, [string]>(
          'SELECT kind, title FROM kfiles WHERE path = ?',
        )
        .get(path) ?? undefined
    )
  }

  async folders(
    roots: { path: string; builtIn: boolean }[],
    embedder: Embedder | undefined,
  ): Promise<KnowledgeFolder[]> {
    return Promise.all(
      roots.map(async ({ path, builtIn }) => {
        const files = this.db
          .query<{ path: string; error: string | null }, [string]>(
            'SELECT path, error FROM kfiles WHERE root = ?',
          )
          .all(path)
        const chunks = this.db
          .query<{ hash: string; local: number }, [string]>(
            'SELECT c.hash, c.local FROM kchunks c JOIN kfiles f ON f.path = c.path WHERE f.root = ?',
          )
          .all(path)
        const missing = await stat(path).then(
          (s) => !s.isDirectory(),
          () => true,
        )
        return {
          path,
          builtIn,
          missing,
          files: files.length,
          chunks: chunks.length,
          // Chunks kept local (sensitive text) count as done: they are never embedded.
          embedded: embedder
            ? chunks.filter(
                (c) => c.local || this.vectors.has(embedder.key, c.hash),
              ).length
            : 0,
          failed: files
            .filter((f) => f.error)
            .slice(0, 20)
            .map((f) => ({ path: f.path, error: f.error! })),
          truncated: Boolean(
            this.db
              .query<{ truncated: number }, [string]>(
                'SELECT truncated FROM kroots WHERE root = ?',
              )
              .get(path)?.truncated,
          ),
        }
      }),
    )
  }

  close(): void {
    this.db.close()
  }
}
