import { createHash } from 'node:crypto'
import type { Database } from 'bun:sqlite'
import { createOpenAI } from '@ai-sdk/openai'
import { embedMany } from 'ai'
import type { Settings } from '../../src/shared'
import { systemFetch } from './agent/fetch'
import { embedLocally, localModel, localModelReady } from './local-embedding'

/**
 * Embeddings for vector search (docs/design.md §11), on their own model and key like image
 * generation: the ChatGPT plan route cannot embed. Vectors are cached in SQLite by model and
 * text hash, so rebuilding an index or re-reading an unchanged file never pays twice.
 */
export interface Embedder {
  /** Which model made a vector; vectors of different models never mix. */
  key: string
  /** Documents (chunks, memories). */
  embed(texts: string[], signal?: AbortSignal): Promise<Float32Array[]>
  /** A search query; some models embed queries with an instruction in front. */
  query(text: string, signal?: AbortSignal): Promise<Float32Array>
}

/**
 * The embedder the settings choose. `localReady` says whether the local model file is in
 * place; without it local means full-text only, like an online model with no key.
 */
export function embedderFor(
  settings: Settings,
  localReady = true,
): Embedder | undefined {
  if (settings.embeddingModel.source === 'local')
    return localReady ? localEmbedder : undefined
  return remoteEmbedder(settings)
}

/** The embedder in use now: as configured, with the local model counted only once downloaded. */
export async function activeEmbedder(
  settings: Settings,
): Promise<Embedder | undefined> {
  return embedderFor(
    settings,
    settings.embeddingModel.source === 'local' && (await localModelReady()),
  )
}

const localEmbedder: Embedder = {
  key: `local|${localModel.id}`,
  async embed(texts, signal) {
    return (await embedLocally(texts, 'document', signal)).map(normalize)
  },
  async query(text, signal) {
    const [v] = await embedLocally([text], 'query', signal)
    return normalize(v ?? [])
  },
}

function remoteEmbedder(settings: Settings): Embedder | undefined {
  const config = settings.embeddingModel
  const model = config.model.trim()
  if (!model || !config.apiKey.trim()) return undefined
  const baseURL = config.baseURL.trim() || 'https://api.openai.com/v1'
  const provider = createOpenAI({
    baseURL,
    apiKey: config.apiKey.trim(),
    fetch: systemFetch,
  })
  const embed = async (texts: string[], signal?: AbortSignal) => {
    const { embeddings } = await embedMany({
      model: provider.embedding(model),
      values: texts,
      maxRetries: 1,
      abortSignal: signal ?? AbortSignal.timeout(60_000),
    })
    return embeddings.map(normalize)
  }
  return {
    key: `${baseURL}|${model}`,
    embed,
    query: async (text, signal) => (await embed([text], signal))[0]!,
  }
}

export const hashText = (text: string) =>
  createHash('sha1').update(text).digest('hex')

/** Unit length, so cosine similarity is a dot product. */
export function normalize(vector: ArrayLike<number>): Float32Array {
  const out = Float32Array.from(vector)
  let sum = 0
  for (const v of out) sum += v * v
  const length = Math.sqrt(sum) || 1
  for (let i = 0; i < out.length; i++) out[i]! /= length
  return out
}

export function dot(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) return 0
  let sum = 0
  for (let i = 0; i < a.length; i++) sum += a[i]! * b[i]!
  return sum
}

/**
 * Which of the scored items count as matches. Similarity levels differ between models, so this
 * keeps what is close to the best match (within 0.15) above a low floor, at most `limit`.
 */
export function closest<T>(
  scored: { item: T; score: number }[],
  limit: number,
): { item: T; score: number }[] {
  const sorted = scored.sort((a, b) => b.score - a.score)
  const top = sorted[0]?.score ?? 0
  const floor = Math.max(0.2, top - 0.15)
  return sorted.filter((s) => s.score >= floor).slice(0, limit)
}

/** Vectors on disk, keyed by model and text hash, with the ones already read kept in memory. */
export class VectorCache {
  private loaded = new Map<string, Map<string, Float32Array>>()
  /** Each index has its own table, so pruning one never drops another's vectors. */
  constructor(
    private db: Database,
    private table: string,
  ) {
    db.run(
      `CREATE TABLE IF NOT EXISTS ${table} (model TEXT NOT NULL, hash TEXT NOT NULL, vector BLOB NOT NULL, PRIMARY KEY (model, hash))`,
    )
  }

  private forModel(key: string): Map<string, Float32Array> {
    let map = this.loaded.get(key)
    if (!map) {
      map = new Map()
      for (const row of this.db
        .query<{ hash: string; vector: Uint8Array }, [string]>(
          `SELECT hash, vector FROM ${this.table} WHERE model = ?`,
        )
        .all(key))
        map.set(row.hash, toVector(row.vector))
      this.loaded.set(key, map)
    }
    return map
  }

  get(key: string, hash: string): Float32Array | undefined {
    return this.forModel(key).get(hash)
  }

  has(key: string, hash: string): boolean {
    return this.forModel(key).has(hash)
  }

  /** Embeds the texts that have no vector yet, `batch` at a time; returns how many it added. */
  async fill(
    embedder: Embedder,
    items: { hash: string; text: string }[],
    options: { batch?: number; signal?: AbortSignal } = {},
  ): Promise<number> {
    const map = this.forModel(embedder.key)
    const missing = [
      ...new Map(
        items.filter((i) => !map.has(i.hash)).map((i) => [i.hash, i]),
      ).values(),
    ]
    const batch = options.batch ?? 32
    const insert = this.db.prepare(
      `INSERT OR REPLACE INTO ${this.table} (model, hash, vector) VALUES (?, ?, ?)`,
    )
    let added = 0
    for (let i = 0; i < missing.length; i += batch) {
      options.signal?.throwIfAborted()
      const part = missing.slice(i, i + batch)
      const vectors = await embedder.embed(
        part.map((p) => p.text),
        options.signal,
      )
      this.db.transaction(() => {
        part.forEach((p, j) => {
          const v = vectors[j]
          if (!v) return
          insert.run(
            embedder.key,
            p.hash,
            new Uint8Array(v.buffer, v.byteOffset, v.byteLength),
          )
          map.set(p.hash, v)
          added++
        })
      })()
    }
    return added
  }

  /** Drops vectors no item refers to any more, for every model. */
  prune(keep: (hash: string) => boolean): void {
    const rows = this.db
      .query<{ model: string; hash: string }, []>(
        `SELECT model, hash FROM ${this.table}`,
      )
      .all()
    const remove = this.db.prepare(
      `DELETE FROM ${this.table} WHERE model = ? AND hash = ?`,
    )
    this.db.transaction(() => {
      for (const row of rows)
        if (!keep(row.hash)) {
          remove.run(row.model, row.hash)
          this.loaded.get(row.model)?.delete(row.hash)
        }
    })()
  }
}

function toVector(bytes: Uint8Array): Float32Array {
  // Copy: the blob's buffer may not be 4-byte aligned.
  const copy = new Uint8Array(bytes)
  return new Float32Array(copy.buffer, 0, copy.byteLength / 4)
}
