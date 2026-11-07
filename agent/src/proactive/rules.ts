import type {
  PerceptionEvent,
  ProactiveMessage,
  ProactiveTrigger,
  Settings,
} from '../../../src/shared'

/**
 * The cheap, local half of speaking up (docs/design.md §8): how often the pet may speak, whether
 * now is a good moment to interrupt, and the care triggers that need no model to notice.
 * Nothing here calls a model.
 */
type Proactive = Settings['proactive']
const minute = 60000
const day = 86400000

const minutesOf = (hhmm: string) => {
  const [h, m] = hhmm.split(':').map(Number)
  return (h ?? 0) * 60 + (m ?? 0)
}
/** Inside the quiet hours; a range like 23:00–08:00 wraps past midnight. */
export function inQuietHours(quiet: Proactive['quiet'], now: Date): boolean {
  if (!quiet.enabled) return false
  const at = now.getHours() * 60 + now.getMinutes()
  const from = minutesOf(quiet.from)
  const to = minutesOf(quiet.to)
  if (from === to) return false
  return from < to ? at >= from && at < to : at >= from || at < to
}

const startOfDay = (now: number) => {
  const d = new Date(now)
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}

/** Messages per day and minutes between them for each fixed level. */
const levels = {
  quiet: { perDay: 2, gapMinutes: 120 },
  normal: { perDay: 4, gapMinutes: 60 },
  chatty: { perDay: 6, gapMinutes: 30 },
} as const
/** Never past this, whatever the level or the learning says. */
const ceiling = { perDay: 8, minGap: 20, maxGap: 180 }

export interface Pace {
  perDay: number
  gapMinutes: number
}
/**
 * How often the pet may speak up now. A fixed level sets the pace; 自动 starts from how much the
 * user talked to the pet in the last week and how often they answered its lines. Either way the
 * last three days move it: 别烦我 takes two off, 没理 one, 回应了 gives one back.
 */
export function pace(input: {
  level: Proactive['level']
  history: ProactiveMessage[]
  /** "YYYY-MM-DD" → messages the user sent that day. */
  days: Record<string, number>
  now: number
}): Pace {
  const { level, history, days, now } = input
  // 没看到 is not an answer: the user was not there to like or dislike it.
  const answered = history.filter(
    (m) =>
      m.trigger !== 'reminder' &&
      m.response &&
      m.response !== 'missed' &&
      now - m.at < 7 * day,
  )
  let base: Pace
  // Set when 自动 already learned from 回应 and 没理, so the three-day tally does not count them again.
  let learned = false
  if (level === 'auto') {
    const week = new Date(now - 7 * day).toISOString().slice(0, 10)
    const talked = Object.entries(days)
      .filter(([d]) => d >= week)
      .reduce((sum, [, n]) => sum + n, 0)
    base =
      talked >= 40
        ? { ...levels.chatty }
        : talked >= 10
          ? { ...levels.normal }
          : { perDay: 3, gapMinutes: 75 }
    // Enough answers to learn from: lines that land earn more room, ignored ones less.
    if (answered.length >= 3) {
      learned = true
      const rate =
        answered.filter((m) => m.response === 'ok').length / answered.length
      if (rate >= 0.5)
        base = {
          perDay: base.perDay + 1,
          gapMinutes: base.gapMinutes * 0.75,
        }
      else if (rate < 0.2)
        base = {
          perDay: base.perDay - 1,
          gapMinutes: base.gapMinutes * 1.5,
        }
    }
  } else base = { ...levels[level] }
  const recent = answered.filter((m) => now - m.at < 3 * day)
  const count = (r: ProactiveMessage['response']) =>
    recent.filter((m) => m.response === r).length
  const perDay =
    base.perDay -
    2 * count('quiet') -
    (learned ? 0 : count('ignored') - count('ok'))
  return {
    perDay: Math.max(1, Math.min(ceiling.perDay, base.perDay + 1, perDay)),
    gapMinutes: Math.round(
      Math.max(ceiling.minGap, Math.min(ceiling.maxGap, base.gapMinutes)),
    ),
  }
}

export interface Silence {
  /** Why nothing may be said now; undefined when the budget allows it. */
  reason?: string
}
/** Whether one of the pet's own lines (not a reminder) may go out now. */
export function budget(input: {
  settings: Proactive
  history: ProactiveMessage[]
  days: Record<string, number>
  now: number
  quietUntil?: number
}): Silence {
  const { settings, history, now } = input
  if (!settings.enabled) return { reason: '主动发言已关闭' }
  if (input.quietUntil && now < input.quietUntil)
    return { reason: '你说了别烦我' }
  if (inQuietHours(settings.quiet, new Date(now)))
    return { reason: '免打扰时段' }
  const { perDay, gapMinutes } = pace({ level: settings.level, ...input })
  const own = history.filter((m) => m.trigger !== 'reminder')
  if (own.filter((m) => m.at >= startOfDay(now)).length >= perDay)
    return { reason: '今天说得够多了' }
  if (now - (own[0]?.at ?? 0) < gapMinutes * minute)
    return { reason: '刚说过不久' }
  return {}
}

/**
 * Where a bubble on screen stands. Its countdown starts at the first keyboard or mouse input
 * after it appeared, so stepping away does not use it up; with no input for `waitFor` it went
 * unseen (missed), and once the countdown runs out unanswered it was ignored.
 */
