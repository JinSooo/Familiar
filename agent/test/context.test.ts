import { afterAll, expect, test } from 'bun:test'
import { readFile, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { tool, type ModelMessage } from 'ai'
import { MockLanguageModelV4 } from 'ai/test'
import { z } from 'zod'
import type { Message } from '../../src/shared'
import { prepareModelContext } from '../src/agent/context'
import { runAgentCore } from '../src/agent/core'
import { attachmentFile, saveAttachment } from '../src/attachments'
import { dataDir } from '../src/system'

const ids: string[] = []
const usage = {
  inputTokens: {
    total: 1,
    noCache: 1,
    cacheRead: undefined,
    cacheWrite: undefined,
  },
  outputTokens: { total: 1, text: 1, reasoning: undefined },
}
const summary = () =>
  new MockLanguageModelV4({
    doGenerate: async () => ({
      content: [
        {
          type: 'text',
          text: '用户的目标：整理文件。\n用户批准过或拒绝过什么：拒绝删除。',
        },
      ],
      finishReason: { unified: 'stop', raw: 'stop' },
      usage,
      warnings: [],
    }),
  })
function options(model = summary(), budget = 64000) {
  const conversationId = `context-${crypto.randomUUID()}`
  ids.push(conversationId)
  return {
    conversationId,
    instructions: '你是桌面宠物。',
    tools: {},
    summaryModel: () => model,
    signal: new AbortController().signal,
    now: new Date(2026, 10, 7, 14, 3),
    mood: '你现在的心情：开心。',
    budget,
  }
}
const text = (message: ModelMessage) =>
  typeof message.content === 'string'
    ? message.content
    : message.content
        .filter((p) => p.type === 'text')
        .map((p) => p.text)
        .join('\n')
function history(rounds: number, size: number): Message[] {
  return Array.from({ length: rounds }, (_, i) => [
    {
      role: 'user' as const,
      content: i < rounds - 6 ? `开头${'中'.repeat(size)}末尾` : `问题${i}`,
    },
    {
      role: 'assistant' as const,
      content: i < rounds - 6 ? `回答${'文'.repeat(size)}结尾` : `回复${i}`,
    },
  ]).flat()
}
afterAll(async () => {
  await Promise.all(
    ids.map((id) =>
      rm(join(dataDir, 'compact', `${id}.json`), { force: true }),
    ),
  )
})

test('short history stays intact; only the last user gets ephemeral time and mood', async () => {
  const model = summary()
  const input: Message[] = [
    { role: 'user', content: '先说一句' },
    { role: 'assistant', content: '你好' },
    { role: 'user', content: '继续' },
    { role: 'assistant', content: '补充' },
  ]
  const before = structuredClone(input)
  const result = await prepareModelContext(input, options(model))
  expect(result.slice(0, 2)).toEqual(input.slice(0, 2))
  expect(text(result[2]!)).toMatch(/^［现在是 .*14:03.*开心.*］\n继续$/)
  expect(result[3]).toEqual(input[3])
  expect(input).toEqual(before)
  expect(model.doGenerateCalls).toHaveLength(0)
})

test('only the last two user messages retain attachments, including text, images and PDFs', async () => {
  const opts = options()
  const attachments = await Promise.all([
    saveAttachment(
      opts.conversationId,
      'notes.md',
      new TextEncoder().encode('ATTACHMENT BODY'),
    ),
    saveAttachment(opts.conversationId, 'shot.png', new Uint8Array([1, 2])),
    saveAttachment(opts.conversationId, 'report.pdf', new Uint8Array([3, 4])),
  ])
  const input: Message[] = [
    { role: 'user', content: '旧', attachments },
    { role: 'assistant', content: '收到' },
    { role: 'user', content: '新', attachments },
    { role: 'assistant', content: '收到' },
    { role: 'user', content: '最新', attachments },
  ]
  const before = structuredClone(input)
  const result = await prepareModelContext(input, {
    ...opts,
    canReadAttachment: async () => true,
  })
  expect(text(result[0]!)).toContain(
    `read_file 读 ${attachmentFile(attachments[0]!.path)}`,
  )
  expect(text(result[0]!)).toContain('之前附上过：shot.png')
  expect(text(result[0]!)).not.toContain('ATTACHMENT BODY')
  expect(text(result[0]!)).not.toContain(attachmentFile(attachments[1]!.path))
  for (const i of [2, 4]) {
    expect(text(result[i]!)).toContain('ATTACHMENT BODY')
    expect(result[i]!.content).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'image' }),
        expect.objectContaining({ type: 'file' }),
      ]),
    )
  }
  expect(input).toEqual(before)
  const denied = await prepareModelContext(input, {
    ...opts,
    canReadAttachment: async () => false,
  })
  expect(text(denied[0]!)).toContain('之前附上过：notes.md')
  expect(text(denied[0]!)).not.toContain('read_file')
  await rm(join(attachmentFile(attachments[0]!.path), '..'), {
    recursive: true,
    force: true,
  })
})

