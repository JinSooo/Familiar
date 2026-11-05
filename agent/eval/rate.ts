/**
 * Pass rate per case from a promptfoo run with --repeat (pnpm eval:repeat): a model's answer
 * varies, so one pass or fail says little. Runs that errored (network, relay) are counted apart
 * and left out of the rate. Usage: bun agent/eval/rate.ts <promptfoo output.json>
 */
import { readFileSync } from 'node:fs'

const file = process.argv[2]
if (!file)
  throw new Error('用法：bun agent/eval/rate.ts <promptfoo 输出的 json>')
const run = JSON.parse(readFileSync(file, 'utf8')) as {
  results: {
    results: {
      success: boolean
      /** promptfoo: 1 an assertion failed, 2 the provider errored. */
      failureReason?: number
      vars: Record<string, unknown>
      testCase: { description?: string; metadata?: { real?: boolean } }
      response?: { output?: unknown }
    }[]
  }
}
interface Case {
  name: string
  real: boolean
  pass: number
  fail: number
  errors: number
  fails: string[]
}
// Each repeat is its own row with its own index; the description and inputs identify the case.
const cases = new Map<string, Case>()
for (const r of run.results.results) {
  const key = `${r.testCase.description}\n${JSON.stringify(r.vars)}`
  const c = cases.get(key) ?? {
    name: r.testCase.description ?? '（无名用例）',
    real: Boolean(r.testCase.metadata?.real),
    pass: 0,
    fail: 0,
    errors: 0,
    fails: [],
  }
  if (r.success) c.pass++
  else if (r.failureReason === 2) c.errors++
  else {
    c.fail++
    const out = r.response?.output
    c.fails.push(
      (typeof out === 'string' ? out : JSON.stringify(out)).slice(0, 120),
    )
  }
  cases.set(key, c)
}

const rows = [...cases.values()]
const rate = (c: Case) => c.pass / Math.max(c.pass + c.fail, 1)
const sum = (f: (c: Case) => number) => rows.reduce((n, c) => n + f(c), 0)
const judged = sum((c) => c.pass + c.fail)
console.log(
  `${rows.length} 条用例，有结果的 ${judged} 次：通过 ${sum((c) => c.pass)} 次（${Math.round((100 * sum((c) => c.pass)) / Math.max(judged, 1))}%），每次都过的 ${rows.filter((c) => c.fail === 0 && c.pass > 0).length} 条` +
    (sum((c) => c.errors)
      ? `；调用出错 ${sum((c) => c.errors)} 次，不计入`
      : ''),
)
const shaky = rows.filter((c) => c.fail > 0).sort((a, b) => rate(a) - rate(b))
if (shaky.length) console.log('\n没有每次都过的：')
for (const c of shaky) {
  console.log(
    `${c.pass}/${c.pass + c.fail}  ${c.name}${c.real ? '' : '（手写）'}`,
  )
  console.log(`      没过的一次：${c.fails[0]}`)
}
const broken = rows.filter((c) => c.pass + c.fail === 0)
if (broken.length)
  console.log(
    `\n每次都出错、没有结果的：\n${broken.map((c) => `  ${c.name}`).join('\n')}`,
  )
