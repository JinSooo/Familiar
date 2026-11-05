/**
 * pnpm eval:label — go through the real moments nobody has judged yet and say whether the pet
 * should have spoken. 好 / 稍后 / 别烦我 label themselves; 没理, 没看到, 没开口, 没说出口 and 出错
 * wait here, because "没理" is often "没看到" (AGENTS.md). Answers go to evals/labels.json and
 * become cases in pnpm eval. `--all` also shows moments already labeled, to change them.
 */
import { createInterface } from 'node:readline/promises'
import {
  type Moment,
  moments,
  outcomeNames,
  readLabels,
  shortTime,
  triggerNames,
  writeLabels,
} from './real'

const all = process.argv.includes('--all')
const queue = moments()
  .filter((m) => all || m.speak === undefined)
  .reverse()
if (!queue.length) {
  console.log(
    moments().length
      ? '没有要标的了。'
      : '还没有记录：新版本运行后，每次主动判断都会记进 ~/.familiar/evals/proactive-decisions.jsonl。',
  )
  process.exit(0)
}

function show(m: Moment, i: number) {
  const d = m.decision
  const idle =
    m.feedback?.idleAtShow !== undefined
      ? ` · 气泡出现时 ${m.feedback.idleAtShow} 秒没动键鼠，结束时 ${m.feedback.idleAtEnd} 秒`
      : ''
  console.log(
    `\n[${i + 1}/${queue.length}] ${shortTime(d.at)} ${triggerNames[d.trigger] ?? d.trigger} · ${outcomeNames[m.outcome]}${idle}`,
  )
  if (m.speak !== undefined)
    console.log(
      `已标：${m.speak ? '该说' : '不该说'}（${m.labeledBy === 'user' ? '你标的' : '按反馈'}）`,
    )
  console.log(`情况：${d.facts}`)
  if (d.recent) console.log(`最近说过：\n${d.recent}`)
  if (d.error) console.log(`出错：${d.error}`)
  else if (d.decision?.speak)
    console.log(`它说：「${d.decision.text}」（${d.decision.reason}）`)
  else console.log(`它没开口：${d.decision?.reason || '没给原因'}`)
}

// The iterator buffers lines; rl.question() drops any line that arrives while no question is
// pending, so piped or fast-typed answers were lost and the labeler hung.
const rl = createInterface({ input: process.stdin })
const lines = rl[Symbol.asyncIterator]()
const labels = readLabels()
let done = 0
const finish = (extra = '') => {
  rl.close()
  console.log(`标了 ${done} 条。${extra}`)
  process.exit(0)
}
for (const [i, m] of queue.entries()) {
  show(m, i)
  for (;;) {
    process.stdout.write(
      '该说吗？y 该说 / n 不该说 / s 跳过 / c 看记忆和相处 / q 退出 ',
    )
    const next = await lines.next()
    if (next.done) finish()
    const answer = String(next.value).trim().toLowerCase()
    if (answer === 'c') {
      console.log(m.decision.context)
      continue
    }
    if (answer === 'q') finish()
    if (answer === 'y' || answer === 'n') {
      labels[m.decision.id] = {
        speak: answer === 'y',
        at: new Date().toISOString(),
      }
      writeLabels(labels)
      done++
    }
    if (['y', 'n', 's', ''].includes(answer)) break
  }
}
finish('pnpm eval 会把标过的一起跑。')
