import {
  appendFile,
  mkdir,
  readFile,
  rename,
  writeFile,
} from 'node:fs/promises'
import { join } from 'node:path'
import { tool, type ToolSet } from 'ai'
import { z } from 'zod'
import type {
  ProactiveHeld,
  ProactiveMessage,
  ProactiveTrigger,
} from '../../../src/shared'
import { dataDir } from '../system'
import type { Decision } from './decide'
import {
  newReminderId,
  readReminders,
  stamp,
  updateReminders,
} from './reminders'

/**
 * What the pet keeps about speaking up, in ~/.familiar/proactive.json (not the workspace: it
 * is app state, never prompt material beyond the lines quoted back):
 * - history: the last week of proactive messages and reminders, with the user's response
 * - fired: when each rule trigger last went off, so each fires once per occasion
 * - quietUntil: 别烦我
 * - days: on which days the user talked to the pet, for closeness
 */
export interface ProactiveState {
  history: ProactiveMessage[]
  /** Triggers that came to nothing, so the settings page can say why it stayed quiet. */
  held: ProactiveHeld[]
  fired: Record<string, number>
  quietUntil?: number
  /** "YYYY-MM-DD" → messages the user sent that day. */
  days: Record<string, number>
}
const file = () => join(dataDir, 'proactive.json')
let cache: ProactiveState | undefined
export async function readState(): Promise<ProactiveState> {
  if (cache) return cache
  try {
    const raw = JSON.parse(
      await readFile(file(), 'utf8'),
    ) as Partial<ProactiveState>
    cache = {
      history: Array.isArray(raw.history) ? raw.history : [],
      held: Array.isArray(raw.held) ? raw.held : [],
      fired: raw.fired && typeof raw.fired === 'object' ? raw.fired : {},
      days: raw.days && typeof raw.days === 'object' ? raw.days : {},
      ...(typeof raw.quietUntil === 'number'
        ? { quietUntil: raw.quietUntil }
        : {}),
    }
  } catch {
    cache = { history: [], held: [], fired: {}, days: {} }
  }
  return cache
}
let queue: Promise<unknown> = Promise.resolve()
export function updateState(
  change: (state: ProactiveState) => void,
): Promise<ProactiveState> {
  const work = async () => {
    const state = await readState()
    change(state)
    const week = Date.now() - 7 * 86400000
    state.history = state.history
      .filter((m) => m.at > week)
      .sort((a, b) => b.at - a.at)
      .slice(0, 200)
    state.held = state.held
      .filter((h) => h.at > Date.now() - 2 * 86400000)
      .sort((a, b) => b.at - a.at)
      .slice(0, 30)
    const days = Object.keys(state.days).sort()
    for (const d of days.slice(0, Math.max(0, days.length - 120)))
      delete state.days[d]
    await mkdir(dataDir, { recursive: true })
    await writeFile(`${file()}.tmp`, JSON.stringify(state, null, 2), {
      mode: 0o600,
    })
    await rename(`${file()}.tmp`, file())
    return state
  }
  const next = queue.then(work, work)
  queue = next.catch(() => {})
  return next
}

async function appendEval(name: string, row: object) {
  const dir = join(dataDir, 'evals')
  await mkdir(dir, { recursive: true })
  await appendFile(join(dir, name), `${JSON.stringify(row)}\n`, {
    mode: 0o600,
  })
}

/** What the user did with a proactive message, for evaluation (docs/design.md §12). */
export async function recordProactiveFeedback(
  message: ProactiveMessage,
  /** Seconds without keyboard or mouse input when it appeared and when it ended. */
  evidence?: { idleAtShow: number; idleAtEnd: number },
): Promise<void> {
  await appendEval('proactive-feedback.jsonl', {
    ...message,
    at: new Date(message.at).toISOString(),
    ...evidence,
  })
}

/**
 * One speak-or-not call with everything the model was given, so a real moment can be replayed
 * as an eval case (agent/eval/real.ts). Feedback rows point back here through `decision`.
 */
export interface DecisionRecord {
  id: string
  /** ISO time it was asked; the prompt's "现在是" is rebuilt from it. */
  at: string
  trigger: ProactiveTrigger
  name: string
  facts: string
  context: string
  recent: string
  model: string
  decision?: Decision
  error?: string
}
export const recordDecision = (row: DecisionRecord) =>
  appendEval('proactive-decisions.jsonl', row)

/**
 * Closeness from how many days the user talked to the pet; energy from the clock. Both are the
 * simple first versions the design asks for, written as words for the model.
 */
