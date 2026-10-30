import { describe, expect, test } from 'bun:test'
import { mkdtempSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { settingsSchema, type PerceptionEvent } from '../../src/shared'
import {
  admit,
  cleanUrl,
  describe as describeActivity,
  segments,
} from '../src/perception/activity'
import { PerceptionBuffer } from '../src/perception/buffer'

const settings = settingsSchema.shape.perception.parse({
  enabled: true,
  excludedApps: [{ bundleId: 'com.apple.Notes', name: 'Notes' }],
  localApps: [{ bundleId: 'com.tinyspeck.slackmacgap', name: 'Slack' }],
  excludedSites: ['bank.com'],
})
function memoryBuffer() {
  let key = ''
  const dir = join(mkdtempSync(join(tmpdir(), 'familiar-perc-')), 'perception')
  return new PerceptionBuffer(
    dir,
    async () => key,
    async (k) => {
      key = k
    },
  )
}
const at = (minutes: number) =>
  new Date(2026, 9, 29, 14, 0).getTime() + minutes * 60000

describe('buffer', () => {
  test('round-trips encrypted events and leaves no plaintext on disk', async () => {
    const buffer = memoryBuffer()
    await buffer.append({ at: at(1), kind: 'window', title: '机密标题' })
    await buffer.append({ at: at(70), kind: 'app', app: 'Chrome' })
    const files = readdirSync(buffer.dir)
    expect(files).toEqual(['2026-10-29-14.enc', '2026-10-29-15.enc'])
    const raw = await Bun.file(join(buffer.dir, files[0]!)).text()
    expect(raw).not.toContain('机密')
    expect((await buffer.read(at(0), at(120))).map((e) => e.at)).toEqual([
      at(1),
      at(70),
    ])
  })
  test('prunes hours older than 48 and clears a recent range', async () => {
    const buffer = memoryBuffer()
    for (const m of [0, 30, 50, 55])
      await buffer.append({ at: at(m), kind: 'active' })
    await buffer.clear(10, at(56))
    expect((await buffer.read(0, at(120))).map((e) => e.at)).toEqual([
      at(0),
      at(30),
    ])
    writeFileSync(join(buffer.dir, '2026-10-27-13.enc'), 'x\n')
    expect(await buffer.prune(at(60))).toBe(1)
  })
  test('clearing everything rotates the key', async () => {
    const buffer = memoryBuffer()
    await buffer.append({ at: at(1), kind: 'active' })
    await buffer.clear('all')
    await buffer.append({ at: at(2), kind: 'idle' })
    expect((await buffer.read(0, at(10))).map((e) => e.kind)).toEqual(['idle'])
  })
})

describe('admit', () => {
  test('drops fields the sensitive filter flags', () => {
    const e = admit(
      {
        kind: 'window',
        bundleId: 'com.google.Chrome',
        title: '设置',
        text: 'key: sk-proj-Ab3dEf6hIj9kLm2nOp5qRs',
      },
      settings,
    )!
    expect(e.title).toBe('设置')
    expect(e.text).toBeUndefined()
    expect(e.dropped).toEqual(['text'])
  })
  // A Google search used to lose its whole URL: long query parameters looked like keys.
  test('URLs keep the page, without query, credentials or key-like segments', () => {
    const e = admit(
      {
        kind: 'window',
        bundleId: 'app.zen-browser.zen',
        title: 'Fork 和 GitKraken 怎么样 - Google Search',
        url: 'https://www.google.com/search?q=Fork&sxsrf=AE3TifN8kZ2x7Qp9LmR4vW1yB6cD0eFgH2jK5lM8nO3pQ',
      },
      settings,
    )!
    expect(e.url).toBe('https://www.google.com/search')
    expect(e.dropped).toBeUndefined()
    expect(cleanUrl('https://user:hunter2@example.com/reset?token=abc#x')).toBe(
      'https://example.com/reset',
    )
    expect(
      cleanUrl(
        'https://docs.google.com/document/d/1Xk9bQ7mN3pL5vR8tW2yZ4aC6eG0hJ1kM3nP5qS7uV9x/edit',
      ),
    ).toBe('https://docs.google.com/document/d/…/edit')
    expect(cleanUrl('file:///tmp/%E5%91%A8%E6%8A%A5.txt')).toBe(
      'file:///tmp/%E5%91%A8%E6%8A%A5.txt',
    )
    expect(cleanUrl('about:blank')).toBe('about:blank')
  })
  test('excluded sites and apps off the list keep only the app', () => {
    expect(
      admit(
        {
          kind: 'window',
          bundleId: 'com.google.Chrome',
          app: 'Chrome',
          title: '账户',
          url: 'https://www.bank.com/a',
        },
        settings,
      ),
    ).toEqual({
      at: expect.any(Number),
      kind: 'window',
      bundleId: 'com.google.Chrome',
      app: 'Chrome',
    })
    const other = admit(
      {
        kind: 'window',
        bundleId: 'com.apple.Notes',
        app: 'Notes',
        text: '日记',
      },
      settings,
    )!
    expect(other.text).toBeUndefined()
  })
})

describe('segments', () => {
  test('folds events, ends on idle, and leaves local apps out', () => {
    const events: PerceptionEvent[] = [
      { at: at(0), kind: 'app', bundleId: 'com.google.Chrome', app: 'Chrome' },
      {
        at: at(1),
        kind: 'window',
        bundleId: 'com.google.Chrome',
        app: 'Chrome',
        title: 'Tauri 文档',
        url: 'https://tauri.app',
      },
      {
        at: at(5),
        kind: 'window',
        bundleId: 'com.google.Chrome',
        app: 'Chrome',
        title: 'Tauri 文档',
        url: 'https://tauri.app',
        text: 'sidecar',
      },
      {
        at: at(10),
        kind: 'app',
        bundleId: 'com.tinyspeck.slackmacgap',
        app: 'Slack',
      },
      {
        at: at(12),
        kind: 'window',
        bundleId: 'com.tinyspeck.slackmacgap',
        app: 'Slack',
        title: '和同事私聊',
      },
      { at: at(20), kind: 'idle' },
    ]
    const list = segments(events, settings, at(30))
    expect(list.map((s) => [s.title ?? '', s.start, s.end])).toEqual([
      ['', at(0), at(1)],
      ['Tauri 文档', at(1), at(10)],
    ])
    const text = describeActivity(list)
    expect(text).toContain('sidecar')
    expect(text).not.toContain('Slack')
  })
})

describe('history periods', () => {
  test('periods follow the clock', async () => {
    const { periodEnd } = await import('../src/perception/summarize')
    expect(periodEnd(at(7), 10)).toBe(at(10))
    expect(periodEnd(at(10), 10)).toBe(at(20))
  })
  test('clearing removes every history entry that covers the period, and nothing else', async () => {
    const { MemoryStore } = await import('../src/memory/store')
    const store = new MemoryStore(
      join(mkdtempSync(join(tmpdir(), 'familiar-mem-')), 'memory'),
    )
    const entry = (start: number, end: number) => ({
      title: '写代码',
      start,
      end,
      apps: [],
    })
    await store.appendTimeline(
      '2026-10-29',
      '早些时候的事',
      entry(at(0), at(5)),
    )
    // Began before the cleared minutes but ran into them: its summary describes them too.
    await store.appendTimeline(
      '2026-10-29',
      '跨进来的事',
      entry(at(20), at(35)),
    )
    await store.appendTimeline('2026-10-29', '刚才的事', entry(at(50), at(51)))
    await store.appendTimeline('2026-10-29', '对话里聊到的事')
    expect(await store.removeActivity(at(30))).toEqual([at(20), at(50)])
    expect((await store.list()).map((e) => e.text)).toEqual([
      '早些时候的事',
      '对话里聊到的事',
    ])
  })
})
