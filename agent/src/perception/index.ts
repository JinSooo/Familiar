import { spawn, execFile, type ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createInterface } from 'node:readline'
import { promisify } from 'node:util'
import type {
  UsageToday,
  PerceptionApp,
  PerceptionEvent,
  PerceptionStatus,
} from '../../../src/shared'
import { listConversations, loadConversation } from '../conversations'
import { openMemory } from '../memory'
import { backgroundModel } from '../memory/jobs'
import { getSettings } from '../settings'
import { dataDir, readKey, writeKey } from '../system'
import { ensureWorkspace, snapshot } from '../workspace'
import { admit, segments } from './activity'
import { keepHours, PerceptionBuffer } from './buffer'
import { periodEnd, summarizeWindow, talkText } from './summarize'

const exec = promisify(execFile)
const keyAccount = 'perception-buffer-key'
export const buffer = new PerceptionBuffer(
  join(dataDir, 'perception'),
  () => readKey(keyAccount),
  (key) => writeKey(key, keyAccount),
)

/** Release: beside the agent binary in Contents/MacOS. Development: built by `pnpm sensor:build`. */
function sensorPath(): string | null {
  const candidates = [
    join(dirname(process.execPath), 'familiar-sensor'),
    fileURLToPath(
      new URL('../../../sensor/.build/familiar-sensor', import.meta.url),
    ),
  ]
  return candidates.find((p) => existsSync(p)) ?? null
}

let child: ChildProcess | undefined
let restartTimer: ReturnType<typeof setTimeout> | undefined
let failures = 0
let notify: (status: PerceptionStatus) => void = () => {}
const status: Omit<PerceptionStatus, 'enabled' | 'paused'> = {
  running: false,
  trusted: null,
}

export function perceptionStatus(): PerceptionStatus {
  const { enabled, paused } = getSettings().perception
  return { ...status, enabled, paused }
}
function changed() {
  notify(perceptionStatus())
}

function wanted(): boolean {
  const p = getSettings().perception
  return p.enabled && !p.paused
}

function configure() {
  const p = getSettings().perception
  child?.stdin?.write(
    JSON.stringify({
      type: 'config',
      apps: p.excludedApps.map((a) => a.bundleId),
      paused: p.paused,
    }) + '\n',
  )
}

function launch() {
  clearTimeout(restartTimer)
  if (child || !wanted()) return
  const path = sensorPath()
  if (!path) {
    status.error =
      '找不到采集程序 familiar-sensor（开发时先运行 pnpm sensor:build）'
    return changed()
  }
  const proc = spawn(path, [], { stdio: ['pipe', 'pipe', 'pipe'] })
  child = proc
  const started = Date.now()
  status.running = true
  status.error = undefined
  changed()
  proc.stderr?.on('data', (d: Buffer) => console.error(String(d).trimEnd()))
  createInterface({ input: proc.stdout! }).on('line', (line) => {
    let raw: unknown
    try {
      raw = JSON.parse(line)
    } catch {
      return
    }
    const r = raw as { kind?: unknown; trusted?: unknown }
    if (r.kind === 'status') {
      status.trusted = r.trusted === true
      return changed()
    }
    const event = admit(raw, getSettings().perception)
    if (!event) return
    // The settings page shows the time of the last event; a minute's precision is enough.
    const stale = event.at - (status.lastEventAt ?? 0) >= 30000
    status.lastEventAt = event.at
    if (stale) changed()
    void buffer.append(event).catch((error) => {
      console.error('Buffering a perception event failed', error)
    })
  })
  proc.on('error', (error) => {
    status.error = `采集程序启动失败：${error.message}`
  })
  proc.on('exit', (code) => {
    if (child === proc) child = undefined
    status.running = false
    if (Date.now() - started > 60000) failures = 0
    changed()
    if (!wanted()) return
    status.error = `采集程序退出（${code ?? 'signal'}），稍后重启`
    const delay = Math.min(60000, 1000 * 2 ** failures++)
    restartTimer = setTimeout(launch, delay)
  })
  configure()
}

function halt() {
  clearTimeout(restartTimer)
  const proc = child
  child = undefined
  proc?.stdin?.end()
  proc?.kill()
  status.running = false
}

/** After any settings change: start, stop or reconfigure the sensor. */
export function applyPerceptionSettings() {
  if (!wanted()) halt()
  else if (child) configure()
  else launch()
  changed()
}

/** Asks the sensor to show the Accessibility prompt (it registers the app), then opens the pane. */
export async function grantAccess() {
  child?.stdin?.write('{"type":"prompt"}\n')
  await exec('/usr/bin/open', [
    'x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility',
  ])
}

/** Conversations that have messages in [from, to), with what was said there. */
async function conversationsBetween(from: number, to: number) {
  const petName = getSettings().pet.name
  const found: { id: string; text: string }[] = []
  for (const c of await listConversations()) {
    if (c.updatedAt < from) continue
    const text = talkText(
      (await loadConversation(c.id)).messages,
      from,
      to,
      petName,
    )
    if (text) found.push({ id: c.id, text })
  }
  return found
}

