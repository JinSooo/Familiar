import { afterAll, beforeAll, expect, test } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Compile production Swift functions with inert AX, process and event boundaries.
// No accessibility permission, live window, mouse input or keyboard input is used.
const dir = mkdtempSync(join(tmpdir(), 'familiar-sensor-regression-'))
const root = new URL('../../', import.meta.url)
const control = readFileSync(new URL('sensor/control.swift', root), 'utf8')
const main = readFileSync(new URL('sensor/main.swift', root), 'utf8')
function declaration(source: string, name: string): string {
  const match = new RegExp(
    `^(?:private )?(?:final )?(?:func|class|struct) ${name}\\b`,
    'm',
  ).exec(source)
  if (!match) return '' // Helpers introduced by a fix are absent on the red baseline.
  const start = source.indexOf('{', match.index)
  let depth = 1
  let end = start + 1
  for (; depth && end < source.length; end++) {
    if (source[end] === '{') depth++
    if (source[end] === '}') depth--
  }
  return source.slice(match.index, end)
}
function constant(source: string, name: string): string {
  const match = new RegExp(`^private let ${name}\\b[^\\n]*`, 'm').exec(source)!
  return match[0].trimEnd().endsWith('[')
    ? source.slice(match.index, source.indexOf('\n]', match.index) + 2)
    : match[0]
}
beforeAll(() => {
  const names = [
    'ControlError',
    'fail',
    'ControlCancellation',
    'Registry',
    'Mode',
    'Target',
    'allowApp',
    'allowElement',
    'allowKeyboard',
    'allowPoint',
    'isSecure',
    'registered',
    'label',
    'clip',
    'readWindow',
    'findApp',
    'windows',
    'window',
    'center',
    'windowCenter',
    'focusedIsSecure',
    'pressKeys',
    'keystrokes',
    'key',
    'openApp',
    'hid',
    'realClick',
    'pressableNear',
    'verb',
    'click',
    'point',
    'drag',
    'typeText',
    'setValue',
    'scrollBar',
    'scroll',
  ]
  const constants = [
    'blockedApps',
    'cancellation',
    'registry',
    'skippedRoles',
    'inputRoles',
    'mode',
    'keyCodes',
    'modifierFlags',
    'needsGlobal',
  ]
  let production = [
    ...names.map((name) => declaration(control, name)),
    ...constants.map((name) => constant(control, name)),
    declaration(main, 'secureTextContext'),
    declaration(main, 'textContext'),
  ].join('\n')
  production = production
    .replace(/\bprivate /g, '')
    .replace(/\bNSRunningApplication\b/g, 'ProbeApp')
    .replace(/\bNSWorkspace\b/g, 'ProbeWorkspace')
    .replace(/\bProcess\b/g, 'ProbeProcess')
    .replace(/\bBundle\b/g, 'ProbeBundle')
    .replace(/\bCGEvent\b/g, 'ProbeEvent')
    .replace(/\busleep\b/g, 'probeSleep')
  const harness = readFileSync(
    new URL('fixtures/computer-sensor-probe.swift', import.meta.url),
    'utf8',
  ).replace('// PRODUCTION', production)
  writeFileSync(
    join(dir, 'main.swift'),
    harness
      .replace(
        /\bAXUIElement(CreateApplication|CreateSystemWide|SetMessagingTimeout|GetPid|CopyElementAtPosition|SetAttributeValue|PerformAction)\b/g,
        'probeAX$1',
      )
      .replace(/\bCGWindowListCopyWindowInfo\b/g, 'probeWindowList'),
  )
  execFileSync(
    'swiftc',
    ['-swift-version', '5', join(dir, 'main.swift'), '-o', join(dir, 'probe')],
    {
      env: { ...process.env, CLANG_MODULE_CACHE_PATH: join(dir, 'cache') },
      timeout: 120_000,
    },
  )
  writeFileSync(
    join(dir, 'mode.swift'),
    `import Foundation
${declaration(control, 'Mode')}
private let mode = Mode()
DispatchQueue.concurrentPerform(iterations: 2) { worker in
  if worker == 0 {
    for i in 0..<100_000 { mode.global = i % 2 == 0 }
  } else {
    var count = 0
    for _ in 0..<100_000 { if mode.global { count += 1 } }
    print(count)
  }
}
`,
  )
  execFileSync(
    'swiftc',
    [
      '-swift-version',
      '5',
      '-sanitize=thread',
      join(dir, 'mode.swift'),
      '-o',
      join(dir, 'mode'),
    ],
    {
      env: { ...process.env, CLANG_MODULE_CACHE_PATH: join(dir, 'cache') },
      timeout: 120_000,
    },
  )
  execFileSync(
    'swiftc',
    [
      '-O',
      '-swift-version',
      '5',
      ...['main', 'pdf', 'control', 'cursor'].map(
        (name) => new URL(`sensor/${name}.swift`, root).pathname,
      ),
      '-o',
      join(dir, 'sensor'),
    ],
    {
      env: { ...process.env, CLANG_MODULE_CACHE_PATH: join(dir, 'cache') },
      timeout: 120_000,
    },
  )
}, 120_000)
afterAll(() => rmSync(dir, { recursive: true, force: true }))
function probe(scenario: string): Record<string, unknown> {
  return JSON.parse(
    execFileSync(join(dir, 'probe'), [scenario], { encoding: 'utf8' }),
  )
}

