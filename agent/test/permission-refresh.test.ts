import { expect, spyOn, test } from 'bun:test'
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createOpenAI } from '@ai-sdk/openai'
import * as provider from '../src/agent/provider'
import * as settingsModule from '../src/settings'
import * as workspace from '../src/workspace'
import { settingsSchema } from '../../src/shared'
import { runAgent } from '../src/agent'
import { resolveApproval } from '../src/agent/approvals'

test('a directory grant is effective in the next step of the same run', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'familiar-grant-')))
  const outside = join(root, 'outside')
  mkdirSync(outside)
  writeFileSync(join(outside, 'a'), 'one')
  writeFileSync(join(outside, 'b'), 'two')
  let settings = settingsSchema.parse({
    workspacePath: join(root, 'workspace'),
    workspaceSnapshots: false,
    permissionMode: 'auto',
  })
  const get = spyOn(settingsModule, 'getSettings').mockImplementation(() =>
    structuredClone(settings),
  )
  const snapshot = spyOn(workspace, 'snapshot').mockResolvedValue()
  let step = 0
  const fetch = (async () => {
    const id = `call-${++step}`
    const call = step <= 2
    const delta = call
      ? {
          tool_calls: [
            {
              index: 0,
              id,
              type: 'function',
              function: {
                name: 'read_file',
                arguments: JSON.stringify({
                  path: join(outside, step === 1 ? 'a' : 'b'),
                }),
              },
            },
          ],
        }
      : { content: 'done' }
    const chunk = (delta: unknown, finish_reason: string | null) => ({
      id,
      object: 'chat.completion.chunk',
      created: 0,
      model: 'test',
      choices: [{ index: 0, delta, finish_reason }],
    })
    return new Response(
      [chunk(delta, null), chunk({}, call ? 'tool_calls' : 'stop')]
        .map((c) => `data: ${JSON.stringify(c)}\n\n`)
        .join('') + 'data: [DONE]\n\n',
      { headers: { 'content-type': 'text/event-stream' } },
    )
  }) as typeof globalThis.fetch
  const model = spyOn(provider, 'createModel').mockReturnValue(
    createOpenAI({ apiKey: 'test', fetch }).chat('test'),
  )
  let approvals = 0
  const outputs: string[] = []
  try {
    await runAgent(
      [{ role: 'user', content: '读文件', createdAt: 0 }],
      (event) => {
        if (event.type === 'tool-approval-request') {
          approvals++
          settings = {
            ...settings,
            dirRules: [{ path: outside, access: 'allow' }],
          }
          resolveApproval(event.id, 'approve')
        }
        if (event.type === 'tool-result') outputs.push(String(event.output))
      },
      new AbortController().signal,
    )
    expect(outputs).toHaveLength(2)
    expect(outputs[1]).toContain('two')
    expect(approvals).toBe(1)
    // Existing executors must also see later revocation, not their initial settings copy.
    const tools = workspace.createWorkspaceTools(
      settings,
      settingsModule.getSettings,
    )
    settings = { ...settings, dirRules: [{ path: outside, access: 'deny' }] }
    const result = await tools.read_file!.execute!(
      { path: join(outside, 'b') },
      { toolCallId: 'later', messages: [] },
    )
    expect(result).toMatchObject({ error: '目录规则禁止访问' })
  } finally {
    get.mockRestore()
    model.mockRestore()
    snapshot.mockRestore()
    rmSync(root, { recursive: true, force: true })
  }
})
