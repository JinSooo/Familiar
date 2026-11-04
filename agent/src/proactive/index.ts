import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import type {
  ProactiveMessage,
  ProactiveStatus,
  ProactiveTrigger,
  Reminder,
} from '../../../src/shared'
import { getSettings } from '../settings'
import { idleSeconds } from '../system'
import { buffer } from '../perception'
import { backgroundModel } from '../memory/jobs'
import { memoryContext, openMemory } from '../memory'
import { today } from '../memory/store'
import { decide } from './decide'
import { readReminders, stamp, updateReminders } from './reminders'
import { breakpoint, budget, candidates, pace } from './rules'
import {
  companionContext,
  readState,
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
  /** Put the message in the bubble. */
  say(message: ProactiveMessage): void
  /** The status changed (settings page, panel). */
  changed(status: ProactiveStatus): void
}

function sensorPath(): string | null {
  const candidates = [
    join(dirname(process.execPath), 'familiar-sensor'),
    fileURLToPath(
      new URL('../../../sensor/.build/familiar-sensor', import.meta.url),
    ),
  ]
  return candidates.find((p) => existsSync(p)) ?? null
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
let ticking = false
/** The message on screen, so a click can answer it and a timeout can mark it ignored. */
let showing:
  | { message: ProactiveMessage; timer: ReturnType<typeof setTimeout> }
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
  }
}
async function changed() {
  speaker?.changed(await proactiveStatus())
}

/** No keyboard or mouse for this long means the user is away. */
const awayAfter = 120
/**
 * How long a bubble stays before it counts as ignored: the pet's own ideas fade quickly, a
 * reminder the user asked for waits so a glance away does not lose it.
 */
const showFor = (m: ProactiveMessage) =>
  m.trigger === 'reminder' ? 10 * minute : 45000
async function show(message: ProactiveMessage) {
  await updateState((s) => {
    s.history.unshift(message)
  })
  clearTimeout(showing?.timer)
  showing = {
    message,
    timer: setTimeout(
      () => void respond(message.id, 'ignored'),
      showFor(message),
    ),
  }
  speaker?.say(message)
  void changed()
}

/** What the user did with a bubble. 别烦我 holds for the rest of the day. */
export async function respond(
  id: string,
  response: NonNullable<ProactiveMessage['response']>,
): Promise<ProactiveMessage | undefined> {
  if (showing?.message.id === id) {
    clearTimeout(showing.timer)
    showing = undefined
  }
  let answered: ProactiveMessage | undefined
  await updateState((s) => {
    const m = s.history.find((x) => x.id === id)
    if (!m || m.response) return
    m.response = response
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
  void recordProactiveFeedback(answered).catch(console.error)
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

const newId = () => `p${Date.now().toString(36)}`

/** The model's take on the latest activity summary, waiting for a good moment to be said. */
let queued:
  { text: string; reason: string; facts: string; expires: number } | undefined
/** A line about what the user is doing goes stale after this. */
const freshFor = 40 * minute

const responses = {
  ok: '回应了',
  later: '稍后',
  quiet: '别烦我',
  ignored: '没理',
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
/** Memory, closeness and energy, upcoming reminders, and what was said lately: what the model decides from. */
async function material(now: number, todos = false) {
  const state = await readState()
  const memory = openMemory()
  const reminders = await upcoming(now, todos)
  return {
    context: [
      companionContext(state, new Date(now)),
      `关于主人的记忆：\n${(await memoryContext(memory.store, 1500, 0).catch(() => '')) || '（暂无）'}`,
      ...(reminders ? [reminders] : []),
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
    const decision = await decide({
      model: backgroundModel(),
      name: settings.pet.name,
      facts,
      ...(await material(now)),
    })
    await updateState((s) => {
      s.fired.activity = now
    })
    if (decision.speak)
      queued = {
        text: decision.text,
        reason: decision.reason || digest.title,
        facts,
        expires: now + freshFor,
      }
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

async function tick() {
  if (ticking || !speaker) return
  ticking = true
  try {
    const now = Date.now()
    const settings = getSettings()
    const state = await readState()
    if (showing || speaker.busy()) return
    // Nobody at the Mac: a bubble would time out unseen and count as ignored. Due reminders
    // wait and show within a minute of the user coming back.
    const idle = await idleSeconds().catch(() => 0)
    if (idle >= awayAfter) return

    // 1. Reminders the user asked for: always, except quiet hours (they wait).
    const due = await dueReminders(now)
    const asked = due.find((r) => r.kind === 'reminder')
    const silence = budget({
      settings: settings.proactive,
      history: state.history,
      days: state.days,
      now,
      quietUntil: state.quietUntil,
    })
    if (asked) {
      if (silence.reason === '免打扰时段') return
      if (await inTheWay()) return
      await updateReminders((list) => ({
        list: list.map((r) => (r.id === asked.id ? { ...r, done: now } : r)),
        result: undefined,
      }))
      const late = now - asked.at > 5 * minute
      return await show({
        id: newId(),
        at: now,
        trigger: 'reminder',
        text: asked.text,
        reason: late ? `你设的提醒（${stamp(asked.at)}）` : '你设的提醒',
      })
    }

    // 2. The pet's own ideas. Budget first; then only at a moment that costs little to interrupt.
    if (silence.reason) return
    const watching = settings.perception.enabled && !settings.perception.paused
    const events = watching
      ? await buffer.read(now - 4 * 60 * minute).catch(() => [])
      : []
    const moment = breakpoint({ events, now, idle })
    if (queued && queued.expires < now) queued = undefined

    // The day's start and coming back are good moments in themselves.
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
    if (await inTheWay()) return

    // A line already decided from what the user is doing goes first: it is about now.
    if (queued && !opening) {
      const line = queued
      queued = undefined
      return await show({
        id: newId(),
        at: now,
        trigger: 'activity',
        text: line.text,
        reason: line.reason,
      })
    }

    const followUp = due.find((r) => r.kind === 'follow-up')
    let trigger: ProactiveTrigger | undefined
    let facts = ''
    if (opening) {
      trigger = opening.trigger
      facts = opening.facts
    } else if (followUp && settings.proactive.triggers.followUp) {
      trigger = 'follow-up'
      // Said as "now is the time": an absolute date invites the model to second-guess it.
      facts = `到了之前记下要跟进的时候，该关心一下这件事了：${followUp.text}`
    } else if (care[0]) {
      trigger = care[0].trigger
      facts = care[0].facts
    }
    if (!trigger) return
    // Fired whether or not the model speaks, so a quiet "no" is not asked again every minute.
    await updateState((s) => {
      s.fired[trigger] = now
    })
    if (followUp && trigger === 'follow-up')
      await updateReminders((list) => ({
        list: list.map((r) => (r.id === followUp.id ? { ...r, done: now } : r)),
        result: undefined,
      }))
    const decision = await decide({
      model: backgroundModel(),
      name: settings.pet.name,
      facts,
      ...(await material(now, trigger === 'firstToday')),
    })
    if (!decision.speak) return
    // Things may have changed while the model thought.
    if (showing || speaker.busy()) return
    await show({
      id: newId(),
      at: Date.now(),
      trigger,
      text: decision.text,
      reason: decision.reason || facts.slice(0, 30),
    })
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
  setTimeout(() => void tick(), 15000)
}
export function stopProactive() {
  clearInterval(timer)
  clearTimeout(showing?.timer)
}
/** For self-tests and the settings page: look now instead of waiting for the next minute. */
export const checkNow = () => tick()
export { changed as proactiveChanged }
