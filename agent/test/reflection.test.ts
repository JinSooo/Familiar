import { describe, expect, test } from 'bun:test'
import { mkdtempSync } from 'node:fs'
import { mkdir, readFile, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MockLanguageModelV4 } from 'ai/test'
import { MemoryStore } from '../src/memory'
import {
  applyReflection,
  parseReflection,
  reflectOn,
  transcript,
} from '../src/memory/reflect'
import { compressTimeline, dueRollUps, isoWeek } from '../src/memory/timeline'

const store = () =>
  new MemoryStore(mkdtempSync(join(tmpdir(), 'familiar-mem-')))
const reply = (text: string) =>
  new MockLanguageModelV4({
    doGenerate: async () => ({
      content: [{ type: 'text', text }],
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
      warnings: [],
    }),
  })

describe('pending inferences', () => {
  test('confirming moves it to its target; seen in 3 conversations keeps it', async () => {
    const s = store()
    const base = {
      target: 'profile' as const,
      text: '用户是前端工程师',
      confidence: 0.6,
      evidence: '我做前端的',
    }
    const { entry } = await s.infer({ ...base, conversation: 'c1' })
    expect(entry.status).toBe('pending')
    await s.infer({ ...base, conversation: 'c1', sameAs: entry.id })
    expect((await s.get(entry.id))?.seen).toEqual(['c1'])
    await s.infer({ ...base, conversation: 'c2', sameAs: entry.id })
    const third = await s.infer({
      ...base,
      conversation: 'c3',
      sameAs: entry.id,
    })
    expect(third.promoted).toBe(true)
    const all = await s.list()
    expect(all.filter((e) => e.status === 'pending')).toEqual([])
    expect(all.find((e) => e.category === 'profile')).toMatchObject({
      text: '用户是前端工程师',
      source: 'reflection',
    })

    const other = await s.infer({
      ...base,
      target: 'topic',
      topic: '学 Rust',
      text: '用户在学 Rust',
      conversation: 'c4',
    })
    await s.confirm(other.entry.id, '用户在系统地学 Rust')
    expect((await s.list()).find((e) => e.category === 'topic')).toMatchObject({
      key: '学-Rust',
      text: '用户在系统地学 Rust',
    })
  })

  test('correcting a kept memory keeps the old one struck through', async () => {
    const s = store()
    const kept = await s.add({ category: 'habits', text: '晚上写代码' })
    const next = await s.correct(kept.id, '早上写代码')
    expect((await s.get(kept.id))?.by).toBe(next.id)
    await expect(s.correct(next.id + 'x', 'y')).rejects.toThrow()
  })
})

describe('reflection', () => {
  test('parses JSON around chatter and drops bad candidates', () => {
    const r = parseReflection(
      '好的：\n```json\n{"candidates":[{"target":"habits","text":"用户每天跑步","confidence":0.9,"evidence":"我每天跑步"},{"target":"nope","text":"x","confidence":2}],"summary":"聊了跑步"}\n```',
    )
    expect(r.candidates.map((c) => c.text)).toEqual(['用户每天跑步'])
    expect(r.summary).toBe('聊了跑步')
    expect(() => parseReflection('没有内容')).toThrow()
  })

  test('applies candidates into pending and the summary into the day', async () => {
    const s = store()
    const model = reply(
      '{"candidates":[{"target":"profile","text":"用户住在杭州","confidence":0.8,"evidence":"我在杭州"},{"target":"profile","text":"用户密码是 hunter2","confidence":0.9},{"target":"topic","text":"缺主题名","confidence":0.5}],"summary":"问了杭州天气"}',
    )
    const reflection = await reflectOn(model, '用户：我在杭州，天气怎样', '')
    const applied = await applyReflection(s, reflection, {
      id: 'c1',
      day: '2026-10-27',
      time: '09:30',
    })
    expect(applied).toEqual({ pending: 1, promoted: 0, timeline: true })
    const entries = await s.list()
    expect(entries.map((e) => [e.category, e.text])).toEqual([
      ['pending', '用户住在杭州'],
      ['timeline', '09:30 问了杭州天气'],
    ])
    // The timeline line remembers which conversation it came from, so it can be reopened.
    expect(entries[1]!.conversation).toBe('c1')
    expect(entries[0]!.conversation).toBeUndefined()
    // The conversation goes in the prompt, marked as data.
    const prompt = JSON.stringify(model.doGenerateCalls[0]!.prompt)
    expect(prompt).toContain('<conversation>')
  })

  test('with the timeline off, only the candidates are stored', async () => {
    const s = store()
    const reflection = {
      candidates: [
        {
          target: 'profile' as const,
          text: '用户住在杭州',
          confidence: 0.8,
          evidence: '我在杭州',
        },
      ],
      summary: '问了杭州天气',
    }
    const applied = await applyReflection(
      s,
      reflection,
      { id: 'c1', day: '2026-10-27', time: '09:30' },
      { timeline: false },
    )
    expect(applied).toEqual({ pending: 1, promoted: 0, timeline: false })
    expect((await s.list()).map((e) => e.category)).toEqual(['pending'])
  })

  test('transcript starts two messages before the new part', () => {
    const m = (role: 'user' | 'assistant', content: string) => ({
      role,
      content,
      createdAt: 0,
    })
    const text = transcript(
      [
        m('user', 'a'),
        m('assistant', 'b'),
        m('user', 'c'),
        m('assistant', 'd'),
        m('user', 'e'),
      ],
      4,
      '小黑',
    )
    expect(text).toBe('用户：c\n\n小黑：d\n\n用户：e')
  })
})