const stateFile = () => join(dataDir, 'perception-summary.json')
async function summarizedUntil(): Promise<number> {
  try {
    const value = (
      JSON.parse(await readFile(stateFile(), 'utf8')) as {
        until?: number
      }
    ).until
    return typeof value === 'number' ? value : 0
  } catch {
    return 0
  }
}

/** Told about the summary of the period that just ended (not a backlog catching up). */
let onDigest: (digest: { title: string; summary: string }) => void = () => {}
export function onActivityDigest(
  listener: (digest: { title: string; summary: string }) => void,
) {
  onDigest = listener
}
let summarizing: Promise<void> | undefined
/** Summarizes buffered activity when `summaryMinutes` have passed, or now when forced. */
export function summarizeDue(force = false): Promise<void> {
  summarizing ??= summarize(force).finally(() => {
    summarizing = undefined
  })
  return summarizing
}
/** Periods with activity summarized per run; a long backlog catches up over several runs. */
const perRun = 12
/** A period that keeps failing (say the model never returns JSON) is skipped after 3 runs. */
let failing = { from: 0, runs: 0 }
async function summarize(force: boolean) {
  const p = getSettings().perception
  if (!p.enabled) return changed()
  const now = Date.now()
  let from = Math.max(await summarizedUntil(), now - keepHours * 3600000)
  if (!force && periodEnd(from, p.summaryMinutes) > now) return
  if (force) await buffer.prune()
  const { store } = openMemory()
  let timeline = 0
  let pending = 0
  let ran = 0
  try {
    while (from < now && ran < perRun) {
      let to = periodEnd(from, p.summaryMinutes)
      // The period still under way waits for its end, unless asked for now.
      if (to > now) {
        if (!force) break
        to = now
      }
      let result
      try {
        result = await summarizeWindow({
          buffer,
          store,
          model: backgroundModel,
          settings: p,
          from,
          to,
          conversations: conversationsBetween,
        })
      } catch (error) {
        failing = { from, runs: failing.from === from ? failing.runs + 1 : 1 }
        if (failing.runs < 3) throw error
        console.error('Skipping a period that keeps failing:', error)
        result = { ran: true, timeline: 0, pending: 0 }
      }
      if (result.ran) ran++
      if (result.digest && to >= now - 5 * 60000) onDigest(result.digest)
      timeline += result.timeline
      pending += result.pending
      from = to
      await writeFile(stateFile(), JSON.stringify({ until: from }), {
        mode: 0o600,
      })
    }
    status.lastSummaryAt = now
    status.summary = { timeline, pending }
    if (timeline || pending)
      await snapshot(
        await ensureWorkspace(getSettings()),
        'familiar: perception summary',
      )
  } catch (error) {
    status.summary = {
      error: error instanceof Error ? error.message : '摘要失败',
    }
    if (force) throw error
  } finally {
    changed()
  }
}

export async function recentEvents(): Promise<PerceptionEvent[]> {
  return (await buffer.read(Date.now() - 3600000)).reverse()
}

/**
 * Clears both layers for the period: raw events, and every history entry that covers any of it.
 * The summary cursor goes back to the earliest removed entry, so what is left of those periods
 * is summarized again without the cleared minutes.
 */
export async function clearEvents(minutes: number | 'all') {
  await buffer.clear(minutes)
  const removed = await openMemory().store.removeActivity(
    minutes === 'all' ? 0 : Date.now() - minutes * 60000,
  )
  if (minutes === 'all') await writeFile(stateFile(), '{}', { mode: 0o600 })
  else if (removed.length) {
    const back = Math.min(...removed)
    if (back < (await summarizedUntil()))
      await writeFile(stateFile(), JSON.stringify({ until: back }), {
        mode: 0o600,
      })
  }
  if (removed.length)
    await snapshot(
      await ensureWorkspace(getSettings()),
      'familiar: clear computer history',
    )
}

const iconDir = () => join(dataDir, 'app-icons')
/** App icons as data: URLs, drawn once by familiar-sensor and cached as PNG. */
export async function appIcons(ids: string[]): Promise<Record<string, string>> {
  const path = sensorPath()
  const icons: Record<string, string> = {}
  await mkdir(iconDir(), { recursive: true })
  for (const id of ids) {
    if (!/^[\w.-]{1,200}$/.test(id)) continue
    const file = join(iconDir(), `${id}.png`)
    if (!existsSync(file) && path)
      await exec(path, ['--icon', id, file], { timeout: 5000 }).catch(() => {})
    try {
      icons[id] =
        'data:image/png;base64,' + (await readFile(file)).toString('base64')
    } catch {
      /* Not installed, or no icon. */
    }
  }
  return icons
}

