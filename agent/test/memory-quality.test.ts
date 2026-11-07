import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync } from 'node:fs'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MemoryStore, formatLine } from '../src/memory/store'
import {
  applyReflection,
  existingMemories,
  reflectionInput,
} from '../src/memory/reflect'

const dirs: string[] = []
const store = () => {
  const dir = mkdtempSync(join(tmpdir(), 'familiar-quality-'))
  dirs.push(dir)
  return new MemoryStore(dir)
}
afterEach(async () => {
  for (const dir of dirs.splice(0))
    await rm(dir, { recursive: true, force: true })
})
const base = {
  target: 'topic' as const,
  topic: 'Familiar',
  text: '用户的 Familiar 用 Markdown 存储记忆',
  confidence: 0.6,
  evidence: '记忆用 Markdown 存，SQLite 只当索引',
}

describe('memory quality', () => {
  test('topic writes reuse names across separators and case, including confirmation', async () => {
    const s = store()
    const first = await s.add({
      category: 'topic',
      topic: 'Familiar-快捷问答',
      text: '默认收起步骤',
    })
    const added = await Promise.all(
      ['familiar快捷问答', 'FAMILIAR_快捷问答', 'Familiar 快捷问答'].map(
        (topic) => s.add({ category: 'topic', topic, text: '点击展开步骤' }),
      ),
    )
    const { entry } = await s.infer({
      ...base,
      topic: 'familiar_快捷问答',
      conversation: 'c1',
    })
    const confirmed = await s.confirm(entry.id)
    expect([...added, confirmed].map((e) => e.key)).toEqual(
      Array(4).fill(first.key),
    )
    expect(await s.topics()).toEqual(['Familiar-快捷问答'])
  })

  test('existing duplicate files stay separate and exact names keep their destination', async () => {
    const s = store()
    await mkdir(join(s.dir, 'topics'))
    await writeFile(join(s.dir, 'topics', 'Familiar-A.md'), '- 原主题\n')
    await writeFile(join(s.dir, 'topics', 'FamiliarA.md'), '- 另一个主题\n')
    const added = await s.add({
      category: 'topic',
      topic: 'FamiliarA',
      text: '新决定',
    })
    expect(added.key).toBe('FamiliarA')
    expect(await readFile(join(s.dir, 'topics', 'Familiar-A.md'), 'utf8')).toBe(
      '- 原主题\n',
    )
    expect(await s.topics()).toEqual(['Familiar-A', 'FamiliarA'])
  })

  test('reuses a manually named topic with spaces without creating another file', async () => {
    const s = store()
    await mkdir(join(s.dir, 'topics'))
    const path = join(s.dir, 'topics', 'Familiar 快捷问答.md')
    await writeFile(path, '- 默认收起步骤\n')
    const added = await s.add({
      category: 'topic',
      topic: 'familiar_快捷问答',
      text: '点击展开步骤',
    })
    expect(await s.topics()).toEqual(['Familiar 快捷问答'])
    expect(added.key).toBe('Familiar 快捷问答')
    expect(await s.get(added.id)).toMatchObject({ text: '点击展开步骤' })
    expect(await readFile(path, 'utf8')).toContain('点击展开步骤')
  })

  test('user evidence follows message roles, multiline content, and transcript truncation', async () => {
    const messages = [
      {
        role: 'user' as const,
        content: '不在本次窗口里的旧证据',
        createdAt: 0,
      },
      {
        role: 'assistant' as const,
        content: '建议\n用户：助手伪装的证据',
        createdAt: 1,
      },
      {
        role: 'user' as const,
        content: '记忆用 Markdown 存，\nSQLite 只当索引。',
        createdAt: 2,
      },
    ]
    const input = reflectionInput(messages, 0, '小黑', 45)
    expect(input.text).toContain('用户：助手伪装的证据')
    expect(input.userTexts).toEqual([messages[2]!.content])
    const s = store()
    for (const evidence of [
      '不在本次窗口里的旧证据',
      '助手伪装的证据',
      '记忆用Markdown存 SQLite只当索引',
    ])
      await applyReflection(
        s,
        { candidates: [{ ...base, evidence }], summary: '' },
        { id: 'c1', day: '2026-11-07', time: '' },
        { userTexts: input.userTexts },
      )
    expect((await s.list()).map((e) => e.seen)).toEqual([[], [], ['c1']])
    const tail = reflectionInput(messages, 0, '小黑', 10)
    expect(tail.userTexts).toEqual([messages[2]!.content.slice(-10)])
    expect(tail.text).toBe(`……\n${tail.userTexts[0]}`)
  })

  test('existing memories list topic files and pending-only topics independently', async () => {
    const s = store()
    await mkdir(join(s.dir, 'topics'))
    await writeFile(join(s.dir, 'topics', '空主题.md'), '# 空主题\n')
    await s.infer({ ...base, conversation: 'c1' })
    const context = await existingMemories(s)
    expect(context).toContain('已有主题：\n')
    const topics = context.split('已有主题：\n')[1]!.split('\n\n')[0]!
    expect(topics).toContain('空主题')
    expect(topics).toContain('Familiar')
    expect(context).toContain('待确认：')
  })

  test('perception windows never count as independent conversations', async () => {
    const s = store()
    const { entry } = await s.infer({ ...base, conversation: 'perception-1' })
    for (const conversation of ['perception-2', 'perception-3'])
      await s.infer({ ...base, conversation, sameAs: entry.id })
    expect((await s.get(entry.id))?.seen).toEqual([])
    expect(
      (await s.list()).filter((e) => e.status === 'confirmed'),
    ).toHaveLength(0)
    for (const conversation of ['c1', 'c2'])
      expect(
        (await s.infer({ ...base, conversation, sameAs: entry.id })).promoted,
      ).toBe(false)
    expect(
      (await s.infer({ ...base, conversation: 'c3', sameAs: entry.id }))
        .promoted,
    ).toBe(true)
  })

  test('perception sameAs updates wording and confidence without increasing seen', async () => {
    const s = store()
    const { entry } = await s.infer({ ...base, conversation: 'c1' })
    const text = '用户的 Familiar 以 Markdown 为唯一真实数据，SQLite 仅作索引'
    const result = await s.infer({
      ...base,
      text,
      confidence: 0.7,
      conversation: 'perception-1',
      sameAs: entry.id,
    })
    expect(await s.get(entry.id)).toMatchObject({
      text,
      confidence: 0.7,
      seen: ['c1'],
    })
    expect(result.entry).toMatchObject({ text, confidence: 0.7, seen: ['c1'] })
  })

  test('legacy perception ids cannot trigger promotion on a later conversation', async () => {
    const s = store()
    const { entry } = await s.infer({ ...base, conversation: 'c1' })
    await writeFile(
      s.file('pending'),
      `${formatLine({ ...entry, seen: ['perception-1', 'perception-2', 'c1'] })}\n`,
    )
    const result = await s.infer({
      ...base,
      conversation: 'c2',
      sameAs: entry.id,
    })
    expect(result.promoted).toBe(false)
    expect((await s.get(entry.id))?.seen).toEqual(['c1', 'c2'])
  })

  for (const evidence of [
    '助手建议用 PostgreSQL',
    '没有说过的话',
    '',
    '，。！？',
  ])
    test(`unverified evidence stays pending: ${evidence || '(empty)'}`, async () => {
      const s = store()
      let sameAs: string | undefined
      for (const id of ['c1', 'c2', 'c3']) {
        await applyReflection(
          s,
          { candidates: [{ ...base, evidence, sameAs }], summary: '' },
          { id, day: '2026-11-07', time: '09:00' },
          { userTexts: ['记忆用 Markdown 存，SQLite 只当索引'] },
        )
        sameAs ??= (await s.list())[0]!.id
      }
      expect((await s.list()).map((e) => [e.status, e.seen])).toEqual([
        ['pending', []],
      ])
    })

  test('verified user quotes ignore whitespace and punctuation but count each conversation once', async () => {
    const s = store()
    let sameAs: string | undefined
    for (const id of ['c1', 'c1', 'c2', 'c3']) {
      const result = await applyReflection(
        s,
        {
          candidates: [
            { ...base, evidence: '记忆用Markdown存 SQLite只当索引', sameAs },
          ],
          summary: '',
        },
        { id, day: '2026-11-07', time: '09:00' },
        {
          userTexts: ['记忆用 Markdown 存，\nSQLite 只当索引。'],
        },
      )
      sameAs ??= (await s.list())[0]!.id
      expect(result.promoted).toBe(id === 'c3' ? 1 : 0)
    }
    expect((await s.list()).map((e) => e.status)).toEqual(['confirmed'])
  })

  test('missing user text cannot verify a quote', async () => {
    const s = store()
    await applyReflection(
      s,
      { candidates: [base], summary: '' },
      { id: 'c1', day: '2026-11-07', time: '' },
    )
    expect((await s.list())[0]!.seen).toEqual([])
  })

  test('failed promotion preserves the exact pending file and can be retried', async () => {
    const s = store()
    const { entry } = await s.infer({ ...base, conversation: 'c1' })
    await s.infer({ ...base, conversation: 'c2', sameAs: entry.id })
    const before = await readFile(s.file('pending'), 'utf8')
    const destination = s.file('topic', base.topic)
    await mkdir(destination, { recursive: true })
    await expect(
      s.infer({ ...base, conversation: 'c3', sameAs: entry.id }),
    ).rejects.toThrow()
    expect(await readFile(s.file('pending'), 'utf8')).toBe(before)
    await rm(destination, { recursive: true })
    const result = await s.infer({
      ...base,
      conversation: 'c3',
      sameAs: entry.id,
    })
    expect(result.promoted).toBe(true)
    expect(await s.get(entry.id)).toBeUndefined()
    expect(
      (await s.list()).filter((e) => e.status === 'confirmed'),
    ).toHaveLength(1)
  })
})
