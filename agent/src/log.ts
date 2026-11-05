import { createWriteStream, mkdirSync, renameSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { format } from 'node:util'
import { dataDir } from './system'

/**
 * console.error and console.warn also go to ~/.familiar/logs/agent.log (kept to about 2 MB,
 * the previous one as agent.log.1). Started from Finder, the shell's stderr reaches no one, so
 * without this a failed background call leaves no trace.
 */
const dir = join(dataDir, 'logs')
const file = join(dir, 'agent.log')
const maxBytes = 2 * 1024 * 1024

function open() {
  mkdirSync(dir, { recursive: true })
  try {
    if (statSync(file).size > maxBytes) renameSync(file, `${file}.1`)
  } catch {
    /* No log yet. */
  }
  return createWriteStream(file, { flags: 'a', mode: 0o600 })
}

export function startLog(): void {
  let stream = open()
  let written = 0
  for (const level of ['error', 'warn'] as const) {
    const original = console[level].bind(console)
    console[level] = (...args: unknown[]) => {
      original(...args)
      const line = `${new Date().toLocaleString('sv-SE')} ${level} ${format(...args)}\n`
      written += line.length
      if (written > maxBytes) {
        stream.end()
        stream = open()
        written = 0
      }
      stream.write(line)
    }
  }
}
