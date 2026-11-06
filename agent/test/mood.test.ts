import { describe, expect, test } from 'bun:test'
import type { PerceptionEvent } from '../../src/shared'
import { moodOf } from '../src/mood'

const minute = 60000
const now = Date.parse('2026-11-06T14:00:00+08:00')
/** One window event every 5 minutes from `from` minutes ago to `to` minutes ago. */
const busy = (from: number, to = 0): PerceptionEvent[] => {
  const list: PerceptionEvent[] = []
  for (let m = from; m >= to; m -= 5)
    list.push({ at: now - m * minute, kind: 'window', app: 'Cursor' })
  return list
}

// P6 (2026-11-06): the mood follows what happened, first match wins.
describe('mood', () => {
  test('calm when nothing stands out', () => {
    expect(moodOf({ now, hour: 14, events: busy(30) }).mood).toBe('calm')
  })
  test('worried after an error and after two hours straight, before anything else', () => {
    expect(
      moodOf({
        now,
        hour: 14,
        events: [],
        failedAt: now - 5 * minute,
        chattedAt: now,
      }).mood,
    ).toBe('worried')
    const long = moodOf({ now, hour: 23, events: busy(130) })
    expect(long).toEqual({ mood: 'worried', reason: '你已经连续用了 130 分钟' })
  })
  test('sleepy late at night, happy after the user came to it', () => {
    expect(moodOf({ now, hour: 0, events: [] }).mood).toBe('sleepy')
    expect(
      moodOf({ now, hour: 14, events: [], chattedAt: now - 10 * minute }).mood,
    ).toBe('happy')
    expect(
      moodOf({ now, hour: 14, events: [], chattedAt: now - 40 * minute }).mood,
    ).toBe('calm')
  })
  test('curious right after coming back from a long break', () => {
    const events = [...busy(120, 80), ...busy(5)]
    expect(moodOf({ now, hour: 14, events }).mood).toBe('curious')
    expect(moodOf({ now, hour: 14, events: busy(120, 80) }).mood).toBe('calm')
  })
})
