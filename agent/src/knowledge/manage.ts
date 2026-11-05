import { execFile } from 'node:child_process'
import { stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { resolve, sep } from 'node:path'
import { promisify } from 'node:util'
import type { KnowledgeStatus } from '../../../src/shared'
import { getSettings, publicSettings, saveSettings } from '../settings'
import { dataDir, reveal } from '../system'
import {
  knowledgeRoots,
  knowledgeStatus,
  openKnowledge,
  syncKnowledge,
} from '.'
export {
  knowledgeStatus,
  reindexKnowledge,
  startKnowledge,
  stopKnowledge,
  syncKnowledge,
} from '.'

/** The settings page's knowledge folder list: add with the system folder picker, remove. */
const exec = promisify(execFile)

const within = (path: string, dir: string) =>
  path === dir || path.startsWith(dir.endsWith(sep) ? dir : dir + sep)

/** Why a folder cannot be added, or null. */
export function refuseFolder(path: string, existing: string[]): string | null {
  if (within(path, dataDir)) return 'Familiar 自己的数据目录不能加入知识库'
  if (path === homedir() || path === '/')
    return '请选一个具体的文件夹，不要整个家目录'
  if (existing.includes(path)) return '这个文件夹已经在知识库里'
  return null
}

async function pickFolder(): Promise<string | undefined> {
  try {
    const { stdout } = await exec('/usr/bin/osascript', [
      '-e',
      // `activate` brings the picker in front of the settings window instead of behind it.
      'activate\nPOSIX path of (choose folder with prompt "选择要加入知识库的文件夹")',
    ])
    return stdout.trim().replace(/\/$/, '') || undefined
  } catch (error) {
    // -128: the user cancelled.
    if (String((error as { stderr?: string }).stderr).includes('-128'))
      return undefined
    throw new Error('无法打开文件夹选择窗口', { cause: error })
  }
}

async function saveFolders(folders: string[]) {
  await saveSettings({ ...publicSettings(), knowledge: { folders } })
}

export async function addKnowledgeFolder(): Promise<KnowledgeStatus> {
  const picked = await pickFolder()
  if (!picked) return knowledgeStatus()
  const path = resolve(picked)
  const roots = knowledgeRoots(getSettings()).map((r) => r.path)
  const refused = refuseFolder(path, roots)
  if (refused) throw new Error(refused)
  if (!(await stat(path)).isDirectory()) throw new Error('选中的不是文件夹')
  await saveFolders([...getSettings().knowledge.folders, path])
  void syncKnowledge()
  return knowledgeStatus()
}

export async function removeKnowledgeFolder(
  path: string,
): Promise<KnowledgeStatus> {
  const folders = getSettings().knowledge.folders.filter(
    (f) => resolve(f.replace(/^~(?=\/)/, homedir())) !== path,
  )
  await saveFolders(folders)
  // Drops the folder's files from the index (the folder itself is untouched).
  void syncKnowledge()
  return knowledgeStatus()
}

/** Opens a knowledge folder, or a file the index lists, in Finder / its default app. */
export async function revealKnowledge(path: string): Promise<void> {
  const roots = knowledgeRoots(getSettings()).map((r) => r.path)
  if (!roots.includes(path) && !openKnowledge().file(path))
    throw new Error('不在知识库里')
  await reveal(path)
}
