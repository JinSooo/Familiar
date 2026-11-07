import { execFile, spawn } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tool, type ToolSet } from 'ai'
import { z } from 'zod'
import type { Settings } from '../../../src/shared'
import { decideToolCall } from '../permissions'
import { normalizePath, within } from '../permissions/paths'
import { sandboxProfile } from './sandbox'
import { dataDir, moveToTrash } from '../system'
import { snapshotsEnabled } from '../settings'

const exec = promisify(execFile)
const repositories = new Map<string, Promise<unknown>>()
/** Keep init and each add/diff/commit transaction together, including aliases of a path. */
function inRepository<T>(path: string, work: () => Promise<T>): Promise<T> {
  const key = normalizePath(path)
  const next = (repositories.get(key) ?? Promise.resolve()).then(work, work)
  const settled = next.catch(() => {})
  repositories.set(key, settled)
  void settled.then(() => {
    if (repositories.get(key) === settled) repositories.delete(key)
  })
  return next
}
async function git(path: string, args: string[]): Promise<string> {
  for (let attempt = 0; ; attempt++) {
    try {
      return (
        await exec('/usr/bin/git', [
          '-C',
          path,
          '-c',
          'user.name=Familiar',
          '-c',
          'user.email=familiar@localhost',
          ...args,
        ])
      ).stdout
    } catch (error) {
      // An external git process may briefly hold the lock. Never remove its lock file.
      if (attempt || !/index\.lock.*File exists/s.test(String(error)))
        throw error
      await new Promise((resolve) => setTimeout(resolve, 150))
    }
  }
}
/**
 * Everything lives under ~/.familiar: config at the top (off limits to the model), and the
 * folders below. One git repository at ~/.familiar snapshots only the whitelisted folders, so
 * config files — mcp.json may hold tokens — can never be committed.
 */
const tracked = ['workspace', 'memory', 'knowledge', 'conversations', 'skills']
export const gitignore = `# Familiar 的快照只记录下面这些目录；其他文件（包括 mcp.json、settings.json）永远不进 git。
/*
!/.gitignore
${tracked.map((d) => `!/${d}/`).join('\n')}
`
const familiarRoot = () => normalizePath(dataDir)

/** Repositories a snapshot commits: ~/.familiar, plus a workspace the user moved elsewhere. */
function snapshotRoots(workspacePath: string): string[] {
  const workspace = normalizePath(workspacePath)
  const root = familiarRoot()
  return within(workspace, root) ? [root] : [root, workspace]
}

async function ensureRepo(path: string, ignore?: string): Promise<boolean> {
  if (ignore) {
    // Rewritten only when it differs, so a user's additions below the rules would be lost; keep it ours.
    const current = await readFile(join(path, '.gitignore'), 'utf8').catch(
      () => '',
    )
    if (current !== ignore) await writeFile(join(path, '.gitignore'), ignore)
  }
  let top = ''
  try {
    top = (await git(path, ['rev-parse', '--show-toplevel'])).trim()
  } catch {
    /* Not a repository yet. */
  }
  const created = !top || normalizePath(top) !== path
  if (created) await git(path, ['init'])
  return created
}

export async function ensureWorkspace(settings: Settings): Promise<string> {
  const path = normalizePath(settings.workspacePath)
  if (
    (
      await decideToolCall(
        { id: '', toolName: 'make_dir', input: { path } },
        settings,
      )
    ).decision === 'deny'
  )
    throw new Error('工作目录属于禁止访问的路径')
  await mkdir(path, { recursive: true })
  for (const dir of ['memory', 'knowledge', 'conversations'])
    await mkdir(join(dataDir, dir), { recursive: true })
  await writeFile(
    join(dataDir, 'README.md'),
    `# ~/.familiar

Familiar 的全部数据都在这里：

- workspace/：工作目录，Familiar 替你读写文件的地方
- memory/：长期记忆（Markdown，可以直接改）
- conversations/：对话记录
- knowledge/：知识资料
- skills/：导入的技能
- settings.json、mcp.json 等：配置，模型的工具碰不到

开启「自动快照」时，上面几个目录的改动会用 git 记录在这里，配置文件不进 git。
`,
    { flag: 'wx' },
  ).catch((error) => {
    if (error.code !== 'EEXIST') throw error
  })
  // With snapshots off, no repository is created; an existing .git is left as it is.
  if (!settings.workspaceSnapshots) return path
  for (const root of snapshotRoots(path))
    await inRepository(root, async () => {
      const created = await ensureRepo(
        root,
        root === familiarRoot() ? gitignore : undefined,
      )
      if (created && snapshotsEnabled())
        await snapshotRepo(root, 'Initialize Familiar')
    })
  return path
}

