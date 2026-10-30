import {
  mkdir,
  readdir,
  readFile,
  rm,
  writeFile,
  appendFile,
} from 'node:fs/promises'
import { join } from 'node:path'
import type { PerceptionEvent } from '../../../src/shared'

/** Raw events live this long; summaries are what stays (docs/design.md §7). */
export const keepHours = 48
const hour = 3600000

/**
 * The raw-event buffer: one file per local hour (`2026-10-29-14.enc`), one AES-256-GCM
 * ciphertext per line (base64 of iv + ciphertext). The key comes from the Keychain; losing it
 * (a full clear rotates it) makes old lines unreadable, which is the point.
 */
export class PerceptionBuffer {
  private key?: Promise<CryptoKey>
  private queue: Promise<unknown> = Promise.resolve()
  constructor(
    readonly dir: string,
    /** Returns the stored base64 key, or '' when there is none yet. */
    private readonly loadKey: () => Promise<string>,
    private readonly storeKey: (key: string) => Promise<void>,
  ) {}

  private cryptoKey(): Promise<CryptoKey> {
    this.key ??= (async () => {
      let raw = await this.loadKey()
      if (!raw) {
        raw = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString(
          'base64',
        )
        await this.storeKey(raw)
      }
      return crypto.subtle.importKey(
        'raw',
        Buffer.from(raw, 'base64'),
        'AES-GCM',
        false,
        ['encrypt', 'decrypt'],
      )
    })().catch((error: unknown) => {
      this.key = undefined
      throw error
    })
    return this.key
  }

  private serial<T>(work: () => Promise<T>): Promise<T> {
    const result = this.queue.then(work)
    this.queue = result.catch(() => undefined)
    return result
  }

  private async seal(event: PerceptionEvent): Promise<string> {
    const iv = crypto.getRandomValues(new Uint8Array(12))
    const data = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv },
      await this.cryptoKey(),
      new TextEncoder().encode(JSON.stringify(event)),
    )
    return Buffer.concat([iv, new Uint8Array(data)]).toString('base64')
  }
  private async open(line: string): Promise<PerceptionEvent | null> {
    try {
      const bytes = Buffer.from(line, 'base64')
      const data = await crypto.subtle.decrypt(
        { name: 'AES-GCM', iv: bytes.subarray(0, 12) },
        await this.cryptoKey(),
        bytes.subarray(12),
      )
      return JSON.parse(new TextDecoder().decode(data)) as PerceptionEvent
    } catch {
      // Written under a key that has since been rotated, or damaged.
      return null
    }
  }

  private async files(): Promise<{ name: string; start: number }[]> {
    let names: string[] = []
    try {
      names = await readdir(this.dir)
    } catch {
      return []
    }
    return names
      .map((name) => ({ name, start: hourStart(name) }))
      .filter((f): f is { name: string; start: number } => f.start !== null)
      .sort((a, b) => a.start - b.start)
  }

  append(event: PerceptionEvent): Promise<void> {
    return this.serial(async () => {
      await mkdir(this.dir, { recursive: true, mode: 0o700 })
      await appendFile(
        join(this.dir, fileName(event.at)),
        (await this.seal(event)) + '\n',
        { mode: 0o600 },
      )
    })
  }

  /** Events with `from <= at < to`, oldest first. */
  read(from: number, to = Date.now()): Promise<PerceptionEvent[]> {
    return this.serial(async () => {
      const events: PerceptionEvent[] = []
      for (const f of await this.files()) {
        if (f.start + hour <= from || f.start >= to) continue
        for (const line of await lines(join(this.dir, f.name))) {
          const event = await this.open(line)
          if (event && event.at >= from && event.at < to) events.push(event)
        }
      }
      return events.sort((a, b) => a.at - b.at)
    })
  }

  /** Deletes hour files older than `keepHours`. */
  prune(now = Date.now()): Promise<number> {
    return this.serial(async () => {
      let removed = 0
      for (const f of await this.files())
        if (f.start + hour <= now - keepHours * hour) {
          await rm(join(this.dir, f.name), { force: true })
          removed++
        }
      return removed
    })
  }

  /** Deletes events from the last `minutes`; 'all' also rotates the key. */
  clear(minutes: number | 'all', now = Date.now()): Promise<void> {
    return this.serial(async () => {
      if (minutes === 'all') {
        await rm(this.dir, { recursive: true, force: true })
        this.key = undefined
        await this.storeKey('')
        return
      }
      const cutoff = now - minutes * 60000
      for (const f of await this.files()) {
        if (f.start + hour <= cutoff) continue
        const path = join(this.dir, f.name)
        if (f.start >= cutoff) {
          await rm(path, { force: true })
          continue
        }
        const kept: string[] = []
        for (const line of await lines(path)) {
          const event = await this.open(line)
          if (event && event.at < cutoff) kept.push(line)
        }
        await writeFile(path, kept.map((l) => l + '\n').join(''), {
          mode: 0o600,
        })
      }
    })
  }
}

async function lines(path: string): Promise<string[]> {
  try {
    return (await readFile(path, 'utf8')).split('\n').filter(Boolean)
  } catch {
    return []
  }
}
function fileName(at: number): string {
  const d = new Date(at)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}-${pad(d.getHours())}.enc`
}
function hourStart(name: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})-(\d{2})\.enc$/.exec(name)
  if (!m) return null
  return new Date(+m[1]!, +m[2]! - 1, +m[3]!, +m[4]!).getTime()
}
