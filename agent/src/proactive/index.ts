import { execFile } from 'node:child_process'
import { join } from 'node:path'
import { promisify } from 'node:util'
import type {
  ProactiveHeld,
  ProactiveMessage,
  ProactiveStatus,
  ProactiveTrigger,
  Reminder,
} from '../../../src/shared'
import { getSettings } from '../settings'
import { dataDir, idleSeconds, sensorPath } from '../system'
import { buffer } from '../perception'
import { backgroundModel } from '../memory/jobs'
import { memoryContext, openMemory } from '../memory'
import { today } from '../memory/store'
import { personaText } from '../agent/persona'
import { moodLine } from '../mood'
import { decide } from './decide'
import { leanings, readChoices } from './leanings'
import { readReminders, stamp, updateReminders } from './reminders'
import {
  breakpoint,
  bubbleProgress,
  budget,
  candidates,
  inQuietHours,
  missedLines,
  pace,
} from './rules'
import {
  companionContext,
  readState,
  recordDecision,
  recordProactiveFeedback,
  updateState,
} from './state'

const exec = promisify(execFile)
const minute = 60000
/** Meeting apps in front count as "in a meeting" even before the microphone is on. */
const meetingApps = new Set([
  'us.zoom.xos',
  'com.microsoft.teams',
  'com.microsoft.teams2',
  'com.electron.lark',
  'com.bytedance.macos.feishu',
  'com.tencent.meeting',
  'com.apple.FaceTime',
  'com.webex.meetingmanager',
])

/** What main.ts lends the scheduler: how to speak, and whether the user is busy with the pet. */
export interface Speaker {
  /** The pet is already talking with the user (a turn running, capsule or chat open). */
  busy(): boolean
  /** The pet window can actually display a bubble. */
  visible(): boolean
  /** Put the message in the bubble. */
  say(message: ProactiveMessage): void
  /** The status changed (settings page, panel). */
  changed(status: ProactiveStatus): void
}

/** Full screen, a meeting app in front, or the microphone in use. Unknown counts as fine. */
async function inTheWay(): Promise<string | undefined> {
  const path = sensorPath()
  if (!path) return undefined
  try {
    const { stdout } = await exec(path, ['--context'], { timeout: 5000 })
    const c = JSON.parse(stdout) as {
      fullscreen?: boolean
      microphone?: boolean
      front?: string
    }
    if (c.fullscreen) return '全屏中'
    if (c.microphone || (c.front && meetingApps.has(c.front))) return '会议中'
  } catch (error) {
    console.error('Proactive context check failed', error)
  }
  return undefined
}

let speaker: Speaker | undefined
let timer: ReturnType<typeof setInterval> | undefined
let startupTimer: ReturnType<typeof setTimeout> | undefined
let ticking = false
/**
 * The message on screen, so a click can answer it and the watch can end it: ignored when the
 * user was there and let it go, missed when they never came near the Mac while it waited.
 */
let showing:
  | {
      message: ProactiveMessage
      shownAt: number
      /** Seconds without input when it appeared, kept with the answer as evidence. */
      idleAtShow: number
      startedAt?: number
      timer: ReturnType<typeof setInterval>
    }
  | undefined

export async function proactiveStatus(): Promise<ProactiveStatus> {
  const state = await readState()
  const settings = getSettings().proactive
  const now = Date.now()
  const midnight = new Date(now)
  midnight.setHours(0, 0, 0, 0)
  const current = pace({
    level: settings.level,
    history: state.history,
    days: state.days,
    now,
  })
  return {
    history: state.history,
    reminders: await readReminders(),
    usedToday: state.history.filter(
      (m) => m.trigger !== 'reminder' && m.at >= midnight.getTime(),
    ).length,
    limit: current.perDay,
    gapMinutes: current.gapMinutes,
    ...(state.quietUntil && state.quietUntil > now
      ? { quietUntil: state.quietUntil }
      : {}),
    missed: missedLines(state.history, now),
    held: state.held,
  }
}

/** Notes a trigger that came to nothing (see ProactiveHeld); the page lists them. */
async function hold(entry: ProactiveHeld) {
  await updateState((s) => {
    s.held.unshift(entry)
  })
  void changed()
}
const failure = (error: unknown) =>
  `调用失败：${error instanceof Error ? error.message : String(error)}`.slice(
    0,
    120,
  )
async function changed() {
  speaker?.changed(await proactiveStatus())
}