const known: { kind: PerceptionApp['kind']; ids: (string | RegExp)[] }[] = [
  {
    kind: 'browser',
    ids: [
      'com.apple.Safari',
      'com.google.Chrome',
      'company.thebrowser.Browser',
      'company.thebrowser.dia',
      'com.microsoft.edgemac',
      'org.mozilla.firefox',
      'com.brave.Browser',
      'com.vivaldi.Vivaldi',
      'com.openai.atlas',
    ],
  },
  {
    kind: 'editor',
    ids: [
      'com.microsoft.VSCode',
      'com.todesktop.230313mzl4w4u92',
      'com.exafunction.windsurf',
      'dev.zed.Zed',
      'com.apple.dt.Xcode',
      'com.sublimetext.4',
      /^com\.jetbrains\./,
      /^com\.google\.android\.studio/,
    ],
  },
  {
    kind: 'terminal',
    ids: [
      'com.apple.Terminal',
      'com.googlecode.iterm2',
      'dev.warp.Warp-Stable',
      'com.mitchellh.ghostty',
      'net.kovidgoyal.kitty',
      'com.cmuxterm.app',
    ],
  },
]
function kindOf(id: string): PerceptionApp['kind'] | null {
  for (const group of known)
    if (group.ids.some((k) => (typeof k === 'string' ? k === id : k.test(id))))
      return group.kind
  return null
}

/** Every installed app, bundle id → name. */
async function installedApps(): Promise<Map<string, string>> {
  const paths: string[] = []
  for (const dir of [
    '/Applications',
    '/Applications/Utilities',
    '/System/Applications',
    '/System/Applications/Utilities',
    join(homedir(), 'Applications'),
  ])
    try {
      for (const name of await readdir(dir))
        if (name.endsWith('.app')) paths.push(join(dir, name))
    } catch {
      /* No such folder. */
    }
  const apps = new Map<string, string>()
  if (!paths.length) return apps
  const { stdout } = await exec(
    '/usr/bin/mdls',
    ['-name', 'kMDItemCFBundleIdentifier', '-raw', ...paths],
    { maxBuffer: 4 << 20 },
  ).catch(() => ({ stdout: '' }))
  stdout.split('\0').forEach((id, i) => {
    if (id && id !== '(null)' && paths[i])
      apps.set(
        id,
        paths[i]
          .split('/')
          .pop()!
          .replace(/\.app$/, ''),
      )
  })
  return apps
}

/** Installed browsers, editors and terminals, then other apps seen in the last day. */
export async function appCandidates(): Promise<PerceptionApp[]> {
  const found = new Map<string, PerceptionApp>()
  const installed = await installedApps()
  for (const [id, name] of installed) {
    const kind = kindOf(id)
    if (kind) found.set(id, { bundleId: id, name, kind })
  }
  const order = { browser: 0, editor: 1, terminal: 2, recent: 3 }
  const list = [...found.values()].sort(
    (a, b) => order[a.kind] - order[b.kind] || a.name.localeCompare(b.name),
  )
  const recent = await buffer.read(Date.now() - 86400000).catch(() => [])
  for (const e of recent.reverse())
    // Only real apps: events recorded before the sensor skipped system agents may name them.
    if (
      e.kind === 'app' &&
      e.bundleId &&
      installed.has(e.bundleId) &&
      !found.has(e.bundleId)
    ) {
      const app = {
        bundleId: e.bundleId,
        name: e.app ?? e.bundleId,
        kind: 'recent' as const,
      }
      found.set(e.bundleId, app)
      list.push(app)
    }
  return list
}

let pruneTimer: ReturnType<typeof setInterval> | undefined
let summaryTimer: ReturnType<typeof setInterval> | undefined
export function startPerception(onChange: (status: PerceptionStatus) => void) {
  notify = onChange
  applyPerceptionSettings()
  const prune = () => void buffer.prune().catch(console.error)
  prune()
  pruneTimer = setInterval(prune, 3600000)
  summaryTimer = setInterval(
    () => void summarizeDue().catch(console.error),
    60000,
  )
}
export function stopPerception() {
  clearInterval(pruneTimer)
  clearInterval(summaryTimer)
  halt()
}

/** Today's active time and the apps it went to, from the raw record (nothing leaves the Mac). */
export async function todayUsage(now = Date.now()): Promise<UsageToday> {
  const midnight = new Date(now)
  midnight.setHours(0, 0, 0, 0)
  const perception = getSettings().perception
  const list = segments(
    await buffer.read(midnight.getTime()),
    { ...perception, localApps: [] },
    now,
  )
  const byApp = new Map<string, { name: string; ms: number }>()
  let total = 0
  for (const s of list) {
    const ms = s.end - s.start
    total += ms
    const key = s.bundleId ?? s.app
    const entry = byApp.get(key) ?? { name: s.app, ms: 0 }
    entry.ms += ms
    byApp.set(key, entry)
  }
  return {
    activeMinutes: Math.round(total / 60000),
    apps: [...byApp.entries()]
      .map(([bundleId, a]) => ({
        bundleId,
        name: a.name,
        minutes: Math.round(a.ms / 60000),
      }))
      .filter((a) => a.minutes > 0)
      .sort((a, b) => b.minutes - a.minutes)
      .slice(0, 5),
  }
}
