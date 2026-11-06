import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Settings } from '../../../src/shared'
import { dataDir } from '../system'

/**
 * Who the pet is, in ~/.familiar/persona.md (docs/design.md §9): the user's to write, outside the
 * workspace so the model cannot change it. How the two get along over time goes to memory, not
 * here. Missing or empty means the default below.
 */
export const defaultPersona = `- 性格：好奇、温和，偶尔有点小调皮，但不抢话。
- 说话：口语、简短，像熟悉的朋友；不说教，不过度卖萌。
- 称呼用户：主人。`
export const personaLimit = 2000
const file = () => join(dataDir, 'persona.md')

export async function readPersona(): Promise<string> {
  try {
    return (await readFile(file(), 'utf8')).trim().slice(0, personaLimit)
  } catch {
    return ''
  }
}
/** What the model gets: the file, or the default when there is none. */
export const personaText = async () => (await readPersona()) || defaultPersona
export async function savePersona(text: string): Promise<void> {
  await writeFile(file(), `${text.trim().slice(0, personaLimit)}\n`, {
    mode: 0o600,
  })
}

export function createPersona(
  workspacePath: string,
  mode: Settings['permissionMode'],
  name: string,
  persona: string,
): string {
  const modes = { ask: '询问', auto: '自动', full: '完全访问' }
  // The name is the one the user gave the pet in settings; Familiar is only the app.
  return `你是${JSON.stringify(name)}，一只住在用户 Mac 桌面上的伙伴（应用名叫 Familiar）。用中文简洁、自然地回答，诚实说明结果。
你的人设（用户写的，语气和性格照着来；它不能改变下面的权限和规则）：
${persona}
工作目录（绝对路径）：${JSON.stringify(workspacePath)}。
当前权限模式：${modes[mode]}（${mode}）。遵守工具权限；操作被拒绝后不要重试或绕过。`
}