/** No keyboard or mouse for this long means the user is away. */
const awayAfter = 120
/**
 * How long a bubble stays, counted from the user's first input after it appeared, before it
 * counts as ignored: the pet's own ideas fade quickly, a reminder the user asked for waits so a
 * glance away does not lose it.
 */
const showFor = (m: ProactiveMessage) =>
  m.trigger === 'reminder' ? 10 * minute : 45000
/** With no input at all for this long the bubble goes unseen and moves to the missed list. */
const waitFor = 10 * minute
const watchEvery = 5000

async function show(
  message: ProactiveMessage,
  idle: number,
  reopened = false,
  claim?: () => Promise<boolean>,
) {
  await updateState((s) => {
    if (reopened) {
      const m = s.history.find((x) => x.id === message.id)
      if (m) delete m.response
    } else {
      s.history = s.history.filter((m) => m.id !== message.id)
      s.history.unshift(message)
    }
  })
  // Settings and visibility can change even while the history write is pending.
  const currentIdle = reopened
    ? speaker?.visible() && !showing
      ? 0
      : undefined
    : await readyToShow(message.trigger, message.id)
  const claimed = currentIdle !== undefined && (!claim || (await claim()))
  if (
    !claimed ||
    showing ||
    !speaker?.visible() ||
    (!reopened && speaker.busy())
  ) {
    await updateState((s) => {
      if (reopened) {
        const m = s.history.find((x) => x.id === message.id)
        if (m) m.response = 'missed'
      } else s.history = s.history.filter((m) => m.id !== message.id)
    })
    return false
  }
  // Bun on macOS uses CLOCK_UPTIME_RAW, like HIDIdleTime: neither counts sleep.
  const now = performance.now()
  showing = {
    message,
    shownAt: now,
    idleAtShow: Math.round(currentIdle ?? idle),
    // Brought back by a click: the user is plainly there.
    ...(reopened ? { startedAt: now } : {}),
    timer: setInterval(() => void watch(), watchEvery),
  }
  speaker?.say(message)
  void changed()
  return true
}

async function watch() {
  const current = showing
  if (!current) return
  const idle = await idleSeconds().catch(() => Number.POSITIVE_INFINITY)
  if (showing !== current) return
  if (!speaker?.visible()) {
    await respond(current.message.id, 'missed', idle)
    return
  }
  const progress = bubbleProgress({
    shownAt: current.shownAt,
    startedAt: current.startedAt,
    idle,
    now: performance.now(),
    showFor: showFor(current.message),
    waitFor,
  })
  current.startedAt = progress.startedAt
  if (progress.end) await respond(current.message.id, progress.end, idle)
}

/** A hidden interval is never evidence that the user ignored the bubble. */
export function petVisibilityChanged(visible: boolean) {
  if (!visible && showing)
    void respond(showing.message.id, 'missed').catch(console.error)
}

/** Shows an unseen line again (the dot on the pet, the menu bar panel). */
export async function reopen(id: string): Promise<void> {
  const state = await readState()
  const message = missedLines(state.history, Date.now()).find(
    (m) => m.id === id,
  )
  if (!message) throw new Error('这句话已经过期了')
  if (showing) throw new Error('正在说另一句话')
  if (!(await show({ ...message, response: undefined }, 0, true)))
    throw new Error('宠物已隐藏，请先显示宠物')
}

/** What the user did with a bubble. 别烦我 holds for the rest of the day. */
export async function respond(
  id: string,
  response: NonNullable<ProactiveMessage['response']>,
  /** Seconds without input at the answer, when already known. */
  idleNow?: number,
): Promise<ProactiveMessage | undefined> {
  let evidence: { idleAtShow: number; idleAtEnd: number } | undefined
  if (showing?.message.id === id) {
    const ended = showing
    clearInterval(ended.timer)
    showing = undefined
    evidence = {
      idleAtShow: ended.idleAtShow,
      idleAtEnd: Math.round(idleNow ?? (await idleSeconds().catch(() => 0))),
    }
  }
  let answered: ProactiveMessage | undefined
  await updateState((s) => {
    const m = s.history.find((x) => x.id === id)
    if (!m || m.response) return
    m.response = response
    if (s.delivering?.message.id === id) delete s.delivering
    answered = { ...m }
    if (response === 'quiet') {
      const end = new Date()
      end.setHours(24, 0, 0, 0)
      s.quietUntil = end.getTime()
    }
  })
  if (!answered) return undefined
  // 稍后: the same reminder comes back in 10 minutes.
  if (response === 'later' && answered.trigger === 'reminder')
    await updateReminders((list) => ({
      list: [
        ...list,
        {
          id: `${answered!.id}-later`,
          at: Date.now() + 10 * minute,
          text: answered!.text,
          kind: 'reminder',
        },
      ],
      result: undefined,
    }))
  void recordProactiveFeedback(answered, evidence).catch(console.error)
  void changed()
  return answered
}
export function showingMessage(): ProactiveMessage | undefined {
  return showing?.message
}

