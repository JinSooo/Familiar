import { expect, test } from 'bun:test'
import { readFile } from 'node:fs/promises'
import ts from 'typescript'
import { z } from 'zod'
import { IPC, type AgentEvent, type Session } from '../../src/shared'
import {
  emptySession,
  beginTurn,
  reduceSession,
  modelHistory,
  rewind,
} from '../src/session'
import { optionalArg } from '../src/ipc-args'

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((r) => {
    resolve = r
  })
  return { promise, resolve }
}

// Execute the actual IPC/run functions, replacing disk/model/UI boundaries only.
async function fixture() {
  const file = await readFile(
    new URL('../src/main.ts', import.meta.url),
    'utf8',
  )
  const ast = ts.createSourceFile('main.ts', file, ts.ScriptTarget.Latest, true)
  const names = new Set([
    'withSessionOperation',
    'run',
    'resend',
    'branch',
    'openConversation',
    'turn',
    'request',
    'requireSender',
    'startFresh',
  ])
  const functions = ast.statements
    .filter(
      (n) => ts.isFunctionDeclaration(n) && n.name && names.has(n.name.text),
    )
    .map((n) => n.getText(ast))
    .join('\n')
  const disk = deferred(),
    model = deferred()
  const runs: string[] = [],
    events: ((event: AgentEvent) => void)[] = []
  let id = 0
  const noop = () => {}
  const dependencies = {
    z,
    IPC,
    Buffer,
    AbortController,
    emptySession,
    beginTurn,
    reduceSession,
    modelHistory,
    rewind,
    optionalArg,
    uploadSchema: z.array(z.object({ name: z.string(), data: z.string() })),
    messageText: z.string(),
    saveAttachment: async () => {
      await disk.promise
      return { name: 'a.txt', path: 'a', mediaType: 'text/plain' }
    },
    loadConversation: async () => {
      await disk.promise
      return { ...emptySession(), id: 'loaded' }
    },
    saveConversation: async () => {
      await disk.promise
    },
    readAttachment: async () => Buffer.from('a'),
    deleteConversation: async () => {
      await disk.promise
    },
    clearConversations: async () => {
      await disk.promise
    },
    updateMcpServer: async () => {
      await disk.promise
    },
    grantedRule: () => undefined,
    resolveApproval: noop,
    newConversationId: () => `id-${++id}`,
    getSettings: () => ({ pet: { name: '小黑' } }),
    runAgent: async (
      messages: { content: string }[],
      emit: (e: AgentEvent) => void,
    ) => {
      runs.push(messages.at(-1)!.content)
      events.push(emit)
      await model.promise
      emit({ type: 'text-delta', text: '回复' })
      emit({ type: 'finish' })
    },
    clearTimeout: noop,
    setTimeout: noop,
    persist: noop,
    publishSession: noop,
    restartIfIdle: noop,
    noteConversation: noop,
    refreshMood: noop,
    refreshState: noop,
    broadcast: noop,
    memoryChanged: noop,
    reflectSoon: noop,
    conversationTitle: () => '旧对话',
    expandTo: () => undefined,
    shouldExpand: () => false,
    bubbleTimeout: () => 0,
    emit: noop,
    setCapsule: noop,
  }
  const source = `let controller, operationDone, bubbleTimer, openedAt, chattedAt, failedAt, turnWindow;
    let session = emptySession(), resetRequested = false, expandedTurn = false;
    const activity = {}, pendingApprovals = new Set();
    const mainVisible = false, chatVisible = false, chatFocused = false, mainFocused = false;
    ${functions}
    return { run, resend, branch, openConversation, request, getSession: () => session,
      seed: value => { session = value }, activity: () => ({...activity}), busy: () => !!controller };`
  const js = new Bun.Transpiler({ loader: 'ts' }).transformSync(source)
  const api = new Function(...Object.keys(dependencies), js)(
    ...Object.values(dependencies),
  ) as {
    run: (window: string, text: string, files?: unknown[]) => Promise<void>
    resend: (window: string, index: number, input?: unknown) => Promise<void>
    branch: (index: number) => Promise<void>
    openConversation: (id: string) => Promise<void>
    request: (message: {
      channel: string
      args: unknown[]
      window: string
    }) => Promise<unknown>
    getSession: () => Session
    seed: (session: Session) => void
    activity: () => Record<string, boolean>
    busy: () => boolean
  }
  return { ...api, disk, model, runs, events }
}

