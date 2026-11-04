import { describe, expect, test } from 'bun:test'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Session } from '../../src/shared'
import {
  listConversations,
  loadConversation,
  parse,
  saveConversation,
  serialize,
} from '../src/conversations'
import { conversationsDir } from '../src/system'

const at = Date.parse('2026-10-27T01:34:00Z')
const session = (id: string, messages: Session['messages']): Session => ({
  id,
  updatedAt: at + 9000,
  messages,
  tools: [],
  running: false,
  approvals: [],
  error: '',
  origin: 'chat',
  bubble: '',
})

describe('Markdown round trip', () => {
  // Content a model really produces: headings, fenced code with blank lines, and a line that
  // looks like our own metadata comment.
  const messages: Session['messages'] = [
    { role: 'user', content: '帮我读一下 notes\n第二行', createdAt: at },
    {
      role: 'assistant',
      content:
        '## 标题\n\n```ts\nconst a = 1\n\n\nconst b = 2\n```\n\n<!-- familiar {"role":"user","at":1} --> 不是标记',
      createdAt: at + 1000,
    },
    { role: 'user', content: '测试 503', createdAt: at + 2000 },
    {
      role: 'assistant',
      content: '',
      createdAt: at + 2000,
      error: '模型服务暂时不可用',
    },
  ]
  const tools: Session['tools'] = [
    { id: 'x', name: '读取 notes.txt', done: true, turn: 1 },
  ]
  const text = serialize(
    {
      id: 'c1',
      title: '帮我读一下 notes',
      createdAt: at,
      updatedAt: at + 9000,
      messages,
      tools,
    },
    '小黑',
  )

  test('messages, errors, tools and times survive', () => {
    const back = parse('c1', text)
    // The look-alike marker sits mid-line, so it must stay inside the reply.
    expect(back.messages).toEqual(messages)
    expect(
      back.tools.map(({ name, done, turn }) => ({ name, done, turn })),
    ).toEqual([{ name: '读取 notes.txt', done: true, turn: 1 }])
    expect(back.updatedAt).toBe(at + 9000)
    expect(back.title).toBe('帮我读一下 notes')
  })

  test('the file reads as a transcript', () => {
    expect(text).toContain('**小黑**')
    expect(text).toContain('已读取 notes.txt')
    expect(text).toContain('出错：模型服务暂时不可用')
  })

  test('a reader editing the visible header line does not break parsing', () => {
    const edited = text.replace('**你** ·', '**我** (edited) ·')
    expect(parse('c1', edited).messages[0]?.content).toBe(
      '帮我读一下 notes\n第二行',
    )
  })
})

describe('files on disk', () => {
  test('save, load, search and newest-first listing', async () => {
    await saveConversation(
      session('2026-10-25-0900-aaaa', [
        { role: 'user', content: '周末去哪玩', createdAt: at - 9e6 },
        { role: 'assistant', content: '公园晒太阳', createdAt: at - 9e6 },
      ]),
      '小黑',
    )
    await saveConversation(
      session('2026-10-27-0134-bbbb', [
        { role: 'user', content: '写请假邮件', createdAt: at },
        { role: 'assistant', content: '草稿如下', createdAt: at },
      ]),
      '小黑',
    )
    expect((await listConversations()).map((c) => c.title)).toEqual([
      '写请假邮件',
      '周末去哪玩',
    ])
    expect((await listConversations('公园')).map((c) => c.id)).toEqual([
      '2026-10-25-0900-aaaa',
    ])
    const loaded = await loadConversation('2026-10-27-0134-bbbb')
    expect(loaded.messages.map((m) => m.content)).toEqual([
      '写请假邮件',
      '草稿如下',
    ])
    const raw = await readFile(
      join(conversationsDir, '2026-10-27-0134-bbbb.md'),
      'utf8',
    )
    expect(raw.startsWith('---\ntitle: "写请假邮件"')).toBe(true)
  })

  test('ids cannot point outside the conversations folder', async () => {
    expect(loadConversation('../../etc/passwd')).rejects.toThrow('对话编号无效')
  })

  test('an empty conversation is not written', async () => {
    await saveConversation(session('2026-10-27-0200-cccc', []), '小黑')
    expect((await listConversations()).some((c) => c.id.endsWith('cccc'))).toBe(
      false,
    )
  })
})