export function bubbleProgress(input: {
  /** Monotonic milliseconds, in the same clock domain as now and startedAt. */
  shownAt: number
  /** When the countdown started; undefined while still waiting for the user. */
  startedAt?: number
  /** Seconds since the last keyboard or mouse input. */
  idle: number
  now: number
  showFor: number
  waitFor: number
}): { startedAt?: number; end?: 'ignored' | 'missed' } {
  const { shownAt, idle, now, showFor, waitFor } = input
  let startedAt = input.startedAt
  if (startedAt === undefined) {
    const lastInput = now - idle * 1000
    if (lastInput > shownAt) startedAt = lastInput
    else if (now - shownAt >= waitFor) return { end: 'missed' }
    else return {}
  }
  return now - startedAt >= showFor
    ? { startedAt, end: 'ignored' }
    : { startedAt }
}

/** How long an unseen line can still be shown again: the pet's own ideas go stale, reminders last the day. */
export const missedFreshFor = 40 * minute
/** Unseen lines that are still worth showing, newest first. */
export function missedLines(
  history: ProactiveMessage[],
  now: number,
): ProactiveMessage[] {
  return history
    .filter(
      (m) =>
        m.response === 'missed' &&
        (m.trigger === 'reminder'
          ? m.at >= startOfDay(now)
          : now - m.at < missedFreshFor),
    )
    .sort((a, b) => b.at - a.at)
}

/** Active stretches from the raw record: gaps of idle (or no events) ≥ `away` split them. */
export function stretches(
  events: PerceptionEvent[],
  away: number,
  now: number,
) {
  const list: { start: number; end: number }[] = []
  let current: { start: number; end: number } | undefined
  for (const e of events) {
    if (e.kind === 'idle') {
      current = undefined
      continue
    }
    if (current && e.at - current.end < away) current.end = e.at
    else list.push((current = { start: e.at, end: e.at }))
  }
  // Still going: the last stretch reaches now when the last event was recent.
  const last = list.at(-1)
  if (last && events.at(-1)?.kind !== 'idle' && now - last.end < away)
    last.end = now
  return list
}

/**
 * Whether interrupting now costs little: the user just paused (no input for a little while),
 * just moved on to another app after a stretch in one, or just came back. Mid-typing, mid-focus
 * gives undefined, and lines wait for the next such moment.
 */
export function breakpoint(input: {
  events: PerceptionEvent[]
  now: number
  /** Seconds since the last keyboard or mouse input. */
  idle: number
}): string | undefined {
  const { events, now, idle } = input
  if (idle >= 20) return '停下来了'
  const switches = events.filter((e) => e.kind === 'app')
  const last = switches.at(-1)
  const before = switches.at(-2)
  if (
    last &&
    now - last.at < 2 * minute &&
    (!before || last.at - before.at >= 10 * minute) &&
    last.bundleId !== before?.bundleId
  )
    return '刚换了件事'
  const runs = stretches(events, 5 * minute, now)
  const current = runs.at(-1)
  if (current && runs.length >= 2 && now - current.start < 3 * minute)
    return '刚回来'
  return undefined
}

/** A care moment the rules notice, before the model decides whether to speak. */
export interface Candidate {
  trigger: Extract<
    ProactiveTrigger,
    'firstToday' | 'back' | 'longWork' | 'lateNight'
  >
  /** What happened, for the model and for the "why now" line. */
  facts: string
  /** The moment is itself a good time to talk (coming back, the day's start). */
  breakpoint?: boolean
}

/**
 * Care triggers over the last few hours of raw events (oldest first). `fired` holds when each
 * last went off, so each fires once per occasion.
 */
export function candidates(input: {
  events: PerceptionEvent[]
  now: number
  triggers: Proactive['triggers']
  /** Trigger → the time it last fired. */
  fired: Partial<Record<Candidate['trigger'], number>>
  /** The user's local hour decides "late". */
  hour: number
}): Candidate[] {
  const { events, now, triggers, fired, hour } = input
  const found: Candidate[] = []
  const since = (t: Candidate['trigger']) => now - (fired[t] ?? 0)
  const today = startOfDay(now)
  const runs = stretches(events, 10 * minute, now)
  const current = runs.at(-1)
  const live = current && now - current.end < 2 * minute

  if (triggers.firstToday && live && (fired.firstToday ?? 0) < today) {
    const earlier = events.some((e) => e.at >= today && e.at < current.start)
    if (!earlier && current.start >= today)
      found.push({
        trigger: 'firstToday',
        facts: '今天第一次打开电脑',
        breakpoint: true,
      })
  }
  if (triggers.back && live && current) {
    const before = runs.at(-2)
    const gap = before ? current.start - before.end : 0
    // Only right after coming back, once per return.
    if (
      before &&
      gap >= 30 * minute &&
      now - current.start < 5 * minute &&
      (fired.back ?? 0) < current.start
    )
      found.push({
        trigger: 'back',
        facts: `离开了 ${Math.round(gap / minute)} 分钟，刚回来`,
        breakpoint: true,
      })
  }
  if (triggers.longWork && live && current) {
    const length = now - current.start
    if (length >= 90 * minute && since('longWork') >= 90 * minute)
      found.push({
        trigger: 'longWork',
        facts: `已经连续用电脑 ${Math.round(length / minute)} 分钟，中间没离开超过 10 分钟`,
      })
  }
  if (
    triggers.lateNight &&
    live &&
    (hour >= 23 || hour < 4) &&
    since('lateNight') >= 60 * minute
  )
    found.push({
      trigger: 'lateNight',
      facts: `现在是 ${hour} 点多，还在用电脑`,
    })
  return found
}
