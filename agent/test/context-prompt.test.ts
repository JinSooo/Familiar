import { expect, test } from 'bun:test'
import { readFile } from 'node:fs/promises'
import ts from 'typescript'
import { MockLanguageModelV4 } from 'ai/test'
import { type Message, settingsSchema } from '../../src/shared'
import { prepareModelContext } from '../src/agent/context'
import { runAgentCore } from '../src/agent/core'
import { openAiOptions } from '../src/agent'
import { toModelMessage } from '../src/attachments'

// Run the production entry point, replacing only settings, tool discovery and disk boundaries.
test('the main entry keeps a stable system prefix across time and mood changes on ChatGPT', async () => {
  const source = await readFile(
    new URL('../src/agent/index.ts', import.meta.url),
    'utf8',
  )
  const ast = ts.createSourceFile(
    'index.ts',
    source,
    ts.ScriptTarget.Latest,
    true,
  )
  const fn = ast.statements.find(
    (n) => ts.isFunctionDeclaration(n) && n.name?.text === 'runAgent',
  )!
  let now = new Date(2026, 10, 7, 14, 3)
  let mood = '你现在的心情：开心。'
  const model = new MockLanguageModelV4({
    doStream: async () => ({
      stream: new ReadableStream({
        start(c) {
          c.enqueue({
            type: 'finish',
            finishReason: { unified: 'stop', raw: 'stop' },
            usage: {
              inputTokens: {
                total: 1,
                noCache: 1,
                cacheRead: undefined,
                cacheWrite: undefined,
              },
              outputTokens: { total: 1, text: 1, reasoning: undefined },
            },
          })
          c.close()
        },
      }),
    }),
  })
  const settings = settingsSchema.parse({
    model: { protocol: 'chatgpt', model: 'test' },
  })
  const empty = () => ({})
  const noop = async () => {}
  const dependencies = {
    Date: class extends Date {
      constructor() {
        super(now.getTime())
      }
    },
    getSettings: () => settings,
    createModel: () => model,
    openAiOptions,
    ensureWorkspace: async () => '/tmp',
    snapshot: noop,
    openMemory: () => ({ store: {} }),
    listSkills: async () => [],
    mcpTools: async () => ({}),
    createImageTools: empty,
    createWorkspaceTools: empty,
    createMemoryTools: empty,
    createKnowledgeTools: empty,
    createWebTools: empty,
    createSkillTools: empty,
    createReminderTools: empty,
    createComputerTools: empty,
    activeEmbedder: noop,
    createPersona: () => '固定人设',
    personaText: async () => '',
    memoryInstructions: async () => '固定记忆',
    knowledgeInstructions: () => '知识库工具说明',
    reminderInstructions: '提醒工具说明',
    webInstructions: '网页工具说明',
    computerInstructions: '电脑工具说明',
    skillInstructions: () => '技能名单',
    imageInstructions: '',
    sourcesOf: () => [],
    knowledgeSources: () => [],
    proactiveChanged: noop,
    moodLine: () => mood,
    toModelMessage,
    prepareModelContext: (
      messages: Message[],
      options: Parameters<typeof prepareModelContext>[1],
    ) => prepareModelContext(messages, { ...options, now, mood }),
    backgroundModel: () => {
      throw new Error('short history must not need a summary')
    },
    runAgentCore,
    decideToolCall: async () => ({ decision: 'allow', reason: '' }),
    endComputerTurn: noop,
    agentError: (e: unknown) => e,
  }
  const compiled = ts.transpile(fn.getText(ast).replace(/^export /, ''), {
    target: ts.ScriptTarget.ESNext,
    module: ts.ModuleKind.None,
  })
  const run = new Function(
    ...Object.keys(dependencies),
    `${compiled}\nreturn runAgent`,
  )(...Object.values(dependencies)) as (
    messages: Message[],
    onEvent: () => void,
    signal: AbortSignal,
    id: string,
  ) => Promise<void>
  const messages: Message[] = [{ role: 'user', content: '你好' }]
  await run(messages, () => {}, new AbortController().signal, 'context-prompt')
  now = new Date(2026, 10, 7, 14, 4)
  mood = '你现在的心情：好奇。'
  await run(messages, () => {}, new AbortController().signal, 'context-prompt')
  const [first, second] = model.doStreamCalls
  expect(first!.prompt[0]).toEqual(second!.prompt[0])
  expect(first!.prompt[0]!.content).toContain('固定人设')
  expect(first!.prompt[0]!.content).not.toContain('现在是')
  expect(JSON.stringify(first!.prompt[1])).toContain('14:03')
  expect(JSON.stringify(second!.prompt[1])).toContain('14:04')
  expect(JSON.stringify(first!.prompt[1])).toContain('开心')
  expect(JSON.stringify(second!.prompt[1])).toContain('好奇')
  expect(second!.providerOptions).toEqual({
    openai: { store: false, promptCacheKey: 'familiar-context-prompt' },
  })
  expect(messages).toEqual([{ role: 'user', content: '你好' }])
})