/** Clears 别烦我 (from the settings page). */
export async function resumeProactive() {
  await updateState((s) => {
    delete s.quietUntil
  })
  void changed()
}

/** The user sent the pet a message today: closeness counts days of talking. */
export function noteConversation() {
  const day = today()
  void updateState((s) => {
    s.days[day] = (s.days[day] ?? 0) + 1
  }).catch(console.error)
}

const newId = () =>
  `p${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`

/** The model's take on the latest activity summary, waiting for a good moment to be said. */
const queued: {
  trigger: ProactiveTrigger
  text: string
  reason: string
  decision: string
  expires: number
}[] = []
/** A line about what the user is doing goes stale after this. */
const freshFor = 40 * minute

const responses = {
  ok: '回应了',
  later: '稍后',
  quiet: '别烦我',
  ignored: '没理',
  missed: '没看到',
} as const
/** Reminders and follow-ups due in the next day, so "his deadline is near" can be noticed; with `todos`, also the open to-dos that have no time. */
async function upcoming(now: number, todos = false): Promise<string> {
  const open = (await readReminders().catch(() => [])).filter((r) => !r.done)
  const soon = open
    .filter(
      (r): r is Reminder & { at: number } =>
        r.at !== undefined && r.at > now && r.at <= now + 24 * 60 * minute,
    )
    .slice(0, 8)
  const today = new Date(now).toDateString()
  const parts: string[] = []
  if (soon.length)
    parts.push(
      `接下来 24 小时内的提醒和跟进：\n${soon
        .map(
          (r) =>
            `- ${new Date(r.at).toDateString() === today ? '今天' : '明天'} ${stamp(r.at).slice(11)} ${r.text}`,
        )
        .join('\n')}`,
    )
  const undated = todos ? open.filter((r) => r.kind === 'todo').slice(0, 5) : []
  if (undated.length)
    parts.push(
      `还没做的待办（没有时间）：\n${undated.map((r) => `- ${r.text}`).join('\n')}`,
    )
  return parts.join('\n\n')
}
/**
 * Memory, closeness and energy, upcoming reminders, what the user chose in like moments, and what
 * was said lately: what the model decides from.
 */
async function material(trigger: ProactiveTrigger, now: number, todos = false) {
  const state = await readState()
  const memory = openMemory()
  const reminders = await upcoming(now, todos)
  let chosen = ''
  try {
    chosen = leanings(
      readChoices(join(dataDir, 'evals')),
      trigger,
      new Date(now),
    )
  } catch (error) {
    console.error('Read past choices:', error)
  }
  return {
    context: [
      `${companionContext(state, new Date(now))}${moodLine()}`,
      `关于主人的记忆：\n${(await memoryContext(memory.store, 1500, 0).catch(() => '')) || '（暂无）'}`,
      ...(reminders ? [reminders] : []),
      ...(chosen ? [chosen] : []),
    ].join('\n\n'),
    recent: state.history
      .filter((m) => now - m.at < 86400000)
      .slice(0, 6)
      .map(
        (m) =>
          `- ${stamp(m.at)} ${m.text}（${responses[m.response ?? 'ignored']}）`,
      )
      .join('\n'),
  }
}

/**
 * Asks the background model whether to say something, and logs the whole input with the answer
 * (or the error) so the moment can become an eval case later. Failures are held and rethrown.
 */
async function consult(
  trigger: ProactiveTrigger,
  facts: string,
  now: number,
  todos = false,
) {
  const settings = getSettings()
  const id = `d${now.toString(36)}${Math.random().toString(36).slice(2, 5)}`
  const input = {
    name: settings.pet.name,
    persona: await personaText(),
    facts,
    ...(await material(trigger, now, todos)),
  }
  const row = {
    id,
    at: new Date(now).toISOString(),
    trigger,
    ...input,
    model: settings.model.smallModel.trim() || settings.model.model,
  }
  try {
    const decision = await decide({
      model: backgroundModel(),
      now: new Date(now),
      ...input,
    })
    void recordDecision({ ...row, decision }).catch(console.error)
    return { id, decision }
  } catch (error) {
    void recordDecision({ ...row, error: failure(error) }).catch(console.error)
    await hold({ at: now, trigger, kind: 'failed', reason: failure(error) })
    throw error
  }
}

