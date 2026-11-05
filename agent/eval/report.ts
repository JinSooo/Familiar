/**
 * pnpm eval:report — how speaking up has gone, by trigger, from ~/.familiar/evals: what the
 * user did with each bubble, whether they were at the Mac, how often the model held back or
 * failed, and how many real moments are labeled. `--days N` looks back N days (default 14).
 */
import {
  type FeedbackRow,
  moments,
  outcomeNames,
  readDecisions,
  readFeedback,
  triggerNames,
} from './real'

const at = process.argv.indexOf('--days')
const days = at > 0 ? Number(process.argv[at + 1]) || 14 : 14
const since = Date.now() - days * 86400000
const recent = <T extends { at: string }>(rows: T[]) =>
  rows.filter((r) => Date.parse(r.at) >= since)

// One row per bubble: a line reopened from the missed list is answered twice, the last counts.
const bubbles = [
  ...new Map(recent(readFeedback()).map((f) => [f.id, f])).values(),
]
const decisions = recent(readDecisions())

const width = (s: string) =>
  [...s].reduce((n, ch) => n + (/[⺀-￿]/.test(ch) ? 2 : 1), 0)
const cell = (s: string | number, n: number) => {
  const t = String(s)
  return t + ' '.repeat(Math.max(0, n - width(t)))
}
function table(head: string[], rows: (string | number)[][]) {
  const widths = head.map((h, i) =>
    Math.max(width(h), ...rows.map((r) => width(String(r[i])))),
  )
  const line = (r: (string | number)[]) =>
    r.map((v, i) => cell(v, widths[i]!)).join('  ')
  console.log(line(head))
  for (const r of rows) console.log(line(r))
}
const median = (xs: number[]) => {
  if (!xs.length) return '-'
  const s = [...xs].sort((a, b) => a - b)
  return String(s[Math.floor(s.length / 2)])
}
const pct = (a: number, b: number) =>
  b ? `${Math.round((100 * a) / b)}%` : '-'
const triggers = (rows: { trigger: string }[]) =>
  [...new Set(rows.map((r) => r.trigger))].sort()
const name = (t: string) => triggerNames[t] ?? t

console.log(`最近 ${days} 天\n`)
console.log('说出口的气泡')
if (!bubbles.length) console.log('（没有）')
else {
  const row = (label: string, rows: FeedbackRow[]) => {
    const n = (r: FeedbackRow['response']) =>
      rows.filter((f) => f.response === r).length
    const seen = rows.length - n('missed')
    return [
      label,
      rows.length,
      n('ok'),
      n('later'),
      n('quiet'),
      n('ignored'),
      n('missed'),
      // 没看到 is not a reply either way (AGENTS.md): the rate is over bubbles that were seen.
      pct(n('ok') + n('later'), seen),
      median(
        rows.flatMap((f) => (f.idleAtShow === undefined ? [] : [f.idleAtShow])),
      ),
    ]
  }
  const own = bubbles.filter((f) => f.trigger !== 'reminder')
  table(
    [
      '触发',
      '次数',
      outcomeNames.ok,
      outcomeNames.later,
      outcomeNames.quiet,
      outcomeNames.ignored,
      outcomeNames.missed,
      '回应率',
      '出现时空闲秒',
    ],
    [
      ...triggers(bubbles).map((t) =>
        row(
          name(t),
          bubbles.filter((f) => f.trigger === t),
        ),
      ),
      ...(own.length && own.length < bubbles.length
        ? [row('自己说的合计', own)]
        : []),
    ],
  )
  console.log('回应率 =（好 + 稍后）÷ 看到了的（不算没看到）')
}

console.log('\n问过模型的')
if (!decisions.length)
  console.log(
    '（还没有记录：新版本运行后每次判断都会记下，之前的反馈没有判断材料）',
  )
else {
  const all = moments().filter((m) => Date.parse(m.decision.at) >= since)
  table(
    ['触发', '问了', '要说', '没开口', '出错', '说出口了', '已标注'],
    triggers(decisions).map((t) => {
      const rows = all.filter((m) => m.decision.trigger === t)
      const n = (f: (m: (typeof rows)[number]) => boolean) =>
        rows.filter(f).length
      return [
        name(t),
        rows.length,
        n((m) => Boolean(m.decision.decision?.speak)),
        n((m) => m.outcome === 'silent'),
        n((m) => m.outcome === 'failed'),
        n((m) => Boolean(m.feedback)),
        n((m) => m.speak !== undefined),
      ]
    }),
  )
  const waiting = all.filter((m) => m.speak === undefined).length
  if (waiting) console.log(`\n${waiting} 条还没标，pnpm eval:label 去标。`)
}
