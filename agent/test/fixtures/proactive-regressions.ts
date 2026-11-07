import { mock } from 'bun:test'
import assert from 'node:assert/strict'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { promisify } from 'node:util'
import * as native from '../../src/system'
import * as realSettings from '../../src/settings'
import * as childProcess from 'node:child_process'
import { settingsSchema, IPC } from '../../../src/shared'

const scenario = process.argv[2]!
let now = new Date(2026, 10, 7, 12).getTime()
let mono = 100000
Date.now = () => now
Object.defineProperty(performance, 'now', { value: () => mono })
let idle = 30
let visible = true
let busy = false
let context: () => Promise<object> = async () => ({})
let decision: () => Promise<object> = async () => ({
  speak: true,
  text: '跟进一下',
  reason: '到时间了',
})
const settings = settingsSchema.parse({})
settings.proactive.quiet.enabled = false
settings.perception.enabled = false
await mock.module('../../src/settings', () => ({
  ...realSettings,
  getSettings: () => settings,
}))
await mock.module('../../src/system', () => ({
  ...native,
  idleSeconds: async () => idle,
  sensorPath: () => '/fake/sensor',
}))
const execFile = Object.assign(() => {}, {
  [promisify.custom]: async () => ({
    stdout: JSON.stringify(await context()),
    stderr: '',
  }),
})
await mock.module('node:child_process', () => ({ ...childProcess, execFile }))
await mock.module('../../src/proactive/decide', () => ({
  decide: () => decision(),
}))
await mock.module('../../src/memory/jobs', () => ({
  backgroundModel: () => ({}),
}))
const intervals = new Map<number, () => void>()
// Timers are driven explicitly; no waiting for a minute or touching the user's Mac.
globalThis.setInterval = ((cb: () => void, delay: number) => {
  intervals.set(delay, cb)
  return delay
}) as typeof setInterval
const { dataDir } = native
await mkdir(dataDir, { recursive: true })
const reminders = await import('../../src/proactive/reminders')
const states = await import('../../src/proactive/state')
const scheduler = await import('../../src/proactive/index')
const messages: { id: string; trigger: string; text: string }[] = []
const speaker = {
  busy: () => busy,
  visible: () => visible,
  say: (m: (typeof messages)[number]) => {
    messages.push(m)
  },
  changed: () => {},
}
scheduler.startProactive(speaker)
const reminder = {
  id: 'r1',
  at: now - 60000,
  text: '提醒我',
  kind: 'reminder' as const,
}
async function seed(kind: 'reminder' | 'follow-up' = 'reminder') {
  await reminders.updateReminders(() => ({
    list: [{ ...reminder, kind }],
    result: undefined,
  }))
}
async function flush() {
  for (let i = 0; i < 30; i++)
    await new Promise((resolve) => setImmediate(resolve))
}
async function watch() {
  intervals.get(5000)!()
  await flush()
  await states.updateState(() => {})
}
const history = async () => (await states.readState()).history