/**
 * A Computer History summary for the period that just ended: ask whether there is something
 * worth saying about it. Costs one small-model call per summary, and only when the budget
 * would let a line out at all.
 */
export async function noticeActivity(digest: {
  title: string
  summary: string
}) {
  try {
    const settings = getSettings()
    if (!settings.proactive.triggers.activity) return
    const state = await readState()
    const now = Date.now()
    if (
      budget({
        settings: settings.proactive,
        history: state.history,
        days: state.days,
        now,
        quietUntil: state.quietUntil,
      }).reason
    )
      return
    const facts = `这段时间主人在做的事：${digest.title}。${digest.summary}`
    const { id, decision } = await consult('activity', facts, now)
    await updateState((s) => {
      s.fired.activity = now
    })
    if (!decision.speak)
      await hold({
        at: now,
        trigger: 'activity',
        kind: 'silent',
        reason: decision.reason || '觉得没什么要说的',
      })
    if (decision.speak)
      queued.push({
        trigger: 'activity',
        text: decision.text,
        reason: decision.reason || digest.title,
        decision: id,
        expires: now + freshFor,
      })
  } catch (error) {
    console.error('Proactive look at activity failed', error)
  }
}

async function dueReminders(now: number) {
  // To-dos have no time and never come due.
  return (await readReminders()).filter(
    (r): r is Reminder & { at: number } =>
      !r.done && r.at !== undefined && r.at <= now,
  )
}

/** Read slow probes first, then check all current synchronous gates together. */
async function readyToShow(trigger: ProactiveTrigger, messageId?: string) {
  if (await inTheWay()) return undefined
  const idle = await idleSeconds().catch(() => Number.POSITIVE_INFINITY)
  const state = await readState()
  const settings = getSettings().proactive
  const now = Date.now()
  if (showing || !speaker?.visible() || speaker.busy() || idle >= awayAfter)
    return undefined
  if (trigger === 'reminder') {
    if (inQuietHours(settings.quiet, new Date(now))) return undefined
  } else if (
    budget({
      settings,
      history: state.history.filter((m) => m.id !== messageId),
      days: state.days,
      now,
      quietUntil: state.quietUntil,
    }).reason
  )
    return undefined
  return idle
}

const sameReminder = (a: Reminder, b: Reminder) =>
  a.id === b.id && a.at === b.at && a.text === b.text && a.kind === b.kind

/** The outbox survives both sides of the reminders.md write. */
async function deliver(idle: number) {
  const state = await readState()
  const pending = state.delivering
  if (!pending) return
  if (state.history.some((m) => m.id === pending.message.id && m.response)) {
    await updateState((s) => {
      delete s.delivering
    })
    return
  }
  await show({ ...pending.message, at: Date.now() }, idle, false, async () => {
    // No context probe after claiming: cancellation during a probe must win.
    const claimed = await updateReminders((list) => {
      const current = list.find(
        (r) =>
          sameReminder(r, pending.reminder) &&
          r.at !== undefined &&
          r.at <= Date.now() &&
          (!r.done || r.done === pending.message.at),
      )
      return {
        list: list.map((r) =>
          r === current ? { ...r, done: pending.message.at } : r,
        ),
        result: current,
      }
    })
    if (!claimed)
      await updateState((s) => {
        delete s.delivering
      })
    return Boolean(claimed)
  })
}

