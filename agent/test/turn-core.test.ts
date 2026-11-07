import { expect, test } from 'bun:test'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { MockLanguageModelV4 } from 'ai/test'
import { tool, type ModelMessage } from 'ai'
import { z } from 'zod'
import { runAgentCore } from '../src/agent/core'
import * as computer from '../src/computer'
import { dataDir } from '../src/system'
import type { AgentEvent } from '../../src/shared'

const usage = {
  inputTokens: { total: 12, noCache: 5, cacheRead: 4, cacheWrite: 3 },
  outputTokens: { total: 8, text: 6, reasoning: 2 },
}
const stream = (parts: unknown[]) =>
  new ReadableStream({
    start(c) {
      parts.forEach((p) => c.enqueue(p))
      c.close()
    },
  })
const finish = {
  type: 'finish',
  finishReason: { unified: 'stop', raw: 'stop' },
  usage,
}
const textParts = (text: string) => [
  { type: 'text-start', id: 't' },
  ...Array.from(text).map((delta) => ({ type: 'text-delta', id: 't', delta })),
  { type: 'text-end', id: 't' },
]
async function run(parts: unknown[], events: AgentEvent[] = []) {
  const model = new MockLanguageModelV4({
    doStream: async () => ({ stream: stream(parts) }),
  })
  await runAgentCore(
    [{ role: 'user', content: '继续' }],
    (e) => events.push(e),
    new AbortController().signal,
    {
      model,
      protocol: 'openai-compatible',
      tools: {},
      instructions: '',
      workspacePath: '/tmp',
      decide: async () => ({ decision: 'allow', reason: '' }),
      snapshot: async () => {},
    },
  )
}

test('the relay error envelope before an interrupted stream never becomes assistant text', async () => {
  const events: AgentEvent[] = []
  await expect(
    run(
      [
        ...textParts('> ❌ 没有可用token'),
        {
          type: 'error',
          error: new Error('responses stream ended without completed'),
        },
      ],
      events,
    ),
  ).rejects.toThrow('中转站返回了错误：没有可用token')
  expect(events.filter((e) => e.type === 'text-delta')).toEqual([])
})

test.each([
  '> ❌ 没有可用token',
  '❌ 没有可用token 是服务端提示，检查账号。',
  '日志里出现了 > ❌ 没有可用token',
])('ordinary completed text is preserved: %s', async (text) => {
  const events: AgentEvent[] = []
  await run([...textParts(text), finish], events)
  expect(
    events.flatMap((e) => (e.type === 'text-delta' ? [e.text] : [])).join(''),
  ).toBe(text)
})

test('usage records SDK totals across tool steps, including cache and reasoning', async () => {
  const modelId = `usage-${crypto.randomUUID()}`
  let calls = 0
  const model = new MockLanguageModelV4({
    modelId,
    doStream: async () => ({
      stream: stream(
        ++calls === 1
          ? [
              {
                type: 'tool-call',
                toolCallId: 'a',
                toolName: 'read_window',
                input: '{}',
              },
              {
                ...finish,
                finishReason: { unified: 'tool-calls', raw: 'tool_calls' },
              },
            ]
          : [...textParts('好了'), finish],
      ),
    }),
  })
  await runAgentCore(
    [{ role: 'user', content: '看一下' }],
    () => {},
    new AbortController().signal,
    {
      model,
      protocol: 'anthropic',
      tools: {
        read_window: tool({ inputSchema: z.object({}), execute: () => '窗口' }),
      },
      instructions: '',
      workspacePath: '/tmp',
      decide: async () => ({ decision: 'allow', reason: '' }),
      snapshot: async () => {},
    },
  )
  const rows = (await readFile(join(dataDir, 'evals/usage.jsonl'), 'utf8'))
    .trim()
    .split('\n')
    .map((s) => JSON.parse(s))
  expect(rows.filter((r) => r.model === modelId)).toEqual([
    expect.objectContaining({
      protocol: 'anthropic',
      steps: 2,
      computerUsed: true,
      inputTokens: 24,
      outputTokens: 16,
      cacheReadTokens: 8,
      cacheWriteTokens: 6,
      reasoningTokens: 4,
    }),
  ])
})

const tree = (id: string) =>
  `已点击「${id}」\n\n现在「编辑器」的窗口「文稿」：\n[${id}] AXTextArea：窗口-${id}`

test('only the latest tree survives across text, JSON and content tool outputs', () => {
  const messages: ModelMessage[] = [
    {
      role: 'tool',
      content: [
        {
          type: 'tool-result',
          toolCallId: '1',
          toolName: 'click',
          output: { type: 'text', value: tree('1') },
        },
        {
          type: 'tool-result',
          toolCallId: '2',
          toolName: 'click',
          output: { type: 'json', value: { text: tree('2') } },
        },
        {
          type: 'tool-result',
          toolCallId: '3',
          toolName: 'click',
          output: {
            type: 'content',
            value: [{ type: 'text', text: tree('3') }],
          },
        },
        {
          type: 'tool-result',
          toolCallId: '4',
          toolName: 'read_window',
          output: {
            type: 'json',
            value: '「编辑器」：\n[4] AXTextArea：最新窗口',
          },
        },
        {
          type: 'tool-result',
          toolCallId: 'shot',
          toolName: 'screenshot',
          output: {
            type: 'content',
            value: [
              { type: 'text', text: '截图内容' },
              { type: 'image-data', data: 'jpeg', mediaType: 'image/jpeg' },
            ],
          },
        },
      ],
    },
  ]
  const original = JSON.stringify(messages)
  const result = computer.withLatestWindowTree(messages)
  const json = JSON.stringify(result)
  expect(json.match(/旧的窗口内容已省略/g)).toHaveLength(3)
  expect(json).toContain('最新窗口')
  expect(json).toContain('已点击')
  expect(json).not.toContain('窗口-1')
  expect(json).not.toContain('窗口-2')
  expect(json).not.toContain('窗口-3')
  expect(json).toContain('jpeg')
  expect(JSON.stringify(messages)).toBe(original)
})

test('prepareStep prunes old window trees without disturbing screenshot messages', async () => {
  const prompts: string[] = []
  let calls = 0
  const model = new MockLanguageModelV4({
    doStream: async (options) => {
      prompts.push(JSON.stringify(options.prompt))
      calls++
      return {
        stream: stream(
          calls < 4
            ? [
                {
                  type: 'tool-call',
                  toolCallId: String(calls),
                  toolName: 'click',
                  input: JSON.stringify({ n: calls }),
                },
                {
                  ...finish,
                  finishReason: { unified: 'tool-calls', raw: 'tool_calls' },
                },
              ]
            : [...textParts('好了'), finish],
        ),
      }
    },
  })
  await runAgentCore(
    [{ role: 'user', content: '点击' }],
    () => {},
    new AbortController().signal,
    {
      model,
      tools: {
        click: tool({
          inputSchema: z.object({ n: z.number() }),
          execute: ({ n }) => tree(String(n)),
        }),
      },
      instructions: '',
      workspacePath: '/tmp',
      decide: async () => ({ decision: 'allow', reason: '' }),
      snapshot: async () => {},
    },
  )
  expect(prompts[1]).toContain('窗口-1')
  expect(prompts[3]).not.toContain('窗口-1')
  expect(prompts[3]).not.toContain('窗口-2')
  expect(prompts[3]).toContain('窗口-3')
  expect(prompts[3]?.match(/旧的窗口内容已省略/g)).toHaveLength(2)
})