if (scenario === 'dates' || scenario === 'date-tool') {
  if (scenario === 'dates')
    assert.equal(
      reminders.parseReminders('- [ ] 2027-02-31 09:00 不存在\n').length,
      0,
    )
  assert.equal(
    reminders.parseReminders('- [ ] 2028-02-29 09:00 闰日\n').length,
    1,
  )
  const tool = states.createReminderTools(() => {}).remind!
  const result = await (
    tool.execute as (i: object, o: object) => Promise<object>
  )({ at: '2027-02-31 09:00', text: '不存在' }, {})
  assert.match((result as { error?: string }).error ?? '', /不存在/)
} else if (scenario === 'editor-race') {
  await seed()
  let calls = 0
  const result = await reminders.updateReminders((list) => {
    calls++
    if (calls === 1)
      writeFileSync(
        join(dataDir, 'reminders.md'),
        reminders.formatReminders([
          ...list,
          { id: 'manual', text: '手写的', kind: 'todo' },
        ]),
      )
    return {
      list: list.filter((r) => r.id !== reminder.id),
      result: list.length,
    }
  })
  assert.equal((await reminders.readReminders())[0]?.text, '手写的')
  assert.equal(result, 2)
} else if (scenario.startsWith('quiet-')) {
  await seed()
  settings.proactive.quiet = { enabled: true, from: '11:00', to: '13:00' }
  if (scenario === 'quiet-disabled') settings.proactive.enabled = false
  else
    await states.updateState((s) => {
      s.quietUntil = now + 86400000
    })
  await scheduler.checkNow()
  assert.equal(messages.length, 0)
  settings.proactive.quiet.enabled = false
  await scheduler.checkNow()
  assert.equal(messages.length, 1)
} else if (
  scenario === 'hidden' ||
  scenario === 'hidden-watch' ||
  scenario === 'hidden-briefly'
) {
  await seed()
  if (scenario === 'hidden') {
    visible = false
    await scheduler.checkNow()
    assert.equal(messages.length, 0)
    assert.equal((await reminders.readReminders())[0]?.done, undefined)
    visible = true
    await scheduler.checkNow()
    assert.equal(messages.length, 1)
  } else {
    await scheduler.checkNow()
    mono += 5000
    now += 5000
    idle = 1
    await watch()
    visible = false
    if (scenario === 'hidden-briefly') {
      scheduler.petVisibilityChanged?.(false)
      visible = true
    }
    mono += 610000
    now += 610000
    await watch()
    assert.equal((await history())[0]?.response, 'missed')
  }
} else if (scenario.endsWith('-race')) {
  await seed()
  context = async () => {
    if (scenario === 'final-probe-race' && !(await history()).length) return {}
    await reminders.updateReminders((list) => ({
      list:
        scenario !== 'reschedule-race'
          ? []
          : list.map((r) => ({ ...r, at: now + 86400000 })),
      result: undefined,
    }))
    return {}
  }
  await scheduler.checkNow()
  assert.equal(messages.length, 0)
  if (scenario === 'reschedule-race')
    assert.equal((await reminders.readReminders())[0]?.done, undefined)
} else if (scenario === 'recovery' || scenario === 'claim-crash') {
  await seed()
  // Simulate a hard exit at the persisted claim or after publishing the bubble.
  if (scenario === 'claim-crash') {
    const original = reminders.updateReminders
    let writes = 0
    await mock.module('../../src/proactive/reminders', () => ({
      ...reminders,
      updateReminders: async (change: Parameters<typeof original>[0]) => {
        const result = await original(change)
        writes++
        if (writes === 1) throw new Error('simulated crash')
        return result
      },
    }))
    const error = console.error
    console.error = () => {}
    await scheduler.checkNow()
    console.error = error
  } else await scheduler.checkNow()
  const disk = JSON.parse(
    await readFile(join(dataDir, 'proactive.json'), 'utf8').catch(() => '{}'),
  )
  assert.ok(disk.delivering, 'a claimed reminder must be recoverable on disk')
  // A second process reads only the saved files, not the old module cache.
  const child = Bun.spawn(
    [process.execPath, import.meta.path, 'recover-child'],
    { env: process.env, stdout: 'pipe', stderr: 'pipe' },
  )
  const output = await new Response(child.stderr).text()
  assert.equal(await child.exited, 0, output)
} else if (scenario === 'recover-child') {
  await scheduler.checkNow()
  assert.equal(messages.length, 1)
  assert.equal(messages[0]!.text, reminder.text)
  assert.equal((await history()).length, 1)
  await scheduler.respond(messages[0]!.id, 'ok')
  assert.equal((await states.readState()).delivering, undefined)
  await scheduler.checkNow()
  assert.equal(messages.length, 1)
} else if (scenario.startsWith('decision-') || scenario === 'follow-up-busy') {
  await seed('follow-up')
  decision = async () => {
    if (scenario === 'decision-disabled') settings.proactive.enabled = false
    if (scenario === 'decision-quiet')
      settings.proactive.quiet = { enabled: true, from: '11:00', to: '13:00' }
    if (scenario === 'decision-meeting')
      context = async () => ({ microphone: true })
    if (scenario === 'decision-away') idle = 300
    if (scenario === 'follow-up-busy') busy = true
    return { speak: true, text: '跟进一下', reason: '到时间了' }
  }
  await scheduler.checkNow()
  assert.equal(messages.length, 0)
  if (scenario === 'follow-up-busy') {
    now += 41 * 60000
    await scheduler.checkNow()
    assert.equal((await states.readState()).held[0]?.trigger, 'follow-up')
    assert.equal((await states.readState()).held[0]?.kind, 'expired')
  } else {
    settings.proactive.enabled = true
    settings.proactive.quiet.enabled = false
    context = async () => ({})
    idle = 30
    await scheduler.checkNow()
    assert.equal(messages.length, 1)
    assert.equal(messages[0]!.trigger, 'follow-up')
  }
} else if (['clock-forward', 'clock-backward', 'sleep'].includes(scenario)) {
  await scheduler.noticeActivity({ title: '写代码', summary: '需要帮忙' })
  await scheduler.checkNow()
  assert.equal(messages.length, 1)
  if (scenario === 'clock-backward') {
    mono += 5000
    now += 5000
    idle = 1
    await watch()
    mono += 46000
    now -= 3600000
    await watch()
    assert.equal((await history())[0]?.response, 'ignored')
  } else {
    now += 3600000
    mono += scenario === 'sleep' ? 0 : 5000
    idle += scenario === 'sleep' ? 0 : 5
    await watch()
    mono += 50000
    now += 50000
    idle += 50
    await watch()
    assert.equal((await history())[0]?.response, undefined)
    mono += 600000
    now += 600000
    idle += 600
    await watch()
    assert.equal((await history())[0]?.response, 'missed')
  }
} else if (scenario === 'startup') {
  await writeFile(
    join(dataDir, 'settings.json'),
    JSON.stringify({
      workspacePath: join(dataDir, 'workspace'),
      perception: { enabled: false },
      proactive: { enabled: false },
      pet: { named: true },
    }),
  )
  const child = Bun.spawn(
    [process.execPath, join(import.meta.dir, '../../src/main.ts')],
    {
      env: {
        ...process.env,
        FAMILIAR_KEYCHAIN_SERVICE: 'com.allinpet.familiar.unit-test',
      },
      stdin: 'pipe',
      stdout: 'pipe',
      stderr: 'pipe',
    },
  )
  const output: { kind: string; channel?: string; payload?: unknown }[] = []
  const errors = new Response(child.stderr).text()
  const timeout = setTimeout(() => child.kill(), 5000)
  try {
    const reader = child.stdout.getReader()
    let pending = ''
    while (true) {
      const { value, done } = await reader.read()
      if (done) break
      pending += new TextDecoder().decode(value)
      const lines = pending.split('\n')
      pending = lines.pop()!
      for (const line of lines) output.push(JSON.parse(line))
      if (output.some((row) => row.channel === IPC.petWander)) break
    }
    child.kill()
    await child.exited
    const stderr = await errors
    assert.ok(
      output.some(
        (row) => row.channel === IPC.petState && row.payload === 'idle',
      ),
      stderr,
    )
    const session = output.find((row) => row.channel === IPC.session)
      ?.payload as { running: boolean; bubble: string; proactive?: unknown }
    assert.equal(session?.running, false)
    assert.equal(session?.bubble, '')
    assert.equal(session?.proactive, undefined)
    assert.ok(
      output.some(
        (row) => row.channel === IPC.capsule && row.payload === false,
      ),
    )
    assert.ok(output.some((row) => row.channel === IPC.proactiveChanged))
    assert.ok(output.some((row) => row.channel === IPC.petMood))
  } finally {
    clearTimeout(timeout)
    child.kill()
    await child.exited
  }
} else if (['main-busy', 'quick-busy'].includes(scenario)) {
  // Execute the actual startup statements and state publisher with a fake shell.
  const ts = await import('typescript')
  const source = await readFile(
    join(import.meta.dir, '../../src/main.ts'),
    'utf8',
  )
  const ast = ts.createSourceFile(
    'main.ts',
    source,
    ts.ScriptTarget.Latest,
    true,
  )
  const fn = (name: string) =>
    ast.statements.find(
      (s) => ts.isFunctionDeclaration(s) && s.name?.text === name,
    ) as import('typescript').FunctionDeclaration
  const start = fn('start').body!.statements
  const end = start.findIndex((s) =>
    s.getText(ast).startsWith('startProactive('),
  )
  const outputs: unknown[][] = []
  let captured: typeof speaker | undefined
  const noop = () => {}
  const scope: Record<string, unknown> = {
    mkdir: async () => {},
    dataDir,
    startLog: noop,
    loadSettings: noop,
    migrate: noop,
    skins: [],
    listPets: async () => [],
    refreshProxy: noop,
    greetedDay: '',
    readFile: async () => '',
    join,
    restoreLatest: noop,
    updatePet: noop,
    rebuildTray: noop,
    sendShortcuts: noop,
    applyOpacity: noop,
    getSettings: () => settings,
    setPetVisible: noop,
    startPerception: noop,
    onLocalModelChanged: noop,
    stopLeftoverServer: async () => {},
    startKnowledge: noop,
    onActivityDigest: noop,
    noticeActivity: noop,
    startProactive: (s: typeof speaker) => {
      captured = s
    },
    controller: undefined,
    capsuleOpen: false,
    chatVisible: false,
    mainVisible: scenario === 'main-busy',
    quickShown: scenario === 'quick-busy',
    hasDraft: false,
    petHidden: false,
    state: 'idle',
    activity: {},
    session: { bubble: '', proactive: undefined },
    resolveState: () => 'idle',
    IPC,
    emit: (...args: unknown[]) => outputs.push(args),
    broadcast: (...args: unknown[]) => outputs.push(args),
    publishSession: () => outputs.push([IPC.session]),
    sizePet: noop,
    petShown: true,
    currentMood: () => ({ mood: 'calm' }),
    proactiveStatus: async () => ({ missed: [], history: [] }),
  }
  const body = `${fn('refreshState').getText(ast)}\n${start
    .slice(0, end + 1)
    .map((s) => s.getText(ast))
    .join('\n')}`
  const js = ts.transpile(`async function run(){${body}}; return run()`, {
    target: ts.ScriptTarget.ESNext,
  })
  await new Function(...Object.keys(scope), js)(...Object.values(scope))
  assert.equal(captured!.busy(), true)
} else throw new Error(scenario)
scheduler.stopProactive()
process.exit(0)
