/**
 * What the user chose before, as material for the speak-or-not call (docs/design.md §12, P5
 * round two): whether to speak again on the same thing is a feel the user has, not a rule, so
 * the pet leans on what they chose in like moments. Built from ~/.familiar/evals: the user's own
 * labels first, else 好 / 稍后 (wanted) and 别烦我 (not wanted). 没理 and 没看到 count for nothing.
 *
 * Plain Node, no Bun: the eval loader (agent/eval/real.ts) builds the same block for replays.
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

export const triggerNames: Record<string, string> = {
  reminder: '提醒',
  'follow-up': '跟进',
  longWork: '连续工作',
  back: '回来',
  firstToday: '每天第一次',
  activity: '在做的事',
  lateNight: '深夜',
}

interface DecisionLike {
  id: string
  at: string
  trigger: string
  facts: string
  decision?: { speak: boolean; text: string }
  error?: string
}
interface FeedbackLike {
  decision?: string
  response: string
}
/** One past moment the user has a verdict on. */
export interface Choice {
  at: number
  trigger: string
  facts: string
  /** What it said; absent when it stayed quiet. */
  said?: string
  want: boolean
}

export function choices(
  decisions: DecisionLike[],
  feedback: FeedbackLike[],
  labels: Record<string, { speak: boolean }>,
): Choice[] {
  // A line brought back from the missed list is answered again; the last answer stands.
  const answers = new Map<string, string>()
  for (const f of feedback) if (f.decision) answers.set(f.decision, f.response)
  return decisions.flatMap((d) => {
    if (d.error) return []
    const answer = answers.get(d.id)
    const want =
      labels[d.id]?.speak ??
      (answer === 'ok' || answer === 'later'
        ? true
        : answer === 'quiet'
          ? false
          : undefined)
    if (want === undefined) return []
    const said = d.decision?.speak ? d.decision.text : undefined
    return [
      {
        at: Date.parse(d.at),
        trigger: d.trigger,
        facts: d.facts,
        ...(said ? { said } : {}),
        want,
      },
    ]
  })
}

function jsonl<T>(file: string): T[] {
  if (!existsSync(file)) return []
  return readFileSync(file, 'utf8')
    .split('\n')
    .flatMap((line) => {
      try {
        return line.trim() ? [JSON.parse(line) as T] : []
      } catch {
        return []
      }
    })
}
export function readChoices(evalsDir: string): Choice[] {
  let labels: Record<string, { speak: boolean }> = {}
  try {
    labels = JSON.parse(readFileSync(join(evalsDir, 'labels.json'), 'utf8'))
  } catch {
    // No labels yet.
  }
  return choices(
    jsonl(join(evalsDir, 'proactive-decisions.jsonl')),
    jsonl(join(evalsDir, 'proactive-feedback.jsonl')),
    labels,
  )
}

const slot = (hour: number) =>
  hour < 6 || hour >= 23
    ? '深夜'
    : hour < 12
      ? '上午'
      : hour < 18
        ? '下午'
        : '晚上'
const pad = (n: number) => String(n).padStart(2, '0')
const when = (at: number) => {
  const d = new Date(at)
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}
const cut = (text: string, max: number) => {
  const chars = [...text.replace(/\s+/g, ' ').trim()]
  return chars.length > max
    ? `${chars.slice(0, max).join('')}…`
    : chars.join('')
}
export const leaningsTitle = '主人以前的选择'

/** The block for one trigger at `now`, from moments before it; empty when there is none. */
export function leanings(all: Choice[], trigger: string, now: Date): string {
  const same = all
    .filter((c) => c.trigger === trigger && c.at < now.getTime())
    .sort((a, b) => b.at - a.at)
  if (!same.length) return ''
  const count = (list: Choice[]) => {
    const yes = list.filter((c) => c.want).length
    return `想听 ${yes} 次，不想听 ${list.length - yes} 次`
  }
  const here = slot(now.getHours())
  const inSlot = same.filter((c) => slot(new Date(c.at).getHours()) === here)
  const name = triggerNames[trigger] ?? trigger
  const lines = [
    `${leaningsTitle}（想听：点了好 / 稍后或标了该说；不想听：点了别烦我或标了不该说；没理、没看到不算）：`,
    `- 「${name}」一共${count(same)}${inSlot.length >= 2 ? `；${here}${count(inSlot)}` : ''}`,
    '- 最近几次：',
    ...same.slice(0, 6).map((c) => {
      const what = cut(c.facts.replace(/^这段时间主人在做的事：/, ''), 50)
      const did = c.said ? `它说「${cut(c.said, 30)}」` : '它没开口'
      return `  - ${when(c.at)} ${what} → ${did}，主人${c.want ? '想听' : '不想听'}`
    }),
  ]
  return lines.join('\n')
}