test('old operation records lose outcomes first, preserving step names and recent records', async () => {
  const model = summary()
  const input = history(7, 0)
  const record = `［系统记录：这一轮实际执行过的操作］\n1. 读取文件 → ${'结'.repeat(2000)}\n2. 执行命令 → 已返回结果`
  input[1]!.content += record
  input[13]!.content +=
    '［系统记录：这一轮实际执行过的操作］\n1. 最近操作 → 已返回结果'
  const result = await prepareModelContext(input, options(model, 1000))
  expect(text(result[1]!)).toContain('1. 读取文件\n2. 执行命令')
  expect(text(result[1]!)).not.toContain(' → ')
  expect(result[13]).toEqual(input[13])
  expect(model.doGenerateCalls).toHaveLength(0)
})

test('over budget history is trimmed at both ends before any model call', async () => {
  const model = summary()
  const input = history(8, 10000)
  const original = structuredClone(input)
  const result = await prepareModelContext(input, options(model, 5000))
  expect(text(result[0]!)).toStartWith('开头')
  expect(text(result[0]!)).toEndWith('末尾')
  expect(text(result[0]!).length).toBeLessThan(850)
  expect(result[4]).toEqual(input[4])
  expect(input).toEqual(original)
  expect(model.doGenerateCalls).toHaveLength(0)
})

test('summary is cached by conversation, boundary and original content hash with mode 0600', async () => {
  const model = summary()
  const opts = options(model, 1200)
  const input = history(10, 2000)
  const first = await prepareModelContext(input, opts)
  expect(text(first[0]!)).toStartWith('［早先对话的摘要，原文在对话文件里］')
  expect(first).toHaveLength(13)
  expect(model.doGenerateCalls).toHaveLength(1)
  const second = await prepareModelContext(input, {
    ...opts,
    now: new Date(2026, 10, 7, 14, 4),
  })
  expect(second[0]).toEqual(first[0])
  expect(model.doGenerateCalls).toHaveLength(1)
  const file = join(dataDir, 'compact', `${opts.conversationId}.json`)
  expect((await stat(file)).mode & 0o777).toBe(0o600)
  expect(JSON.parse(await readFile(file, 'utf8'))).toMatchObject({ through: 8 })
  input[0]!.content = input[0]!.content.replace('中', '改')
  await prepareModelContext(input, opts)
  expect(model.doGenerateCalls).toHaveLength(2)
  input.push(
    { role: 'user', content: '继续' },
    { role: 'assistant', content: '好' },
  )
  await prepareModelContext(input, opts)
  expect(model.doGenerateCalls).toHaveLength(3)
  const prompt = JSON.stringify(model.doGenerateCalls[0]!.prompt)
  for (const heading of [
    '用户的目标',
    '约束和偏好',
    '做过的决定',
    '用户批准过或拒绝过什么',
    '你答应过要做的事',
    '没做完的事',
    '提到的文件和路径',
  ])
    expect(prompt).toContain(heading)
})

test('summary failure falls back to the last six user rounds without failing the turn', async () => {
  const model = new MockLanguageModelV4({
    doGenerate: async () => {
      throw new Error('offline')
    },
  })
  const input = history(10, 2000)
  const result = await prepareModelContext(input, options(model, 1200))
  expect(text(result[0]!)).toBe('（更早的对话太长，没有带上）')
  expect(result).toHaveLength(13)
  expect(result[1]).toEqual(input[8])
  expect(model.doGenerateCalls).toHaveLength(1)
})

test('system instructions and tool JSON schemas count toward the budget', async () => {
  const model = summary()
  const input = history(7, 1000)
  const opts = options(model, 5000)
  const plain = await prepareModelContext(input, opts)
  expect(plain[0]).toEqual(input[0])
  const result = await prepareModelContext(input, {
    ...opts,
    instructions: '规'.repeat(1500),
    tools: {
      read: tool({
        description: '说明',
        inputSchema: z.object({ path: z.string().describe('径'.repeat(2000)) }),
      }),
    },
  })
  expect(text(result[0]!)).toStartWith('［早先对话的摘要')
  expect(model.doGenerateCalls).toHaveLength(1)
})

test('Anthropic gets an ephemeral system cache breakpoint through ToolLoopAgent', async () => {
  const model = new MockLanguageModelV4({
    doStream: async () => ({
      stream: new ReadableStream({
        start(c) {
          c.enqueue({
            type: 'finish',
            finishReason: { unified: 'stop', raw: 'stop' },
            usage,
          })
          c.close()
        },
      }),
    }),
  })
  await runAgentCore(
    [{ role: 'user', content: '你好' }],
    () => {},
    new AbortController().signal,
    {
      model,
      protocol: 'anthropic',
      tools: {},
      instructions: '固定人设',
      workspacePath: '/tmp',
      decide: async () => ({ decision: 'allow', reason: '' }),
      snapshot: async () => {},
    },
  )
  expect(model.doStreamCalls[0]!.prompt[0]).toMatchObject({
    role: 'system',
    content: '固定人设',
    providerOptions: { anthropic: { cacheControl: { type: 'ephemeral' } } },
  })
})
