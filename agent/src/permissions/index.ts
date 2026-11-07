import { dirname } from 'node:path'
import { homedir } from 'node:os'
import type { Settings } from '../../../src/shared'
import {
  browserSecret,
  credentialRoots,
  familiarWorkspaceDir,
  forbiddenRoots,
  normalizePath,
  protectedPathsIn,
  readableFamiliarDirs,
  within,
} from './paths'
import { mcpAccess } from '../extensions/mcp'
import { sharedSkillsDir } from '../extensions/skills'
import { computerToolNames, describeComputerCall } from '../computer'

export interface ToolCall {
  id: string
  toolName: string
  input: unknown
}
export type ToolDecision = {
  decision: 'allow' | 'ask' | 'deny'
  reason: string
  /** Canonical target checked before approval; execution must use the same target. */
  resolvedPath?: string
  /** The directory a rule saved on approval would cover (outside the workspace, or a network ask). */
  dir?: string
  /** For an MCP tool: the server an "always allow" would trust. */
  server?: string
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

// Familiar's own memory files, in every mode; they never take a path from the model.
const memoryTools = new Set([
  'remember',
  'forget',
  'recall',
  // Reminders are Familiar's own file too.
  'remind',
  'add_todo',
  'list_reminders',
  'cancel_reminder',
  // The knowledge base is read only and holds what the user gave it; read_knowledge refuses
  // anything the index does not list.
  'search_knowledge',
  'read_knowledge',
])
// Read-only web access: allowed in auto and full mode, asked in ask mode (shell network still asks).
// save_page and generate_image write only to their managed knowledge/conversation folders.
const webTools = new Set([
  'web_search',
  'fetch_page',
  'save_page',
  'generate_image',
])

export async function decideToolCall(
  call: ToolCall,
  settings: Settings,
): Promise<ToolDecision> {
  let resolvedPath: string | undefined
  const result = (
    decision: ToolDecision['decision'],
    reason: string,
  ): ToolDecision => ({
    decision,
    reason,
    ...(resolvedPath ? { resolvedPath } : {}),
  })
  try {
    if (memoryTools.has(call.toolName))
      return result('allow', '记忆由 Familiar 自己维护')
    if (call.toolName === 'use_skill') return result('allow', '读取技能说明')
    const mcp = mcpAccess(call.toolName)
    if (mcp) {
      if (mcp.access === 'off') return result('deny', 'MCP 服务器已停用')
      if (settings.permissionMode === 'full' || mcp.access === 'allow')
        return result('allow', `MCP 服务器 ${mcp.server} 已允许`)
      return {
        decision: 'ask',
        reason: `使用 MCP 服务器「${mcp.server}」的工具`,
        server: mcp.server,
      }
    }
    // Computer Use follows the mode (2026-11-06, user's choice): ask mode asks every step, auto
    // and full access go ahead. The hard limits (keychain, passwords, secure fields) sit in the
    // helper and hold in every mode.
    if (computerToolNames.has(call.toolName)) {
      if (call.toolName === 'list_apps')
        return result('allow', '查看打开的应用')
      // Taking the real pointer and keyboard asks in every mode (user's rule, 2026-11-06).
      if (call.toolName === 'take_over')
        return result('ask', describeComputerCall(call.toolName, call.input))
      return settings.permissionMode === 'ask'
        ? result('ask', describeComputerCall(call.toolName, call.input))
        : result('allow', '按权限模式允许操作电脑')
    }
    if (webTools.has(call.toolName))
      return settings.permissionMode === 'ask'
        ? result('ask', '联网读取需要授权')
        : result('allow', '只读联网')
    if (!names.has(call.toolName)) return result('deny', '未知工具')
    const input = call.input as {
      path?: string
      cwd?: string
      command?: string
      network?: boolean
    } | null
    const workspace = normalizePath(settings.workspacePath)
    const shell = call.toolName === 'run_shell'
    const value = shell ? (input?.cwd ?? workspace) : input?.path
    if (typeof value !== 'string' || !value) return result('deny', '路径无效')
    const path = normalizePath(value, workspace)
    resolvedPath = path
    // A broad workspace cannot grant access to Familiar's private or read-only data.
    const readableDirs = readableFamiliarDirs()
    const familiarRead =
      (reads.has(call.toolName) || shell) &&
      readableDirs.some((dir) => within(path, dir))
    const familiarWrite =
      within(path, workspace) && within(path, familiarWorkspaceDir())
    if (
      credentialRoots().some(
        (root) =>
          within(path, root) ||
          (call.toolName === 'delete_path' && within(root, path)),
      ) ||
      (!reads.has(call.toolName) &&
        !shell &&
        readableDirs.some(
          (dir) =>
            within(path, dir) ||
            (call.toolName === 'delete_path' && within(dir, path)),
        )) ||
      (!familiarRead &&
        !familiarWrite &&
        (await forbiddenRoots()).some(
          (root) =>
            within(path, root) ||
            (call.toolName === 'delete_path' && within(root, path)),
        )) ||
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
    // Out of the sandbox, a command that names a protected place asks first.
    if (
      call.toolName === 'run_shell' &&
      settings.permissionMode !== 'full' &&
      !settings.shellSandbox &&
      typeof input?.command === 'string'
    ) {
      const hits = await protectedPathsIn(input.command, [
        workspace,
        ...readableFamiliarDirs(),
      ])
      if (hits.length)
        return result(
          'ask',
          `这条命令不在沙箱里运行，会访问存放登录凭据、密钥的位置：${hits
            .map((p) => p.replace(homedir(), '~'))
            .join('、')}`,
        )
    }
    if (settings.permissionMode === 'full')
      return result('allow', '完全访问模式')
    // Auto mode lets sandboxed commands go online like web_search and fetch_page; ask mode asks,
    // unless "allow all" on an earlier network ask left that directory a network rule.
    if (
      shell &&
      input?.network &&
      settings.shellSandbox &&
      settings.permissionMode === 'ask' &&
      !(rule?.access === 'allow' && rule.network)
    )
      return {
        decision: 'ask',
        reason: '执行命令需要联网授权',
        dir: path,
        resolvedPath,
      }
    if (within(path, workspace)) {
      return settings.permissionMode === 'auto' || reads.has(call.toolName)
        ? result('allow', '工作目录内允许此操作')
        : result('ask', '写入或执行命令需要授权')
    }
    // Familiar's own folders and shared skills read like the workspace (scripts still run sandboxed).
    if (
      reads.has(call.toolName) &&
      (familiarRead || within(path, normalizePath(sharedSkillsDir())))
    )
      return result('allow', '读取 Familiar 的资料或技能')
    if (shell && settings.permissionMode === 'auto' && !rule)
      return result(
        'allow',
        settings.shellSandbox ? '命令由工作目录写入沙箱约束' : '命令沙箱已关闭',
      )
    if (rule) return result(rule.access, '按目录规则处理')
    return {
      decision: 'ask',
      reason: '工作目录外的访问需要授权',
      resolvedPath,
      dir: shell || call.toolName === 'list_dir' ? path : dirname(path),
    }
  } catch {
    return result('deny', '无法安全解析路径')
  }
}

/** The directory rule an approved request leaves behind, so the grant shows in settings. */
export function grantedRule(approval: {
  toolName: string
  input: unknown
  dir?: string
}): Settings['dirRules'][number] | undefined {
  if (!approval.dir) return undefined
  const network =
    approval.toolName === 'run_shell' &&
    (approval.input as { network?: unknown } | null)?.network === true
  return {
    path: approval.dir,
    access: 'allow',
    ...(network ? { network } : {}),
  }
}

/** Adds a granted rule; an earlier grant for the same directory keeps its network access. */
export function withRule(
  rules: Settings['dirRules'],
  rule: Settings['dirRules'][number],
): Settings['dirRules'] {
  const earlier = rules.find((r) => r.path === rule.path)
  const network =
    rule.network || (earlier?.access === 'allow' && earlier.network)
  return [
    ...rules.filter((r) => r.path !== rule.path),
    { ...rule, ...(network ? { network: true } : {}) },
  ]
}
