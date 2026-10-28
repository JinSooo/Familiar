import {
  mkdir,
  readdir,
  rename,
  rmdir,
  stat,
  unlink,
  writeFile,
} from 'node:fs/promises'
import { join } from 'node:path'
import { normalizePath } from './permissions/paths'
import { gitignore } from './workspace'

const exists = (path: string) =>
  stat(path).then(
    () => true,
    () => false,
  )
const entries = (path: string) => readdir(path).catch(() => [] as string[])
const meaningful = (names: string[]) => names.filter((n) => n !== '.DS_Store')

/**
 * The move is done once only .DS_Store — and a .git, when ~/.familiar already has its own
 * history — is left. The folder is removed only when nothing but .DS_Store remains: a leftover
 * .git may hold history, so it is never deleted here.
 */
async function moved(legacy: string, root: string): Promise<boolean> {
  const left = meaningful(await entries(legacy))
  const rootHistory = await exists(join(root, '.git'))
  if (left.some((n) => n !== '.git' || !rootHistory)) return false
  if (!left.length) {
    await unlink(join(legacy, '.DS_Store')).catch(() => {})
    await rmdir(legacy).catch(() => {})
  }
  return true
}

/**
 * One-time move of the old ~/Familiar workspace into ~/.familiar (2026-10-28): memory,
 * conversations and knowledge go to the top, its git history comes along, everything else
 * becomes ~/.familiar/workspace. Returns the new workspace path, or undefined when there was
 * nothing to do. Refuses (and moves nothing) if a destination already holds files. Safe to run
 * again after an interrupted move: an emptied old folder just finishes the job.
 */
export async function migrateLegacyWorkspace(
  legacy: string,
  root: string,
  workspacePath: string,
): Promise<string | undefined> {
  if (!(await exists(legacy))) return
  if (normalizePath(workspacePath) !== normalizePath(legacy)) return
  const workspace = join(root, 'workspace')
  // Everything already moved (an earlier run stopped before updating the setting).
  if (await moved(legacy, root)) {
    await mkdir(workspace, { recursive: true })
    return workspace
  }
  const folders = ['memory', 'conversations', 'knowledge']
  for (const name of [...folders, 'workspace'])
    if (meaningful(await entries(join(root, name))).length)
      throw new Error(`~/.familiar/${name} 已经有内容，没有迁移 ~/Familiar`)
  await mkdir(workspace, { recursive: true })
  const history =
    (await exists(join(legacy, '.git'))) && !(await exists(join(root, '.git')))
  if (history) {
    await rename(join(legacy, '.git'), join(root, '.git'))
    // Before any commit can happen: only the data folders are tracked, never the config.
    await writeFile(join(root, '.gitignore'), gitignore)
  }
  for (const name of folders) {
    const from = join(legacy, name)
    if (!(await exists(from))) continue
    await rmdir(join(root, name)).catch(() => {}) // an empty placeholder, if any
    await rename(from, join(root, name))
  }
  for (const name of meaningful(await entries(legacy))) {
    if (name === '.git') continue
    const to = join(workspace, name)
    if (await exists(to)) continue
    await rename(join(legacy, name), to)
  }
  await moved(legacy, root)
  return workspace
}
