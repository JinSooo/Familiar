import { dataDir } from '../system'
import { realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, resolve, join, basename, sep } from 'node:path'

export function normalizePath(path: string, base = homedir()): string {
  const expanded =
    path === '~'
      ? homedir()
      : path.startsWith('~/')
        ? join(homedir(), path.slice(2))
        : path
  const absolute = resolve(base, expanded)
  try {
    return realpathSync(absolute)
  } catch (error) {
    if (
      !['ENOENT', 'ENOTDIR'].includes(
        (error as NodeJS.ErrnoException).code ?? '',
      )
    )
      throw error
    const parent = dirname(absolute)
    if (parent === absolute) throw error
    return join(normalizePath(parent), basename(absolute))
  }
}

export function within(path: string, root: string): boolean {
  return path === root || path.startsWith(root + sep)
}

export async function forbiddenRoots(): Promise<string[]> {
  const roots = [
    'Library/Keychains',
    '.ssh',
    '.gnupg',
    // The old data folder (before 2026-10-28) and the current one.
    'Library/Application Support/Familiar',
    '.familiar',
  ].map((p) => normalizePath(join(homedir(), p)))
  roots.push(normalizePath(dataDir))
  return roots
}

export function browserSecret(path: string): boolean {
  return /\/(?:Login Data(?:-journal|-wal|-shm)?|logins\.json|key4\.db(?:-wal|-shm)?)$/i.test(
    path,
  )
}

/** Folders under ~/.familiar the model may read (writes go through Familiar's own tools). */
export function readableFamiliarDirs(): string[] {
  return ['memory', 'conversations', 'knowledge', 'skills'].map((d) =>
    normalizePath(join(dataDir, d)),
  )
}
