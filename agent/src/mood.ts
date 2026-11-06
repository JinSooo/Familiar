import { moodNames, type PerceptionEvent, type PetMood } from '../../src/shared'
import { stretches } from './proactive/rules'

const minute = 60000

/**
 * The pet's mood, simple version (docs/design.md §9): rules over what already happened, no model
 * call. First match wins: worried about the user, sleepy late at night, happy right after the
 * user came to it, curious when the user just came back, otherwise calm.
 */
export function moodOf(input: {
  now: number
  hour: number
  /** Raw perception events, oldest first; empty when not watching. */
  events: PerceptionEvent[]
  /** The last turn that ended in an error. */
  failedAt?: number
  /** The user's last message to the pet. */
  chattedAt?: number
  /** The user's last 好 on a proactive line. */
  welcomedAt?: number
}): PetMood {
  const { now, hour, events } = input
  const within = (at: number | undefined, minutes: number) =>
    at !== undefined && now - at < minutes * minute
  const runs = stretches(events, 10 * minute, now)
  const current = runs.at(-1)
  const live = current && now - current.end < 2 * minute
  const length = live ? now - current.start : 0

  if (within(input.failedAt, 15))
    return { mood: 'worried', reason: '刚才出错了' }
  if (length >= 120 * minute)
    return {
      mood: 'worried',
      reason: `你已经连续用了 ${Math.round(length / minute)} 分钟`,
    }
  if (hour >= 23 || hour < 6) return { mood: 'sleepy', reason: '已经深夜了' }
  if (within(input.welcomedAt, 30))
    return { mood: 'happy', reason: '你回应了它的话' }
  if (within(input.chattedAt, 30))
    return { mood: 'happy', reason: '你刚来找它聊天' }
  const before = runs.at(-2)
  if (
    live &&
    before &&
    current.start - before.end >= 30 * minute &&
    now - current.start < 10 * minute
  )
    return { mood: 'curious', reason: '你刚回来' }
  return { mood: 'calm', reason: '一切如常' }
}

let current: PetMood = { mood: 'calm', reason: '一切如常' }
export const currentMood = () => current
/** Returns whether it changed. */
export function setMood(next: PetMood): boolean {
  const changed = next.mood !== current.mood || next.reason !== current.reason
  current = next
  return changed
}
/** One line for the model's prompt, so the tone follows the mood. */
export const moodLine = () =>
  `你现在的心情：${moodNames[current.mood]}（${current.reason}）。`
