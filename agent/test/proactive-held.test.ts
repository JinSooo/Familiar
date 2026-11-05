import { describe, expect, mock, test } from 'bun:test'
import { mkdir } from 'node:fs/promises'
import * as real from '../src/proactive/decide'
import { dataDir } from '../src/system'

// The model is stubbed: these tests are about what is kept when it stays quiet or fails.
let answer: () => Promise<real.Decision> = async () => ({
  speak: false,
  text: '',
  reason: '你在专注写代码',
})
await mock.module('../src/proactive/decide', () => ({
  ...real,
  decide: () => answer(),
}))
await mock.module('../src/memory/jobs', () => ({
  backgroundModel: () => ({}),
}))
const { loadSettings } = await import('../src/settings')
const { noticeActivity, proactiveStatus } =
  await import('../src/proactive/index')

describe('held-back moments', () => {
  // 2026-11-05: triggers went off all morning and nothing said why no bubble came.
  test('a quiet decision and a failed call are both kept with their reason', async () => {
    await mkdir(dataDir, { recursive: true })
    await loadSettings()
    const digest = { title: '写代码', summary: '在改 Familiar' }
    await noticeActivity(digest)
    answer = () => Promise.reject(new Error('502 Bad Gateway'))
    await noticeActivity(digest)
    const { held, history } = await proactiveStatus()
    expect(history).toEqual([])
    expect(held.map((h) => [h.kind, h.trigger])).toEqual([
      ['failed', 'activity'],
      ['silent', 'activity'],
    ])
    expect(held[0]!.reason).toContain('502')
    expect(held[1]!.reason).toBe('你在专注写代码')
  })
})
