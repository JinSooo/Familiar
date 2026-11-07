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

export function credentialRoots(): string[] {
  return ['Library/Keychains', '.ssh', '.gnupg'].map((p) =>
    normalizePath(join(homedir(), p)),
  )
}

export async function forbiddenRoots(): Promise<string[]> {
  const roots = [
    // The old data folder (before 2026-10-28) and the current one.
    'Library/Application Support/Familiar',
    '.familiar',
  ].map((p) => normalizePath(join(homedir(), p)))
  roots.push(normalizePath(dataDir))
  return [...credentialRoots(), ...roots]
}

/** Only the managed workspace may be writable inside Familiar's private data. */
export function familiarWorkspaceDir(): string {
  return normalizePath(join(dataDir, 'workspace'))
}

/**
 * Protected places a command names, best effort: paths written from ~, $HOME or the home folder
 * that fall in a forbidden root (or are a browser's password file), leaving out the workspace and
 * the folders the model may read. A command that reaches them some other way is not caught.
 */
export async function protectedPathsIn(
  command: string,
  allowed: string[],
): Promise<string[]> {
  const home = homedir()
  const escaped = home.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const token = new RegExp(
    `(?:~|\\$\\{?HOME\\}?|${escaped})(/[^\\s'"\`;|&<>()]*)?`,
    'g',
  )
  const roots = await forbiddenRoots()
  const found = new Set<string>()
  for (const match of command.matchAll(token)) {
    let path: string
    try {
      path = normalizePath(join(home, match[1] ?? ''))
    } catch {
      continue
    }
    if (
      !credentialRoots().some((root) => within(path, root)) &&
      !browserSecret(path) &&
      allowed.some((dir) => within(path, dir)) &&
      (!roots.some((root) => within(path, root)) ||
        within(path, familiarWorkspaceDir()) ||
        readableFamiliarDirs().some((dir) => within(path, dir)))
    )
      continue
    if (roots.some((root) => within(path, root)) || browserSecret(path))
      found.add(path)
  }
  return [...found]
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
