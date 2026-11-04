import { describe, expect, test } from 'bun:test'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { windowLabels } from '../../src/shared/protocol'
import { blurHides } from '../src/session'

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