async function snapshotRepo(path: string, message: string): Promise<void> {
  try {
    // Never add without the whitelist: ~/.familiar also holds config with tokens.
    if (path === familiarRoot()) {
      const current = await readFile(join(path, '.gitignore'), 'utf8').catch(
        () => '',
      )
      if (current !== gitignore)
        await writeFile(join(path, '.gitignore'), gitignore)
    }
    await git(path, ['add', '-A'])
    if (!(await git(path, ['diff', '--cached', '--name-only'])).trim()) return
    await git(path, ['commit', '-m', message])
  } catch (error) {
    console.error('Familiar snapshot failed:', error)
  }
}

export async function snapshot(
  workspacePath: string,
  message: string,
): Promise<void> {
  if (!snapshotsEnabled()) return
  for (const path of snapshotRoots(workspacePath))
    await inRepository(path, () => snapshotRepo(path, message))
}

export function createWorkspaceTools(
  settings: Settings,
  currentSettings: () => Settings = () => settings,
): ToolSet {
  const pathSchema = z.object({ path: z.string().min(1) })
  function fileTool<S extends z.ZodType<{ path: string }>>(
    name: string,
    description: string,
    schema: S,
    action: (input: z.output<S>, path: string) => Promise<unknown>,
  ) {
    return tool({
      description,
      inputSchema: schema,
      execute: async (input) => {
        try {
          const settings = currentSettings()
          const decision = await decideToolCall(
            { id: '', toolName: name, input },
            settings,
          )
          if (decision.decision === 'deny') return { error: decision.reason }
          return await action(input as z.output<S>, decision.resolvedPath!)
        } catch (error) {
          return { error: String(error) }
        }
      },
    })
  }
  return {
    read_file: fileTool(
      'read_file',
      '读取一个 UTF-8 文本文件的全部内容。路径可以是相对工作目录的路径或绝对路径。',
      pathSchema,
      async (_, path) => ({
        content: await readFile(path, 'utf8'),
      }),
    ),
    list_dir: fileTool(
      'list_dir',
      '列出目录中的文件和子目录名。路径可以是相对工作目录的路径或绝对路径。',
      pathSchema,
      async (_, path) => ({
        entries: await readdir(path),
      }),
    ),
    write_file: fileTool(
      'write_file',
      '创建或整体覆盖一个文本文件。',
      pathSchema.extend({ content: z.string() }),
      async (input, path) => {
        await writeFile(path, input.content)
        return { ok: true }
      },
    ),
    edit_file: fileTool(
      'edit_file',
      '把文件中唯一出现的 oldString 替换为 newString；oldString 必须在文件中恰好出现一次。',
      pathSchema.extend({
        oldString: z.string().min(1),
        newString: z.string(),
      }),
      async (input, path) => {
        const content = await readFile(path, 'utf8')
        if (!content.includes(input.oldString))
          return { error: '未找到待替换文本' }
        if (
          content.indexOf(input.oldString) !==
          content.lastIndexOf(input.oldString)
        )
          return { error: '待替换文本不唯一，请提供更多上下文' }
        await writeFile(
          path,
          content.replace(input.oldString, () => input.newString),
        )
        return { ok: true }
      },
    ),
    delete_path: fileTool(
      'delete_path',
      '把文件或目录移到废纸篓（可恢复）。',
      pathSchema,
      async (_, path) => {
        await moveToTrash(path)
        return { ok: true }
      },
    ),
    make_dir: fileTool(
      'make_dir',
      '创建目录（包括缺失的父目录）。',
      pathSchema,
      async (_, path) => {
        await mkdir(path, { recursive: true })
        return { ok: true }
      },
    ),
    run_shell: tool({
      description:
        settings.permissionMode !== 'full' && settings.shellSandbox
          ? '用 zsh 执行一条 shell 命令，返回输出和退出码。命令在 Familiar 的沙箱里运行：只能写工作目录，默认禁止联网（确实需要时设置 network: true；询问模式下会请求用户授权）；~/.familiar 里除工作目录、memory、conversations、knowledge、skills 外都读不到，~/.ssh、钥匙串、浏览器密码文件也读不到。遇到 Operation not permitted 就是被这个沙箱拦下的，不是 macOS 权限问题，不要让用户去系统设置里授权；告诉用户可以在 Familiar 设置「权限」里关掉命令沙箱。'
          : '用 zsh 执行一条 shell 命令，返回输出和退出码。命令不在沙箱里运行，和用户在终端里执行一样，可以读写整台电脑、可以联网，所以只做用户要求的事，不要顺手删改文件。',
      inputSchema: z.object({
        command: z.string(),
        cwd: z.string().optional(),
        network: z.boolean().optional(),
        timeoutMs: z.number().int().positive().max(600000).optional(),
      }),
      execute: async (input, { abortSignal }) => {
        try {
          abortSignal?.throwIfAborted()
          const settings = currentSettings()
          const decision = await decideToolCall(
            { id: '', toolName: 'run_shell', input },
            settings,
          )
          if (decision.decision === 'deny') return { error: decision.reason }
          const cwd = decision.resolvedPath!
          const full =
            settings.permissionMode === 'full' || !settings.shellSandbox
          const args = full
            ? ['-c', input.command]
            : [
                '-p',
                await sandboxProfile(settings, input.network === true),
                '/bin/zsh',
                '-c',
                input.command,
              ]
          abortSignal?.throwIfAborted()
          return await new Promise((resolve) => {
            const child = spawn(
              full ? '/bin/zsh' : '/usr/bin/sandbox-exec',
              args,
              { cwd, detached: true, env: { ...process.env } },
            )
            let output = ''
            let timedOut = false
            let stopped = false
            let closed:
              { exitCode: number | null; signal: string | null } | undefined
            let escalation: ReturnType<typeof setTimeout> | undefined
            const append = (data: Buffer): void => {
              output = (output + data.toString()).slice(0, 20000)
            }
            const killGroup = (signal: NodeJS.Signals) => {
              try {
                if (child.pid) process.kill(-child.pid, signal)
              } catch {
                child.kill(signal)
              }
            }
            const cleanup = () => {
              clearTimeout(timer)
              clearTimeout(escalation)
              abortSignal?.removeEventListener('abort', abort)
              child.stdout.off('data', append)
              child.stderr.off('data', append)
            }
            const finish = () => {
              if (!closed || escalation) return
              cleanup()
              const blocked =
                !full && /Operation not permitted/.test(output)
                  ? '\n（被 Familiar 的命令沙箱拦下：沙箱只能写工作目录，~/.familiar 里大部分位置和密钥读不到。需要时可以在设置「权限」里关掉命令沙箱。）'
                  : ''
              resolve({
                output: output + blocked + (stopped ? '\n已停止' : ''),
                ...closed,
                timedOut,
                stopped,
              })
            }
            const terminate = () => {
              if (escalation) return
              killGroup('SIGTERM')
              // The shell may exit before children that ignore TERM; still kill the group.
              escalation = setTimeout(() => {
                killGroup('SIGKILL')
                escalation = undefined
                finish()
              }, 300)
            }
            const abort = () => {
              stopped = true
              terminate()
            }
            const timer = setTimeout(() => {
              timedOut = true
              terminate()
            }, input.timeoutMs ?? 60000)
            child.stdout.on('data', append)
            child.stderr.on('data', append)
            abortSignal?.addEventListener('abort', abort, { once: true })
            if (abortSignal?.aborted) abort()
            child.once('error', (error) => {
              cleanup()
              resolve({
                error: String(error),
                ...(stopped
                  ? { stopped, output: '已停止', exitCode: null }
                  : {}),
              })
            })
            child.once('close', (exitCode, signal) => {
              closed = { exitCode, signal }
              finish()
            })
          })
        } catch (error) {
          return abortSignal?.aborted
            ? { output: '已停止', exitCode: null, stopped: true }
            : { error: String(error) }
        }
      },
    }),
  }
}