async function tick() {
  if (ticking || !speaker) return
  ticking = true
  try {
    const now = Date.now()
    // Expiration must run even while busy, hidden, muted or away.
    for (let i = queued.length - 1; i >= 0; i--) {
      const line = queued[i]!
      if (line.expires >= now) continue
      await hold({
        at: now,
        trigger: line.trigger,
        kind: 'expired',
        reason: '一直没等到不打扰你的时机',
        text: line.text,
      })
      queued.splice(i, 1)
    }
    const settings = getSettings()
    const state = await readState()
    if (showing || speaker.busy() || !speaker.visible()) return
    const idle = await idleSeconds().catch(() => Number.POSITIVE_INFINITY)
    if (idle >= awayAfter) return

    if (state.delivering) {
      if (inQuietHours(settings.proactive.quiet, new Date(now))) return
      return await deliver(idle)
    }
    const due = await dueReminders(now)
    const asked = due.find((r) => r.kind === 'reminder')
    if (asked) {
      if (inQuietHours(settings.proactive.quiet, new Date(now))) return
      // Persist the intent before marking done. The claim below revalidates the file.
      const at = Date.now()
      await updateState((s) => {
        s.delivering = {
          reminder: asked,
          message: {
            id: newId(),
            at,
            trigger: 'reminder',
            text: asked.text,
            reason:
              at - asked.at > 5 * minute
                ? `你设的提醒（${stamp(asked.at)}）`
                : '你设的提醒',
          },
        }
      })
      return await deliver(idle)
    }

    if (
      budget({
        settings: settings.proactive,
        history: state.history,
        days: state.days,
        now,
        quietUntil: state.quietUntil,
      }).reason
    )
      return
    const watching = settings.perception.enabled && !settings.perception.paused
    const events = watching
      ? await buffer.read(now - 4 * 60 * minute).catch(() => [])
      : []
    const moment = breakpoint({ events, now, idle })
    const care = watching
      ? candidates({
          events,
          now,
          triggers: settings.proactive.triggers,
          fired: state.fired,
          hour: new Date(now).getHours(),
        })
      : []
    const opening = care.find((c) => c.breakpoint)
    if (!opening && !moment) return
    if ((await readyToShow('activity')) === undefined) return

    if (queued.length && !opening) {
      const line = queued[0]!
      if (
        await show(
          {
            id: newId(),
            at: Date.now(),
            trigger: line.trigger,
            text: line.text,
            reason: line.reason,
            decision: line.decision,
          },
          idle,
        )
      )
        queued.splice(queued.indexOf(line), 1)
      return
    }

    const followUp = due.find((r) => r.kind === 'follow-up')
    let trigger: ProactiveTrigger | undefined
    let facts = ''
    if (opening) {
      trigger = opening.trigger
      facts = opening.facts
    } else if (followUp && settings.proactive.triggers.followUp) {
      trigger = 'follow-up'
      // Revalidate follow-ups too: the same editor/model race applies here.
      const claimed = await updateReminders((list) => {
        const current = list.find(
          (r) =>
            r.id === followUp.id &&
            !r.done &&
            r.kind === 'follow-up' &&
            r.at !== undefined &&
            r.at <= Date.now(),
        )
        return {
          list: list.map((r) =>
            r === current ? { ...r, done: Date.now() } : r,
          ),
          result: current,
        }
      })
      if (!claimed) return
      facts = `到了之前记下要跟进的时候，该关心一下这件事了：${claimed.text}`
    } else if (care[0]) {
      trigger = care[0].trigger
      facts = care[0].facts
    }
    if (!trigger) return
    await updateState((s) => {
      s.fired[trigger] = now
    })
    const { id, decision } = await consult(
      trigger,
      facts,
      now,
      trigger === 'firstToday',
    )
    if (!decision.speak) {
      await hold({
        at: now,
        trigger,
        kind: 'silent',
        reason: decision.reason || '觉得没什么要说的',
      })
      return
    }
    const line = {
      trigger,
      text: decision.text,
      reason: decision.reason || facts.slice(0, 30),
      decision: id,
      expires: now + freshFor,
    }
    queued.push(line)
    if (line.expires < Date.now()) return
    if (
      await show(
        {
          id: newId(),
          at: Date.now(),
          trigger,
          text: line.text,
          reason: line.reason,
          decision: id,
        },
        idle,
      )
    )
      queued.splice(queued.indexOf(line), 1)
  } catch (error) {
    console.error('Proactive check failed', error)
  } finally {
    ticking = false
  }
}

export function startProactive(s: Speaker) {
  speaker = s
  clearInterval(timer)
  timer = setInterval(() => void tick(), minute)
  clearTimeout(startupTimer)
  startupTimer = setTimeout(() => void tick(), 15000)
}
export function stopProactive() {
  clearTimeout(startupTimer)
  clearInterval(timer)
  clearInterval(showing?.timer)
}
/** For self-tests and the settings page: look now instead of waiting for the next minute. */
export const checkNow = () => tick()
export { changed as proactiveChanged }
