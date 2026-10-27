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
