import type { PerceptionEvent, Settings } from '../../../src/shared'
import { sensitiveReason } from '../memory/sensitive'

type Perception = Settings['perception']

/**
 * Turns one line from familiar-sensor into what may be stored, or null. Runs before anything
 * touches disk: a field the sensitive filter flags is dropped whole, and pages on excluded sites
 * keep only the app.
 */
export function admit(
  raw: unknown,
  settings: Perception,
): PerceptionEvent | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  const kind = r.kind
  if (
    kind !== 'app' &&
    kind !== 'window' &&
    kind !== 'idle' &&
    kind !== 'active'
  )
    return null
  const at =
    typeof r.at === 'number' && Number.isFinite(r.at) ? r.at : Date.now()
  const event: PerceptionEvent = { at, kind }
  const text = (key: string, max: number) =>
    typeof r[key] === 'string' && r[key]
      ? (r[key] as string).slice(0, max)
      : undefined
  const bundleId = text('bundleId', 200)
  const app = text('app', 200)
  if (bundleId) event.bundleId = bundleId
  if (app) event.app = app
  // Excluded apps are not even named: whatever the sensor sent, the segment just ends.
  if (bundleId && settings.excludedApps.some((a) => a.bundleId === bundleId))
    return { at, kind }
  if (kind !== 'window') return event
  if (!bundleId) return event
  if (r.private === true) return { ...event, private: true }
  if (r.secure === true) event.secure = true
  const fields = {
    title: text('title', 500),
    url: text('url', 2000),
    role: text('role', 60),
    text: text('text', 2000),
  }
  if (fields.url && excluded(fields.url, settings.excludedSites)) return event
  const dropped: string[] = []
  for (const [key, value] of Object.entries(fields)) {
    if (!value) continue
    if (key !== 'role' && sensitiveReason(value)) dropped.push(key)
    else (event as unknown as Record<string, string>)[key] = value
  }
  if (dropped.length) event.dropped = dropped
  return event
}

/** Chat and password apps, excluded the first time Computer History is on (docs/design.md §7). */
export const privateApps = [
  'com.tencent.xinWeChat',
  'com.tencent.WeWorkMac',
  'com.tencent.qq',
  'com.alibaba.DingTalkMac',
  'com.electron.lark',
  'ru.keepcoder.Telegram',
  'org.telegram.desktop',
  'com.apple.MobileSMS',
  'com.tinyspeck.slackmacgap',
  'com.hnc.Discord',
  'net.whatsapp.WhatsApp',
  'org.whispersystems.signal-desktop',
  'com.microsoft.teams2',
  'com.apple.Passwords',
  'com.apple.keychainaccess',
  'com.1password.1password',
  'com.agilebits.onepassword7',
  'com.bitwarden.desktop',
  'me.proton.pass.electron',
  'com.lastpass.LastPass',
  'org.keepassxc.keepassxc',
]

/** Adds the installed private apps to excludedApps, once; `installed` maps bundle id to name. */
export function withPrivateApps(
  settings: Perception,
  installed: Map<string, string>,
): Perception {
  if (settings.prefilled) return settings
  const listed = new Set(
    [...settings.excludedApps, ...settings.localApps].map((a) => a.bundleId),
  )
  const added = privateApps
    .filter((id) => installed.has(id) && !listed.has(id))
    .map((id) => ({ bundleId: id, name: installed.get(id)! }))
  return {
    ...settings,
    excludedApps: [...settings.excludedApps, ...added],
    prefilled: true,
  }
}

export function excluded(url: string, sites: string[]): boolean {
  let host: string
  try {
    host = new URL(url).hostname.toLowerCase()
  } catch {
    return false
  }
  return sites.some((site) => {
    const s = site
      .trim()
      .toLowerCase()
      .replace(/^\*?\./, '')
    return s && (host === s || host.endsWith('.' + s))
  })
}

/** A stretch of time on one window or page. */
export interface Segment {
  start: number
  end: number
  app: string
  bundleId?: string
  title?: string
  url?: string
  /** The last text seen in it. */
  text?: string
}

/** A segment with nothing after it is assumed to last at most this long. */
const tail = 5 * 60000

/**
 * Folds raw events into segments: consecutive events on the same app, title and page are one
 * segment; idle ends it. `local` apps are left out entirely, because the result goes to the model.
 */
export function segments(
  events: PerceptionEvent[],
  settings: Perception,
  until = Date.now(),
): Segment[] {
  const local = new Set(settings.localApps.map((a) => a.bundleId))
  const out: Segment[] = []
  let current: Segment | undefined
  const close = (at: number) => {
    if (current) {
      current.end = Math.max(current.start, at)
      out.push(current)
    }
    current = undefined
  }
  for (const e of [...events].sort((a, b) => a.at - b.at)) {
    if (e.kind === 'idle') {
      close(e.at)
      continue
    }
    if (e.kind === 'active') continue
    // An app event without a bundle id is an excluded app: end the segment, record nothing.
    if (!e.bundleId) {
      close(e.at)
      continue
    }
    const app = e.app ?? e.bundleId ?? '未知应用'
    const sameApp = current && current.bundleId === e.bundleId
    // An app event repeats the app we are in; a window event may change title or page.
    if (e.kind === 'app' && sameApp) continue
    if (
      e.kind === 'window' &&
      sameApp &&
      current!.title === e.title &&
      current!.url === e.url
    ) {
      if (e.text) current!.text = e.text
      continue
    }
    close(e.at)
    if (e.bundleId && local.has(e.bundleId)) continue
    current = {
      start: e.at,
      end: e.at,
      app,
      ...(e.bundleId ? { bundleId: e.bundleId } : {}),
      ...(e.title ? { title: e.title } : {}),
      ...(e.url ? { url: e.url } : {}),
      ...(e.text ? { text: e.text } : {}),
    }
  }
  if (current) close(Math.min(until, current.start + tail))
  // Merge back-to-back segments that only differ by a brief detour (app event then same window).
  const merged: Segment[] = []
  for (const s of out) {
    const last = merged.at(-1)
    if (
      last &&
      last.bundleId === s.bundleId &&
      last.title === s.title &&
      last.url === s.url &&
      s.start - last.end < 60000
    ) {
      last.end = s.end
      if (s.text) last.text = s.text
    } else merged.push({ ...s })
  }
  return merged.filter((s) => s.end - s.start >= 5000 || s.text)
}

/** The model's view of the segments: one line each, text trimmed. */
export function describe(list: Segment[]): string {
  const time = (at: number) => new Date(at).toTimeString().slice(0, 5)
  return list
    .map((s) => {
      let line = `${time(s.start)}–${time(s.end)} ${s.app}`
      if (s.title) line += `「${s.title.slice(0, 120)}」`
      if (s.url) line += ` ${s.url.slice(0, 200)}`
      if (s.text)
        line += `\n  文字：${s.text.replace(/\s+/g, ' ').slice(0, 300)}`
      return line
    })
    .join('\n')
}
