import { describe, expect, test } from 'bun:test'
import { choices, leanings } from '../src/proactive/leanings'

const decision = (
  id: string,
  at: string,
  speak: boolean,
  trigger = 'activity',
) => ({
  id,
  at,
  trigger,
  facts: `这段时间主人在做的事：事情 ${id}`,
  decision: { speak, text: speak ? `说了 ${id}` : '' },
})

describe('past choices', () => {
  const past = choices(
    [
      decision('a', '2026-11-05T20:00:00+08:00', true),
      decision('b', '2026-11-05T20:30:00+08:00', true),
      decision('c', '2026-11-05T21:00:00+08:00', false),
      decision('d', '2026-11-05T21:30:00+08:00', true),
      decision('e', '2026-11-05T22:00:00+08:00', true, 'longWork'),
      {
        ...decision('f', '2026-11-05T22:10:00+08:00', true),
        error: 'ECONNRESET',
      },
    ],
    [
      { decision: 'a', response: 'ok' },
      { decision: 'b', response: 'quiet' },
      { decision: 'd', response: 'ignored' },
      { decision: 'e', response: 'missed' },
    ],
    // The user's own label wins over the bubble's answer.
    { b: { speak: true }, c: { speak: true } },
  )

  test('没理, 没看到 and errors count for nothing; labels win', () => {
    expect(past.map((c) => [c.trigger, c.want, c.said])).toEqual([
      ['activity', true, '说了 a'],
      ['activity', true, '说了 b'],
      ['activity', true, undefined],
    ])
  })

  test('only the same trigger, only moments before now', () => {
    const block = leanings(
      past,
      'activity',
      new Date('2026-11-05T20:45:00+08:00'),
    )
    expect(block).toContain('想听 2 次，不想听 0 次')
    expect(block).not.toContain('事情 c')
    expect(
      leanings(past, 'longWork', new Date('2026-11-06T00:00:00+08:00')),
    ).toBe('')
  })
})