export function companionContext(state: ProactiveState, now: Date): string {
  const days = Object.values(state.days).filter((n) => n > 0).length
  const closeness =
    days < 3 ? '刚认识不久' : days < 14 ? '已经比较熟了' : '是老朋友了'
  const hour = now.getHours()
  const energy =
    hour >= 23 || hour < 6
      ? '深夜，有点困'
      : hour < 9
        ? '早上，刚醒'
        : hour >= 13 && hour < 15
          ? '午后，有点懒'
          : '精神不错'
  return `相处：和主人${closeness}（聊过 ${days} 天）。你现在${energy}。`
}

/** Words that name a later day: such a line is a reminder for that day, not a to-do. */
const laterDay =
  /明天|明早|明晚|后天|下周|周末|(?:周|星期|礼拜)[一二三四五六日天]|\d{1,2}\s*月\s*\d{1,2}\s*[日号]/

export const reminderInstructions = `用户要你在某个时间提醒他时，用 remind，时间按下面给的“现在”换算成绝对时间；只说“待会儿”这类没有时间的，先问清楚。只说了哪天、没说几点的（“明天要修复两个问题”“周五前交报告”），也是提醒不是待办：用 remind 定在那天早上 9:00（“明晚”定 20:00，“周末”定周六 9:00），复述时说清楚“明早 9 点提醒你”，用户可以改。用户让你记一件没有具体时间的待办（“记一下要买牛奶”“别忘了回邮件”）时，用 add_todo，不要自己编时间；待办不会到点弹出，只在合适的时候被想起。用户问有哪些提醒或待办用 list_reminders，要取消用 cancel_reminder。设好后用一句话复述时间和内容。
用户提到之后要发生的具体事情（面试、考试、出差、交付），并且值得过后关心一下时，可以用 remind 的 follow_up=true 记一个跟进，时间定在那件事之后；不用告诉用户，也不要滥用，一次对话最多一个。`

export function createReminderTools(onChange: () => void): ToolSet {
  const when = z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/)
    .describe('本地时间，格式 YYYY-MM-DD HH:MM')
  return {
    remind: tool({
      description:
        '在某个时间提醒用户（到点在桌面宠物的气泡里说）；follow_up=true 表示这是你自己记下、到时关心一下的跟进。',
      inputSchema: z.object({
        at: when,
        text: z
          .string()
          .min(1)
          .max(200)
          .describe('到时要说的事，写成提醒的内容'),
        follow_up: z.boolean().optional(),
      }),
      execute: async ({ at, text, follow_up }) => {
        const time = new Date(at.replace(' ', 'T') + ':00').getTime()
        if (!Number.isFinite(time)) return { error: '时间无效' }
        if (time < Date.now() - 60000) return { error: '这个时间已经过去了' }
        const id = newReminderId()
        await updateReminders((list) => ({
          list: [
            ...list,
            {
              id,
              at: time,
              text: text.trim(),
              kind: follow_up ? 'follow-up' : 'reminder',
            },
          ],
          result: undefined,
        }))
        onChange()
        return { id, at: stamp(time), text }
      },
    }),
    add_todo: tool({
      description:
        '记一件没有日期也没有时间的待办（比如“记一下要买牛奶”）；它不会到点弹出，只在合适的时候被想起。说了哪天（明天、周五、11 月 8 日）或几点的都用 remind，只有日期时定在那天 9:00。',
      inputSchema: z.object({
        text: z.string().min(1).max(200).describe('待办的内容'),
      }),
      execute: async ({ text }) => {
        const body = text.replace(/\s+/g, ' ').trim()
        if (!body) return { error: '内容为空' }
        // A line that starts with a date and time would be read back as a reminder.
        if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}( |$)/.test(body))
          return { error: '有具体时间的事请用 remind' }
        // A to-do never pops up, so "明天要……" saved as one is silently never brought up.
        if (laterDay.test(body))
          return {
            error:
              '说了哪一天的事请用 remind（没说几点就定在那天 9:00），待办不会到点提醒',
          }
        const id = newReminderId()
        await updateReminders((list) => ({
          list: [...list, { id, text: body, kind: 'todo' }],
          result: undefined,
        }))
        onChange()
        return { id, text: body }
      },
    }),
    list_reminders: tool({
      description: '列出还没到的提醒、跟进和待办。',
      inputSchema: z.object({}),
      execute: async () =>
        (await readReminders())
          .filter((r) => !r.done)
          .map((r) => ({
            id: r.id,
            ...(r.at === undefined ? {} : { at: stamp(r.at) }),
            text: r.text,
            kind: r.kind,
          })),
    }),
    cancel_reminder: tool({
      description:
        '取消一个提醒或待办，id 来自 list_reminders、remind 或 add_todo 的结果。',
      inputSchema: z.object({ id: z.string() }),
      execute: async ({ id }) => {
        const found = await updateReminders((list) => ({
          list: list.filter((r) => r.id !== id),
          result: list.some((r) => r.id === id),
        }))
        onChange()
        return found ? { cancelled: id } : { error: '没有这个提醒' }
      },
    }),
  }
}
