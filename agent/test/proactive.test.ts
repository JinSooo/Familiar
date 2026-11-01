import { describe, expect, test } from 'bun:test'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  settingsSchema,
  type PerceptionEvent,
  type ProactiveMessage,
} from '../../src/shared'
import { parseDecision } from '../src/proactive/decide'
import {
  formatReminders,
  parseReminders,
  readReminders,
  updateReminders,
} from '../src/proactive/reminders'
import {
  breakpoint,
  budget,
  candidates,
  inQuietHours,
  pace,
} from '../src/proactive/rules'
import { createReminderTools } from '../src/proactive/state'
import { dataDir } from '../src/system'

const defaults = settingsSchema.parse({}).proactive
const at = (h: number, m = 0) => new Date(2026, 10, 2, h, m).getTime()
const minute = 60000

describe('reminders file', () => {
  test('round trip, and lines the user wrote by hand count', () => {
    const text = formatReminders([
      { id: 'a', at: at(10), text: '交周报', kind: 'reminder' },
      { id: 'b', at: at(9), text: '问面试', kind: 'follow-up', done: at(9, 1) },
    ])
    expect(text.indexOf('问面试')).toBeLessThan(text.indexOf('交周报'))
    const back = parseReminders(`${text}- [ ] 2026-11-03 08:30 买牛奶\n`)
    expect(back.map((r) => [r.text, r.kind, Boolean(r.done)])).toEqual([
      ['问面试', 'follow-up', true],
      ['交周报', 'reminder', false],
      ['买牛奶', 'reminder', false],
    ])
  })

  test('the remind tool writes a line and refuses times already past', async () => {
    const tools = createReminderTools(() => {})
    const run = (input: unknown) =>
      (tools.remind!.execute as (i: unknown, o: unknown) => Promise<unknown>)(
        input,
        {},
      )
    const later = new Date(Date.now() + 3600000)
    const pad = (n: number) => String(n).padStart(2, '0')
    const when = `${later.getFullYear()}-${pad(later.getMonth() + 1)}-${pad(later.getDate())} ${pad(later.getHours())}:${pad(later.getMinutes())}`
    expect(await run({ at: when, text: '喝水' })).toMatchObject({
      text: '喝水',
    })
    expect(await run({ at: '2020-01-01 10:00', text: '旧的' })).toEqual({
      error: '这个时间已经过去了',
    })
    expect((await readReminders()).map((r) => r.text)).toContain('喝水')
    expect(await readFile(join(dataDir, 'reminders.md'), 'utf8')).toContain(
      `- [ ] ${when} 喝水`,
    )
    await updateReminders(() => ({ list: [], result: undefined }))
  })
})

const said = (
  h: number,
  response?: ProactiveMessage['response'],
): ProactiveMessage => ({
  id: `m${h}`,
  at: at(h),
  trigger: 'longWork',
  text: 'x',
  reason: 'y',
  ...(response ? { response } : {}),
})

describe('budget', () => {
  test('quiet hours wrap past midnight', () => {
    const quiet = { enabled: true, from: '23:00', to: '08:00' }
    expect(inQuietHours(quiet, new Date(at(23, 30)))).toBe(true)
    expect(inQuietHours(quiet, new Date(at(7, 59)))).toBe(true)
    expect(inQuietHours(quiet, new Date(at(8)))).toBe(false)
    expect(inQuietHours({ ...quiet, enabled: false }, new Date(at(2)))).toBe(
      false,
    )
  })

  test('a level sets the pace; reminders do not use it; 别烦我 holds', () => {
    const normal = { ...defaults, level: 'normal' as const }
    const run = (
      history: ProactiveMessage[],
      now: number,
      quietUntil?: number,
    ) => budget({ settings: normal, history, days: {}, now, quietUntil }).reason
    expect(run([], at(10))).toBeUndefined()
    expect(run([said(10)], at(10, 30))).toBe('刚说过不久')
    expect(run([said(14), said(13), said(12), said(11)], at(17))).toBe(
      '今天说得够多了',
    )
    const reminders = [14, 13, 12, 11].map((h) => ({
      ...said(h),
      trigger: 'reminder' as const,
    }))
    expect(run(reminders, at(17))).toBeUndefined()
    expect(run([], at(10), at(24))).toBe('你说了别烦我')
    expect(
      budget({
        settings: { ...normal, enabled: false },
        history: [],
        days: {},
        now: at(10),
      }).reason,
    ).toBe('主动发言已关闭')
  })

  test('levels differ; the last three days of answers move them', () => {
    const p = (
      level: typeof defaults.level,
      history: ProactiveMessage[] = [],
    ) => pace({ level, history, days: {}, now: at(12) })
    expect(p('quiet')).toEqual({ perDay: 2, gapMinutes: 120 })
    expect(p('normal')).toEqual({ perDay: 4, gapMinutes: 60 })
    expect(p('chatty')).toEqual({ perDay: 6, gapMinutes: 30 })
    // 别烦我 counts twice, 没理 once, never below one.
    expect(p('normal', [said(9, 'quiet'), said(10, 'ignored')]).perDay).toBe(1)
    expect(p('normal', [said(9, 'ok'), said(10, 'ok')]).perDay).toBe(5)
  })

  test('自动 follows how much the user talks and answers', () => {
    const day = (offset: number) =>
      new Date(at(12) - offset * 86400000).toISOString().slice(0, 10)
    const auto = (
      days: Record<string, number>,
      history: ProactiveMessage[] = [],
    ) => pace({ level: 'auto', history, days, now: at(12) })
    expect(auto({})).toEqual({ perDay: 3, gapMinutes: 75 })
    expect(auto({ [day(1)]: 12 })).toEqual({ perDay: 4, gapMinutes: 60 })
    expect(auto({ [day(1)]: 30, [day(2)]: 20 }).perDay).toBe(6)
    // Talk from more than a week ago does not count.
    expect(auto({ [day(9)]: 50 }).perDay).toBe(3)
    // Mostly ignored over the week: fewer and further apart.
    const old = (h: number) => ({
      ...said(h, 'ignored'),
      at: at(h) - 5 * 86400000,
    })
    expect(auto({ [day(1)]: 12 }, [old(9), old(10), old(11)])).toEqual({
      perDay: 3,
      gapMinutes: 90,
    })
  })
})