test('attachment preparation owns the turn before another window can send', async () => {
  const f = await fixture()
  const first = f.run('quick', 'A', [{ name: 'a.txt', data: 'YQ==' }])
  try {
    await expect(
      Promise.race([f.run('main', 'B'), Bun.sleep(60)]),
    ).rejects.toThrow('已有对话正在运行')
    expect(f.busy()).toBe(true)
    f.disk.resolve()
    await Bun.sleep(0)
    expect(f.runs).toHaveLength(1)
    expect(f.getSession().messages[0]?.content).toBe('A')
  } finally {
    f.disk.resolve()
    f.model.resolve()
    await first
  }
  expect(f.busy()).toBe(false)
  expect(f.getSession().messages.map((m) => m.content)).toEqual(['A', '回复'])
})

test.each(['open', 'branch', 'clear', 'delete'])(
  '%s holds the session across disk awaits',
  async (operation) => {
    const f = await fixture()
    f.seed({
      ...emptySession(),
      id: 'old',
      messages: [{ role: 'user', content: 'old', createdAt: 0 }],
    })
    const task =
      operation === 'open'
        ? f.openConversation('old')
        : operation === 'branch'
          ? f.branch(0)
          : f.request({
              channel:
                operation === 'clear'
                  ? IPC.conversationsClear
                  : IPC.conversationsDelete,
              args: ['old'],
              window: operation === 'clear' ? 'settings' : 'main',
            })
    try {
      await expect(
        Promise.race([f.run('main', 'B'), Bun.sleep(60)]),
      ).rejects.toThrow('已有对话正在运行')
      await expect(
        Promise.race([f.resend('main', 0), Bun.sleep(60)]),
      ).rejects.toThrow('已有对话正在运行')
    } finally {
      f.disk.resolve()
      f.model.resolve()
      await task
    }
  },
)

test('new conversation cancels attachment preparation without resurrecting the old turn', async () => {
  const f = await fixture()
  const first = f.run('quick', 'A', [{ name: 'a.txt', data: 'YQ==' }])
  const reset = f.request({ channel: IPC.sessionNew, args: [], window: 'main' })
  f.disk.resolve()
  f.model.resolve()
  await Promise.all([first, reset])
  expect(f.runs).toEqual([])
  expect(f.getSession().messages).toEqual([])
  expect(f.busy()).toBe(false)
  await f.run('main', 'B')
  expect(f.getSession().messages.map((m) => m.content)).toEqual(['B', '回复'])
})

test('new conversation waits for a running model and ignores late events', async () => {
  const f = await fixture()
  const first = f.run('main', 'A')
  const reset = f.request({ channel: IPC.sessionNew, args: [], window: 'main' })
  try {
    await expect(
      Promise.race([f.run('main', 'B'), Bun.sleep(60)]),
    ).rejects.toThrow()
  } finally {
    f.model.resolve()
    await Promise.all([first, reset])
  }
  expect(f.getSession().messages).toEqual([])
  await f.run('main', 'B')
  f.events[0]!({ type: 'text-delta', text: '旧轮迟到内容' })
  expect(f.getSession().messages.map((m) => m.content)).toEqual(['B', '回复'])
})

test('an approval finishing after reset cannot change the next session activity', async () => {
  const f = await fixture()
  const first = f.run('main', 'A')
  f.events[0]!({
    type: 'tool-approval-request',
    id: 'approval',
    toolName: 'mcp__test',
    input: {},
    reason: '',
    server: 'test',
  })
  const approval = f.request({
    channel: IPC.approval,
    args: ['approval', 'always'],
    window: 'main',
  })
  const reset = f.request({ channel: IPC.sessionNew, args: [], window: 'main' })
  f.model.resolve()
  await Promise.all([first, reset])
  expect(f.activity().thinking).toBe(false)
  f.disk.resolve()
  await approval
  expect(f.activity().thinking).toBe(false)
  expect(f.getSession().approvals).toEqual([])
})
