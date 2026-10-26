import { dirname } from 'node:path'
import type { Settings } from '../../../src/shared'
import { browserSecret, forbiddenRoots, normalizePath, within } from './paths'

export interface ToolCall {
  id: string
  toolName: string
  input: unknown
}
export type ToolDecision = {
  decision: 'allow' | 'ask' | 'deny'
  reason: string
  /** For an ask outside the workspace: the directory an "always allow" rule would cover. */
  dir?: string
}
const reads = new Set(['read_file', 'list_dir'])
const names = new Set([
  ...reads,
  'write_file',
  'edit_file',
  'delete_path',
  'make_dir',
  'run_shell',
])

export async function decideToolCall(
  call: ToolCall,
  settings: Settings,
): Promise<ToolDecision> {
  const result = (
    decision: ToolDecision['decision'],
    reason: string,
  ): ToolDecision => ({ decision, reason })
  try {
    if (!names.has(call.toolName)) return result('deny', '未知工具')
    const input = call.input as {
      path?: string
      cwd?: string
      network?: boolean
    } | null
    const workspace = normalizePath(settings.workspacePath)
    const shell = call.toolName === 'run_shell'
    const value = shell ? (input?.cwd ?? workspace) : input?.path
    if (typeof value !== 'string' || !value) return result('deny', '路径无效')
    const path = normalizePath(value, workspace)
    if (
      (await forbiddenRoots()).some(
        (root) =>
          within(path, root) ||
          (call.toolName === 'delete_path' && within(root, path)),
      ) ||
      browserSecret(path)
    )
      return result('deny', '路径属于硬性禁区')
    const rules = settings.dirRules
      .map((rule) => ({ ...rule, path: normalizePath(rule.path, workspace) }))
      .filter((rule) => within(path, rule.path))
      .sort(
        (a, b) =>
          b.path.length - a.path.length || (a.access === 'deny' ? -1 : 1),
      )
    if (
      call.toolName === 'delete_path' &&
      settings.dirRules.some(
        (rule) =>
          rule.access === 'deny' &&
          within(normalizePath(rule.path, workspace), path),
      )
    )
      return result('deny', '目录包含禁止访问的子目录')
    const rule = rules[0]
    if (rule?.access === 'deny') return result('deny', '目录规则禁止访问')
    if (settings.permissionMode === 'full')
      return result('allow', '完全访问模式')
    if (shell && input?.network) return result('ask', '执行命令需要联网授权')
    if (within(path, workspace)) {
      return settings.permissionMode === 'auto' || reads.has(call.toolName)
        ? result('allow', '工作目录内允许此操作')
        : result('ask', '写入或执行命令需要授权')
    }
    if (shell && settings.permissionMode === 'auto' && !rule)
      return result('allow', '命令由工作目录写入沙箱约束')
    if (rule) return result(rule.access, '按目录规则处理')
    return {
      decision: 'ask',
      reason: '工作目录外的访问需要授权',
      dir: shell || call.toolName === 'list_dir' ? path : dirname(path),
    }
  } catch {
    return result('deny', '无法安全解析路径')
  }
}