test('Swift read never exposes secure labels or descendants', () => {
  const result = probe('read-secure')
  expect(result.app).toBe('Editor')
  expect(result.elements).toEqual([])
})
test('Swift registry revalidates secure fields, reparenting and all blocked owners', () => {
  expect(probe('registered')).toEqual({
    ordinary: true,
    secure: true,
    reparented: true,
    'com.apple.keychainaccess': true,
    'com.apple.Passwords': true,
    'com.allinpet.familiar': true,
  })
})
test('Swift coordinate operations refuse secure hit targets and blocked windows', () => {
  expect(probe('point')).toEqual({
    ordinary: true,
    overlay: true,
    secure: true,
    blocked: true,
  })
})
test('Swift refuses every key and shortcut in secure fields', () => {
  expect(probe('keys')).toEqual({
    ordinary: true,
    'cmd+a': true,
    'shift+a': true,
    return: true,
    delete: true,
    a: true,
    posted: 0,
  })
})
test('Swift typing rechecks focus between chunks', () => {
  expect(probe('focus-change')).toEqual({ denied: true, chunks: 1 })
})
test('Swift global keys never land in a different foreground app', () => {
  expect(probe('global-target')).toEqual({ denied: true, posted: 0 })
})
test('Swift open fails closed until the application bundle is resolved', () => {
  expect(probe('open')).toEqual({
    unresolved: true,
    unresolvedLaunches: 0,
    blocked: true,
    blockedLaunches: 0,
    ordinary: true,
  })
})
test('Swift typing keeps UTF-16 surrogate pairs in the same event', () => {
  expect(probe('unicode-type').text).toBe('a'.repeat(15) + '😀b')
})
test('Swift collector uses UTF-16 caret offsets for Unicode text', () => {
  expect(probe('unicode-context').text).toBe('😀😀😀HEREzzz')
})
test('Swift cancellation from the previous request cannot stop the next one', () => {
  expect(probe('cancel-boundary')).toEqual({ old: true, next: true })
})

test('Swift mode is race-free between the worker and Esc callback', () => {
  const output = execFileSync(join(dir, 'mode'), [], {
    encoding: 'utf8',
    env: { ...process.env, TSAN_OPTIONS: 'halt_on_error=1:exitcode=66' },
    timeout: 20_000,
  })
  expect(output.trim()).toMatch(/^\d+$/)
})

test('Swift control drains cancelled work before exiting on stdin EOF', () => {
  const count = 1000
  // Unknown operations cannot click, type, launch or capture anything, even with AX permission.
  const input =
    Array.from({ length: count }, (_, i) =>
      JSON.stringify({ id: i + 1, op: 'probe-unknown' }),
    ).join('\n') + '\n'
  const output = execFileSync(join(dir, 'sensor'), ['--control'], {
    input,
    encoding: 'utf8',
    timeout: 20_000,
  })
  const replies = output
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as { id: number; ok: boolean })
  expect(replies).toHaveLength(count)
  expect(new Set(replies.map((r) => r.id)).size).toBe(count)
  expect(replies.every((r) => r.ok === false)).toBe(true)
})

test('Swift collector never reads descendants of secure text fields', () => {
  expect(probe('collector-secure')).toEqual({
    ordinary: 'ordinary text',
    secure: true,
    valueReads: 0,
  })
})

test('every Swift element action enforces the live secure or blocked owner', () => {
  expect(probe('element-actions')).toEqual({
    ordinary: true,
    click: true,
    type: true,
    set: true,
    scroll: true,
    drag: true,
    blockedClick: true,
    blockedType: true,
    blockedSet: true,
    blockedScroll: true,
    blockedDrag: true,
    writes: 0,
    posted: 0,
  })
})

test('Swift coordinate click, scroll and both drag endpoints refuse secure hits', () => {
  expect(probe('coordinate-actions')).toEqual({
    click: true,
    scroll: true,
    dragStart: true,
    dragEnd: true,
    posted: 0,
  })
})