const activity = (
  from: number,
  to: number,
  title = '编辑器：main.ts',
  every = 2,
): PerceptionEvent[] => {
  const list: PerceptionEvent[] = []
  for (
    let t = at(0) + from * 3600000;
    t <= at(0) + to * 3600000;
    t += every * minute
  )
    list.push({ at: t, kind: 'window', app: 'Cursor', title })
  return list
}

describe('good moments to interrupt', () => {
  test('a pause, a switch after a stretch in one app, coming back; not mid-work', () => {
    const working = activity(9, 10)
    expect(breakpoint({ events: working, now: at(10), idle: 30 })).toBe(
      '停下来了',
    )
    expect(
      breakpoint({ events: working, now: at(10), idle: 2 }),
    ).toBeUndefined()
    const switched: PerceptionEvent[] = [
      { at: at(9), kind: 'app', bundleId: 'a', app: 'Cursor' },
      ...working,
      { at: at(10), kind: 'app', bundleId: 'b', app: 'Chrome' },
    ]
    expect(breakpoint({ events: switched, now: at(10, 1), idle: 2 })).toBe(
      '刚换了件事',
    )
    // Hopping between apps every minute is not a moment.
    const hopping: PerceptionEvent[] = [
      { at: at(9, 59), kind: 'app', bundleId: 'a', app: 'Cursor' },
      { at: at(10), kind: 'app', bundleId: 'b', app: 'Chrome' },
    ]
    expect(
      breakpoint({ events: hopping, now: at(10, 1), idle: 2 }),
    ).toBeUndefined()
    const back = [...activity(9, 9.5), ...activity(10, 10.02)]
    expect(breakpoint({ events: back, now: at(10, 2), idle: 2 })).toBe('刚回来')
  })
})

describe('care triggers', () => {
  const run = (events: PerceptionEvent[], now: number, fired = {}) =>
    candidates({
      events,
      now,
      triggers: defaults.triggers,
      fired,
      hour: new Date(now).getHours(),
    }).map((c) => c.trigger)

  test('first time today, then not again', () => {
    expect(run(activity(9, 9.02), at(9, 2))).toContain('firstToday')
    expect(
      run(activity(9, 9.02), at(9, 2), { firstToday: at(9, 1) }),
    ).not.toContain('firstToday')
  })

  test('back after 30 minutes away, right after returning only', () => {
    const events = [...activity(9, 10), ...activity(10.75, 10.8)]
    expect(run(events, at(10, 48))).toContain('back')
    expect(run(events, at(10, 48), { back: at(10, 46) })).not.toContain('back')
    const short = [...activity(9, 10), ...activity(10.25, 10.3)]
    expect(run(short, at(10, 18))).not.toContain('back')
  })

  test('90 minutes of work without a break', () => {
    expect(run(activity(9, 10.6), at(10, 36))).toContain('longWork')
    expect(run(activity(9, 10), at(10))).not.toContain('longWork')
    // A 15-minute break splits the stretch.
    const broken = [...activity(9, 9.8), ...activity(10.05, 10.6)]
    expect(run(broken, at(10, 36))).not.toContain('longWork')
  })

  test('late at night', () => {
    const late = new Date(2026, 10, 2, 23, 40).getTime()
    const events: PerceptionEvent[] = [
      { at: late - minute, kind: 'window', app: 'Cursor', title: 'x' },
    ]
    expect(run(events, late)).toContain('lateNight')
    expect(run(events, late, { lateNight: late - 30 * minute })).not.toContain(
      'lateNight',
    )
  })

  test('nothing while away', () => {
    expect(run(activity(9, 10), at(11))).toEqual([])
  })
})

describe('decision', () => {
  test('a model answer is trimmed; speak without text means no', () => {
    expect(
      parseDecision(
        '好的：{"speak":true,"text":" 歇会儿吧\\n喝口水 ","reason":"连续两小时"}',
      ),
    ).toEqual({ speak: true, text: '歇会儿吧 喝口水', reason: '连续两小时' })
    expect(parseDecision('{"speak":true,"text":""}').speak).toBe(false)
    expect(() => parseDecision('不说了')).toThrow()
  })
})
