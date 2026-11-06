/**
 * Real proactive moments from this Mac, for eval cases, the labeler and the report. Reads
 * ~/.familiar/evals/ (or FAMILIAR_DATA_DIR/evals): proactive-decisions.jsonl (what the model was
 * given and said), proactive-feedback.jsonl (what the user did with each bubble) and
 * labels.json (the user's own "should it have spoken"). Nothing here goes into the repo.
 *
 * Plain Node: promptfoo loads this through real-tests.ts, outside Bun.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import {
  leanings,
  leaningsTitle,
  readChoices,
  triggerNames,
} from '../src/proactive/leanings'

export { triggerNames }

export const evalsDir = join(
  process.env.FAMILIAR_DATA_DIR ?? join(homedir(), '.familiar'),
  'evals',
)

export type Response = 'ok' | 'later' | 'quiet' | 'ignored' | 'missed'
export interface DecisionRow {
  id: string
  at: string
  trigger: string
  name: string
  persona?: string
  facts: string
  context: string
  recent: string
  model: string
  decision?: { speak: boolean; text: string; reason: string }
  error?: string
}
export interface FeedbackRow {
  id: string
  at: string
  trigger: string
  text: string
  reason: string
  response: Response
  decision?: string
  idleAtShow?: number
  idleAtEnd?: number
}
/** What became of a decision: the user's answer, or why there was no bubble to answer. */
export type Outcome = Response | 'silent' | 'failed' | 'unsaid'
export const outcomeNames: Record<Outcome, string> = {
  ok: '好',
  later: '稍后',
  quiet: '别烦我',
  ignored: '没理',
  missed: '没看到',
  silent: '没开口',
  failed: '出错',
  unsaid: '没说出口',
}

export interface Label {
  speak: boolean
  at: string
}
export interface Moment {
  decision: DecisionRow
  outcome: Outcome
  feedback?: FeedbackRow
  /** Should it have spoken: the user's label, else 好 / 稍后 (yes) and 别烦我 (no). */
  speak?: boolean
  labeledBy?: 'user' | 'feedback'
}

function jsonl<T>(name: string): T[] {
  const file = join(evalsDir, name)
  if (!existsSync(file)) return []
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter((line) => line.trim())
    .flatMap((line) => {
      try {
        return [JSON.parse(line) as T]
      } catch {
        return []
      }
    })
}
export const readDecisions = () =>
  jsonl<DecisionRow>('proactive-decisions.jsonl')
export const readFeedback = () => jsonl<FeedbackRow>('proactive-feedback.jsonl')

const labelsFile = join(evalsDir, 'labels.json')
export function readLabels(): Record<string, Label> {
  try {
    return JSON.parse(readFileSync(labelsFile, 'utf8')) as Record<string, Label>
  } catch {
    return {}
  }
}
export function writeLabels(labels: Record<string, Label>) {
  writeFileSync(labelsFile, `${JSON.stringify(labels, null, 2)}\n`, {
    mode: 0o600,
  })
}

export function moments(): Moment[] {
  const labels = readLabels()
  // A line brought back from the missed list is answered again; the last answer stands.
  const answers = new Map<string, FeedbackRow>()
  for (const f of readFeedback()) if (f.decision) answers.set(f.decision, f)
  return readDecisions().map((decision) => {
    const feedback = answers.get(decision.id)
    const outcome: Outcome = decision.error
      ? 'failed'
      : !decision.decision?.speak
        ? 'silent'
        : (feedback?.response ?? 'unsaid')
    const label = labels[decision.id]
    const auto =
      outcome === 'ok' || outcome === 'later'
        ? true
        : outcome === 'quiet'
          ? false
          : undefined
    return {
      decision,
      outcome,
      ...(feedback ? { feedback } : {}),
      ...(label
        ? { speak: label.speak, labeledBy: 'user' as const }
        : auto !== undefined
          ? { speak: auto, labeledBy: 'feedback' as const }
          : {}),
    }
  })
}

const pad = (n: number) => String(n).padStart(2, '0')
export function shortTime(iso: string) {
  const d = new Date(iso)
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/** Labeled moments as promptfoo cases: replay the same input, expect the same speak / not. */
export function realCases() {
  const past = readChoices(evalsDir)
  // Logged before the pet read past choices: rebuild that block from the moments before this one,
  // so a replay sees what the pet would see now at that time (never the moment's own label).
  const withChoices = (d: DecisionRow) => {
    if (d.context.includes(leaningsTitle)) return d.context
    const block = leanings(past, d.trigger, new Date(d.at))
    return block ? `${d.context}\n\n${block}` : d.context
  }
  return moments()
    .filter((m) => m.speak !== undefined)
    .map((m) => ({
      description: `真实 ${shortTime(m.decision.at)} ${triggerNames[m.decision.trigger] ?? m.decision.trigger}（${outcomeNames[m.outcome]}）应${m.speak ? '说' : '不说'}`,
      vars: {
        kind: 'proactive',
        name: m.decision.name,
        persona: m.decision.persona ?? '',
        facts: m.decision.facts,
        context: withChoices(m.decision),
        recent: m.decision.recent,
        now: m.decision.at,
      },
      assert: [
        { type: 'javascript', value: `output.speak === ${String(m.speak)}` },
      ],
      metadata: { real: true, decision: m.decision.id },
    }))
}
