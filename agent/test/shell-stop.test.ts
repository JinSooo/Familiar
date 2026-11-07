import { expect, test } from 'bun:test'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { settingsSchema } from '../../src/shared'
import { createWorkspaceTools } from '../src/workspace'
import { commandText } from '../src/agent/core'

async function shellCase(
  work: (
    execute: (command: string, signal: AbortSignal) => Promise<unknown>,
    dir: string,
  ) => Promise<void>,
) {
  const dir = await mkdtemp(join(tmpdir(), 'familiar-shell-stop-'))
  const tools = createWorkspaceTools(
    settingsSchema.parse({ workspacePath: dir, permissionMode: 'full' }),
  )
  try {
    await work(
      (command, abortSignal) =>
        Promise.resolve(
          tools.run_shell!.execute!(
            { command, timeoutMs: 1400 },
            { toolCallId: 'shell', messages: [], abortSignal },
          ),
        ),
      dir,
    )
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

test('an already stopped shell never starts', () =>
  shellCase(async (execute, dir) => {
    const controller = new AbortController()
    controller.abort()
    const result = await execute('echo ran > marker', controller.signal)
    expect(await readFile(join(dir, 'marker'), 'utf8').catch(() => '')).toBe('')
    expect(commandText(result)).toContain('已停止')
  }))

test('stop terminates the whole group, including a child ignoring TERM', () =>
  shellCase(async (execute, dir) => {
    const controller = new AbortController()
    const result = execute(
      '/bin/zsh -c \'trap "" TERM; echo $$ > child; while true; do sleep 1; done\' & wait',
      controller.signal,
    )
    let pid = 0
    for (let i = 0; i < 100 && !pid; i++) {
      pid = Number(await readFile(join(dir, 'child'), 'utf8').catch(() => ''))
      if (!pid) await Bun.sleep(10)
    }
    expect(pid).toBeGreaterThan(0)
    const start = Date.now()
    controller.abort()
    const output = await result
    expect(Date.now() - start).toBeLessThan(1000)
    expect(commandText(output)).toContain('已停止')
    expect(output).toMatchObject({
      stopped: true,
      timedOut: false,
      output: expect.stringContaining('已停止'),
    })
    expect(() => process.kill(pid, 0)).toThrow()
  }))
