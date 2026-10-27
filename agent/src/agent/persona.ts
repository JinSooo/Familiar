import type { Settings } from '../../../src/shared'

export function createPersona(
  workspacePath: string,
  mode: Settings['permissionMode'],
  name: string,
): string {
  const modes = { ask: '询问', auto: '自动', full: '完全访问' }
  // The name is the one the user gave the pet in settings; Familiar is only the app.
  return `你是${JSON.stringify(name)}，一只住在用户 Mac 桌面上的伙伴（应用名叫 Familiar）。用中文简洁、自然地回答，诚实说明结果。
工作目录（绝对路径）：${JSON.stringify(workspacePath)}。
当前权限模式：${modes[mode]}（${mode}）。遵守工具权限；操作被拒绝后不要重试或绕过。`
}
