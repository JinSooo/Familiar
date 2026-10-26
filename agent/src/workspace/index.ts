import { execFile, spawn } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tool, type ToolSet } from 'ai'
import { z } from 'zod'
import type { Settings } from '../../../src/shared'
import { decideToolCall } from '../permissions'
import { normalizePath } from '../permissions/paths'
import { sandboxProfile } from './sandbox'

const exec = promisify(execFile)
async function git(path: string, args: string[]): Promise<string> {
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
  for (const dir of ['memory', 'knowledge'])
    await mkdir(join(path, dir), { recursive: true })
  await writeFile(
    join(path, 'README.md'),
    '# Familiar 工作目录\n\n这是 Familiar 的工作目录。memory/ 保存记忆，knowledge/ 保存知识资料。操作通过 Git 快照记录。\n',
    { flag: 'wx' },
  ).catch((error) => {
    if (error.code !== 'EEXIST') throw error
  })
  let root = ''
  try {
    root = (await git(path, ['rev-parse', '--show-toplevel'])).trim()
  } catch {
    /* New workspace. */
  }
  if (!root || normalizePath(root) !== path) await git(path, ['init'])
  await snapshot(path, 'Initialize Familiar workspace')
  return path
}
export async function snapshot(
  workspacePath: string,
  message: string,
): Promise<void> {
  try {
    const path = normalizePath(workspacePath)
    await git(path, ['add', '-A'])
    if (!(await git(path, ['diff', '--cached', '--name-only'])).trim()) return
    await git(path, ['commit', '-m', message])
  } catch (error) {
    console.error('Familiar snapshot failed:', error)
  }
}

export function createWorkspaceTools(settings: Settings): ToolSet {
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
          const decision = await decideToolCall(
            { id: '', toolName: name, input },
            settings,
          )
          if (decision.decision === 'deny') return { error: decision.reason }
          return await action(
            input as z.output<S>,
            normalizePath(input.path, normalizePath(settings.workspacePath)),
          )
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
        await exec('/usr/bin/osascript', [
          '-e',
          'on run argv\n tell application "Finder" to delete POSIX file (item 1 of argv)\nend run',
          path,
        ])
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
        '用 zsh 执行一条 shell 命令，返回输出和退出码。默认只能写工作目录且禁止联网；确实需要联网时设置 network: true（会请求用户授权）。',
      inputSchema: z.object({
        command: z.string(),
        cwd: z.string().optional(),
        network: z.boolean().optional(),
        timeoutMs: z.number().int().positive().max(600000).optional(),
      }),
      execute: async (input) => {
        try {
          const decision = await decideToolCall(
            { id: '', toolName: 'run_shell', input },
            settings,
          )
          if (decision.decision === 'deny') return { error: decision.reason }
          const cwd = normalizePath(
            input.cwd ?? settings.workspacePath,
            normalizePath(settings.workspacePath),
          )
          const full = settings.permissionMode === 'full'
          const args = full
            ? ['-c', input.command]
            : [
                '-p',
                await sandboxProfile(settings, input.network === true),
                '/bin/zsh',
                '-c',
                input.command,
              ]
          return await new Promise((resolve) => {
            const child = spawn(
              full ? '/bin/zsh' : '/usr/bin/sandbox-exec',
              args,
              { cwd, detached: true, env: { ...process.env } },
            )
            let output = ''
            let timedOut = false
            const append = (data: Buffer): void => {
              output = (output + data.toString()).slice(0, 20000)
            }
            child.stdout.on('data', append)
            child.stderr.on('data', append)
            const timer = setTimeout(() => {
              timedOut = true
              try {
                process.kill(-child.pid!, 'SIGKILL')
              } catch {
                child.kill('SIGKILL')
              }
            }, input.timeoutMs ?? 60000)
            child.on('error', (error) => {
              clearTimeout(timer)
              resolve({ error: String(error) })
            })
            child.on('close', (exitCode, signal) => {
              clearTimeout(timer)
              resolve({ output, exitCode, signal, timedOut })
            })
          })
        } catch (error) {
          return { error: String(error) }
        }
      },
    }),
  }
}
