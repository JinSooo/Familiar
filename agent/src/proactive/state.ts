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
import type { ProactiveMessage } from '../../../src/shared'
import { dataDir } from '../system'
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
      fired: raw.fired && typeof raw.fired === 'object' ? raw.fired : {},
      days: raw.days && typeof raw.days === 'object' ? raw.days : {},
      ...(typeof raw.quietUntil === 'number'
        ? { quietUntil: raw.quietUntil }
        : {}),
    }
  } catch {
    cache = { history: [], fired: {}, days: {} }
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

/** What the user did with a proactive message, for future evaluation (docs/design.md §12). */
export async function recordProactiveFeedback(
  message: ProactiveMessage,
): Promise<void> {
  const dir = join(dataDir, 'evals')
  await mkdir(dir, { recursive: true })
  await appendFile(
    join(dir, 'proactive-feedback.jsonl'),
    `${JSON.stringify({ ...message, at: new Date(message.at).toISOString() })}\n`,
    { mode: 0o600 },
  )
}

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

export const reminderInstructions = `用户要你在某个时间提醒他时，用 remind，时间按下面给的“现在”换算成绝对时间；只说“待会儿”这类没有时间的，先问清楚。用户问有哪些提醒用 list_reminders，要取消用 cancel_reminder。设好后用一句话复述时间和内容。
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
    list_reminders: tool({
      description: '列出还没到的提醒和跟进。',
      inputSchema: z.object({}),
      execute: async () =>
        (await readReminders())
          .filter((r) => !r.done)
          .map((r) => ({
            id: r.id,
            at: stamp(r.at),
            text: r.text,
            kind: r.kind,
          })),
    }),
    cancel_reminder: tool({
      description: '取消一个提醒，id 来自 list_reminders 或 remind 的结果。',
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
