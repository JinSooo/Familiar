import { describe, expect, test } from 'bun:test'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { windowLabels } from '../../src/shared/protocol'
import { blurHides, expandTo, quickStartsFresh } from '../src/session'

// Reported 2026-11-03: the quick-ask bar could not send. Its window was missing from the agent's
// request check, so every request from it went unanswered and the field stayed stuck.
describe('window labels', () => {
  test('the shell forwards requests from, and emits to, every window the agent knows', async () => {
    const rust = await readFile(
      join(import.meta.dir, '../../src-tauri/src/agent.rs'),
      'utf8',
    )
    const lists = [...rust.matchAll(/\[("pet"[^\]]*)\]/g)].map((m) =>
      [...m[1]!.matchAll(/"([a-z]+)"/g)].map((x) => x[1]).sort(),
    )
    expect(lists.length).toBeGreaterThanOrEqual(2)
    for (const list of lists) expect(list).toEqual([...windowLabels].sort())
  })
})

// Reported 2026-11-03: the quick-ask bar vanished right after sending. Another app took the
// keyboard while the reply was coming, and leaving closed the bar along with the chat panel.
describe('leaving for another app', () => {
  const base = {
    autoHide: true,
    quickAutoHide: true,
    approvals: 0,
    draft: false,
    running: false,
  }
  test('the quick bar stays while its reply is coming; the chat panel keeps its old rule', () => {
    expect(blurHides({ ...base, running: true })).toEqual({
      chat: true,
      quick: false,
    })
    expect(blurHides(base)).toEqual({ chat: true, quick: true })
  })
  test('a draft, an approval or 保持显示 keeps everything', () => {
    for (const s of [
      { ...base, draft: true },
      { ...base, approvals: 1 },
      { ...base, autoHide: false, quickAutoHide: false },
    ])
      expect(blurHides(s)).toEqual({ chat: false, quick: false })
  })
  // Reported 2026-11-03: a file could not be dragged in from Finder; clicking Finder hid the bar.
  test('the quick bar has its own setting, off by default', async () => {
    const { settingsSchema } = await import('../../src/shared')
    expect(settingsSchema.parse({}).quickAutoHide).toBe(false)
    expect(blurHides({ ...base, quickAutoHide: false })).toEqual({
      chat: true,
      quick: false,
    })
    expect(blurHides({ ...base, autoHide: false })).toEqual({
      chat: false,
      quick: true,
    })
  })
})

// Reported 2026-11-04: a file dragged in from Finder never reached the composer. Tauri's own
// drag-and-drop handler takes every file drop unless a window turns it off.
describe('dropping files', () => {
  test('every window with a composer lets the page take the drop', async () => {
    const rust = await readFile(
      join(import.meta.dir, '../../src-tauri/src/windows.rs'),
      'utf8',
    )
    for (const label of ['chat', 'main', 'quick']) {
      const start = rust.indexOf(`WebviewWindowBuilder::new(app, "${label}"`)
      const end = rust.indexOf('.build()', start)
      expect(start).toBeGreaterThan(-1)
      expect(rust.slice(start, end)).toContain('.disable_drag_drop_handler()')
    }
  })
})

describe('opening the quick bar', () => {
  const base = {
    mode: 'continue' as const,
    idleMinutes: 120,
    shown: false,
    running: false,
    messages: 4,
    lastActivity: 0,
    now: 60 * 60_000,
  }
  test('continue keeps a recent conversation and starts fresh after the quiet spell', () => {
    expect(quickStartsFresh(base)).toBe(false)
    expect(quickStartsFresh({ ...base, idleMinutes: 30 })).toBe(true)
  })
  test('new starts fresh each time, but not while open, running or empty', () => {
    expect(quickStartsFresh({ ...base, mode: 'new' })).toBe(true)
    for (const s of [{ shown: true }, { running: true }, { messages: 0 }])
      expect(quickStartsFresh({ ...base, mode: 'new', ...s })).toBe(false)
  })
})

// Reported 2026-11-04: an approval from the quick bar opened the big window and the chat panel
// both. The shell reports the big window visible a moment later; until then the next event
// moved the turn again, to the panel.
describe('where a running turn moves', () => {
  const base = {
    turnWindow: 'quick',
    mainVisible: false,
    chatVisible: false,
    approvalRequested: false,
    needsRoom: false,
    expanded: false,
  }
  test('a quick-bar approval goes to the big window once, and stays there', () => {
    expect(expandTo({ ...base, approvalRequested: true })).toBe('main')
    // After the hand-off, before the shell says the big window is visible.
    const after = {
      ...base,
      turnWindow: 'main',
      expanded: true,
      needsRoom: true,
    }
    expect(expandTo(after)).toBeUndefined()
    expect(expandTo({ ...after, approvalRequested: true })).toBeUndefined()
  })
  test('a capsule turn still opens the chat panel', () => {
    expect(expandTo({ ...base, turnWindow: 'pet', needsRoom: true })).toBe(
      'chat',
    )
  })
})

// Found 2026-11-06: pet_edge_hold and pet_rest were registered but never allowed, so Tauri
// refused every call — a tucked pet did not come out for bubbles, and it never went walking.
describe('shell commands', () => {
  test('every command the pages invoke is allowed for some window', async () => {
    const root = join(import.meta.dir, '../..')
    const { stdout } = Bun.spawnSync(
      ['git', 'grep', '-ohE', "invoke(<[^>]*>)?\\('[a-z_]+'", '--', 'src'],
      { cwd: root },
    )
    const invoked = new Set(
      [...stdout.toString().matchAll(/\('([a-z_]+)'/g)].map((m) => m[1]!),
    )
    expect(invoked.size).toBeGreaterThan(0)
    const toml = await readFile(
      join(root, 'src-tauri/permissions/commands.toml'),
      'utf8',
    )
    const granted = new Set<string>()
    const capabilities = await Promise.all(
      ['default', 'panel', 'quick', 'settings'].map((name) =>
        readFile(join(root, `src-tauri/capabilities/${name}.json`), 'utf8'),
      ),
    )
    for (const block of toml.split('[[permission]]').slice(1)) {
      const id = /identifier = "([^"]+)"/.exec(block)?.[1]
      if (!id || !capabilities.some((c) => c.includes(`"${id}"`))) continue
      for (const m of block.matchAll(/"([a-z_]+)"/g)) granted.add(m[1]!)
    }
    for (const command of invoked) expect(granted).toContain(command)
  })
})