describe('timeline roll-up', () => {
  test('ISO weeks', () => {
    expect(isoWeek(new Date(2026, 9, 27)).key).toBe('2026-W44')
    expect(isoWeek(new Date(2027, 0, 1)).key).toBe('2026-W53')
    expect(isoWeek(new Date(2026, 0, 1)).key).toBe('2026-W01')
  })

  test('finished weeks roll up; months wait for their days', () => {
    const now = new Date(2026, 10, 10) // Tue of 2026-W46
    expect(
      dueRollUps(['2026-10-26', '2026-10-28', '2026-11-10', '2026-W43'], now),
    ).toEqual([
      { into: '2026-W44', from: ['2026-10-26', '2026-10-28'], kind: 'week' },
    ])
    expect(dueRollUps(['2026-W43', '2026-W44', '2026-11-10'], now)).toEqual([
      { into: '2026-10', from: ['2026-W43', '2026-W44'], kind: 'month' },
    ])
  })

  // 09-28's week has its Thursday in October, so by ISO rules it belongs to October.
  test('days become a week, weeks become a month, files go', async () => {
    const s = store()
    await s.appendTimeline('2026-09-28', '10:00 修了宠物拖动')
    await s.appendTimeline('2026-09-30', '21:00 读 AI SDK 文档')
    await s.appendTimeline('2026-11-10', '09:00 今天的事')
    expect(await compressTimeline(s, undefined, new Date(2026, 10, 10))).toBe(2)
    expect(await s.periods()).toEqual(['2026-10', '2026-11-10'])
    expect(
      (await s.list()).filter((e) => e.key === '2026-10').map((e) => e.text),
    ).toEqual(['09-28 10:00 修了宠物拖动', '09-30 21:00 读 AI SDK 文档'])
    expect((await readdir(join(s.dir, 'timeline'))).sort()).toEqual([
      '2026-10.md',
      '2026-11-10.md',
    ])
  })

  test('merged lines keep the conversations they came from, through week and month', async () => {
    const s = store()
    await s.appendTimeline('2026-09-28', '10:00 修了宠物拖动', undefined, 'c1')
    await s.appendTimeline('2026-09-29', '11:00 聊了 Rust', undefined, 'c2')
    await s.appendTimeline('2026-09-30', '21:00 读 AI SDK 文档')
    await s.appendTimeline('2026-11-10', '09:00 今天的事', undefined, 'c9')
    await compressTimeline(s, undefined, new Date(2026, 10, 10))
    const month = (await s.list()).filter((e) => e.key === '2026-10')
    expect(month).toHaveLength(3)
    // The week and the month are both rolled up in one pass, so the ids survive two merges.
    for (const e of month) {
      expect(e.conversation).toBeUndefined()
      expect(e.conversations).toEqual(['c1', 'c2'])
    }
    // A day that is still open is not merged and keeps its own single id.
    const today = (await s.list()).find((e) => e.key === '2026-11-10')!
    expect(today.conversation).toBe('c9')
    expect(today.conversations).toBeUndefined()
  })

  test('a roll-up of days without conversations adds no ids', async () => {
    const s = store()
    await s.appendTimeline('2026-09-28', '10:00 修了宠物拖动')
    await compressTimeline(s, undefined, new Date(2026, 10, 10))
    const [line] = (await s.list()).filter((e) => e.key === '2026-10')
    expect(line!.conversations).toBeUndefined()
  })

  test('long weeks are summarized by the model', async () => {
    const s = store()
    await mkdir(join(s.dir, 'timeline'), { recursive: true })
    for (let d = 19; d <= 25; d++)
      for (const h of ['09', '14'])
        await s.appendTimeline(`2026-10-${d}`, `${h}:00 事情 ${d}-${h}`)
    const model = reply('{"lines":["这周主要在做 P0.5","修了很多界面问题"]}')
    await compressTimeline(s, model, new Date(2026, 9, 27))
    expect(await s.periods()).toEqual(['2026-W43'])
    expect(await readFile(s.file('timeline', '2026-W43'), 'utf8')).toContain(
      '- 这周主要在做 P0.5',
    )
    expect(JSON.stringify(model.doGenerateCalls[0]!.prompt)).toContain(
      '10-19 09:00 事情 19-09',
    )
  })
})

describe('forgetting during reflection', () => {
  test('a reflection does not write back what was just deleted', async () => {
    const s = store()
    const city = await s.add({
      category: 'profile',
      text: '用户最喜欢的城市是京都',
    })
    await s.remove(city.id)
    const applied = await applyReflection(
      s,
      {
        candidates: [
          {
            target: 'profile',
            text: '用户最喜欢京都这座城市',
            confidence: 0.9,
            evidence: '',
          },
          {
            target: 'habits',
            text: '用户每天午饭后散步',
            confidence: 0.8,
            evidence: '',
          },
        ],
        summary: '用户让助手记住最喜欢的城市是京都',
      },
      { id: 'c1', day: '2026-10-27', time: '22:38' },
    )
    expect(applied).toEqual({ pending: 1, promoted: 0, timeline: false })
    expect((await s.list()).map((e) => e.text)).toEqual(['用户每天午饭后散步'])
  })
})