describe('reply order', () => {
  // User report: sources all sat under the reply and tool steps all sat above it, not where
  // they happened. Each one now records how much of the reply text came before it.
  test('tool steps, sources and files show where they happened, also after a save', async () => {
    const { emptySession, reduceSession } = await import('../src/session')
    const { replyParts } = await import('../../src/renderer/chat/content')
    let s: Session = {
      ...emptySession(),
      id: 'c',
      messages: [
        { role: 'user', content: '查一下再画', createdAt: 1 },
        { role: 'assistant', content: '', createdAt: 2 },
      ],
    }
    const events: Parameters<typeof reduceSession>[1][] = [
      { type: 'text-delta', text: '我先搜一下。' },
      {
        type: 'tool-call',
        id: 't1',
        toolName: 'web_search',
        input: { query: 'react' },
      },
      { type: 'tool-result', id: 't1', output: '' },
      { type: 'sources', sources: [{ url: 'https://a.com', title: 'A' }] },
      { type: 'text-delta', text: '搜到了，现在画图。' },
      {
        type: 'attachment',
        attachment: {
          path: 'c/cat.png',
          name: 'cat.png',
          mediaType: 'image/png',
        },
      },
      { type: 'text-delta', text: '画好了。' },
    ]
    for (const e of events) s = reduceSession(s, e)
    const back = parse(
      'c',
      serialize(
        {
          id: 'c',
          title: 't',
          createdAt: 1,
          updatedAt: 2,
          messages: s.messages,
          tools: s.tools,
        },
        '小黑',
      ),
    )
    const reply = back.messages[1]!
    const order = replyParts(
      reply.content,
      back.tools,
      reply.sources ?? [],
      reply.attachments ?? [],
    ).map((p) => (p.kind === 'text' ? p.text : p.kind))
    expect(order).toEqual([
      '我先搜一下。',
      'tools',
      'sources',
      '搜到了，现在画图。',
      'files',
      '画好了。',
    ])
  })

  test('older transcripts without positions keep steps first and sources last', async () => {
    const { replyParts } = await import('../../src/renderer/chat/content')
    const order = replyParts(
      '回答',
      [{ id: 'x', name: '搜索', done: true }],
      [{ url: 'https://a.com', title: 'A' }],
      [],
    ).map((p) => p.kind)
    expect(order).toEqual(['tools', 'text', 'sources'])
  })
})

describe('resending', () => {
  // User report: a failed reply could not be sent again, and nothing could be rolled back.
  test('rewinding to a message drops it, what followed and their tool rows', async () => {
    const { rewind } = await import('../src/session')
    const s: Session = {
      ...session('r', [
        { role: 'user', content: '第一句', createdAt: 1 },
        { role: 'assistant', content: '好', createdAt: 2 },
        {
          role: 'user',
          content: '第二句',
          createdAt: 3,
          attachments: [
            { path: 'r/a.png', name: 'a.png', mediaType: 'image/png' },
          ],
        },
        { role: 'assistant', content: '', createdAt: 4, error: '断了' },
      ]),
      tools: [
        { id: 'a', name: '搜索', done: true, turn: 1 },
        { id: 'b', name: '搜索', done: true, turn: 3 },
      ],
    }
    const back = rewind(s, 2)
    expect(back.message.content).toBe('第二句')
    expect(back.message.attachments?.[0]?.name).toBe('a.png')
    expect(back.session.messages.map((m) => m.content)).toEqual([
      '第一句',
      '好',
    ])
    expect(back.session.tools.map((t) => t.id)).toEqual(['a'])
    expect(() => rewind(s, 1)).toThrow()
  })
})

// Reported 2026-11-04: a command in the conversation showed cut off with "…" and what it
// returned could not be seen at all. Both are kept now, and come back from the file.
describe('tool steps', () => {
  test('the whole command and its output survive a save, even an output with "-->"', () => {
    const command = `grep -rn "needle" ${'src/very/long/path/'.repeat(5)}file.ts`
    const output = 'line 1\n<!-- not a marker --> still output\nline 3'
    const tools: Session['tools'] = [
      {
        id: 't',
        name: '执行命令 grep…',
        done: true,
        turn: 1,
        detail: command,
        output,
      },
    ]
    const text = serialize(
      {
        id: 'c2',
        title: 't',
        createdAt: at,
        updatedAt: at,
        messages: [
          { role: 'user', content: '找一下', createdAt: at },
          { role: 'assistant', content: '找到了', createdAt: at + 1000 },
        ],
        tools,
      },
      '小黑',
    )
    const back = parse('c2', text).tools[0]
    expect(back?.detail).toBe(command)
    expect(back?.output).toBe(output)
    expect(parse('c2', text).messages[1]?.content).toBe('找到了')
  })
})

describe('a running turn', () => {
  test('a tool step keeps the whole command and what came back', async () => {
    const { emptySession, reduceSession, beginTurn } =
      await import('../src/session')
    const command = `ls -la ${'/some/deep/folder'.repeat(4)}`
    let s = beginTurn(emptySession(), '看看', 'chat', [])
    s = reduceSession(s, {
      type: 'tool-call',
      id: 'a',
      toolName: 'run_shell',
      input: { command },
    })
    s = reduceSession(s, { type: 'tool-result', id: 'a', output: 'total 0' })
    expect(s.tools[0]?.name.endsWith('…')).toBe(true)
    expect(s.tools[0]?.detail).toBe(command)
    expect(s.tools[0]?.output).toBe('total 0')
  })
})

// Reported 2026-11-04: a command's result showed as escaped JSON ({"output":"…","exitCode":0}).
describe('a command result', () => {
  test('shows what it printed, and how it ended only when not cleanly', async () => {
    const { commandText } = await import('../src/agent/core')
    const run = (rest: object) => ({
      output: 'a\nb\n',
      exitCode: 0,
      signal: null,
      timedOut: false,
      ...rest,
    })
    expect(commandText(run({}))).toBe('a\nb')
    expect(commandText(run({ exitCode: 2 }))).toBe('a\nb\n（退出码 2）')
    expect(commandText(run({ timedOut: true }))).toContain('超时')
    expect(commandText({ path: 'x' })).toBeUndefined()
  })
})
