/**
 * promptfoo `exec:` provider (see promptfooconfig.yaml). promptfoo runs, from this directory,
 * `bun provider.ts <prompt> <options json> <context json>` and reads stdout.
 *
 * - kind=reflect: one real reflection call with the configured background model (costs a
 *   request), printed with the candidates that would survive the sensitive filter.
 * - kind=recall: builds a throwaway memory from `memories` and prints what the index finds.
 * - kind=perception: one real Computer History summary of `activity` (segment lines as
 *   describe() writes them) with the background model.
 * - kind=proactive: one real speak-or-not decision for `facts`, with `context` and `recent`;
 *   real cases (real-tests.ts) also pass the pet's `name` and the original moment `now`.
 *
 * FAMILIAR_EVAL_MODEL=<model name> runs the model calls with that model instead of the
 * configured background model (same address and key), to compare models.
 */
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { homedir } from 'node:os'

process.env.FAMILIAR_DATA_DIR ??= join(homedir(), '.familiar')
// Logs go to stderr so stdout is only the result.
console.log = console.error

const { vars } = JSON.parse(process.argv[4] ?? '{}') as {
  vars: Record<string, string>
}

async function evalModel() {
  const { loadSettings, getSettings } = await import('../src/settings')
  const { backgroundModel } = await import('../src/memory/jobs')
  const { createModel } = await import('../src/agent/provider')
  await loadSettings()
  const other = process.env.FAMILIAR_EVAL_MODEL?.trim()
  return other
    ? createModel({ ...getSettings().model, model: other })
    : backgroundModel()
}

if (vars.kind === 'recall') {
  const { MemoryStore, MemoryIndex } = await import('../src/memory')
  const dir = mkdtempSync(join(tmpdir(), 'familiar-eval-'))
  const store = new MemoryStore(join(dir, 'memory'))
  for (const line of vars.memories!.trim().split('\n')) {
    const [where, text] = line.split('|') as [string, string]
    if (where.startsWith('timeline:'))
      await store.appendTimeline(where.slice(9), text)
    else if (where.startsWith('topic:'))
      await store.add({ category: 'topic', topic: where.slice(6), text })
    else
      await store.add({
        category: where as 'profile' | 'habits' | 'lessons',
        text,
      })
  }
  const index = new MemoryIndex(store, join(dir, 'index.sqlite'))
  const hits = await index.search(vars.query!)
  process.stdout.write(JSON.stringify({ hits: hits.map((h) => h.text) }))
} else if (vars.kind === 'proactive') {
  const { decide } = await import('../src/proactive/decide')
  const decision = await decide({
    model: await evalModel(),
    name: vars.name || '小黑',
    persona: vars.persona ?? '',
    facts: vars.facts!.trim(),
    context: vars.context?.trim() || '相处：和主人刚认识不久。你现在精神不错。',
    recent: vars.recent?.trim() ?? '',
    ...(vars.now ? { now: new Date(vars.now) } : {}),
  })
  process.stdout.write(JSON.stringify(decision))
} else if (vars.kind === 'perception') {
  const { digestActivity } = await import('../src/perception/summarize')
  const digest = await digestActivity(
    await evalModel(),
    vars.activity!.trim(),
    vars.existing?.trim() ||
      '已确认：\n（无）\n\n待确认：\n（无）\n\n当天时间线：\n（无）',
  )
  process.stdout.write(JSON.stringify(digest))
} else {
  const { reflectOn } = await import('../src/memory/reflect')
  const { sensitiveReason } = await import('../src/memory/sensitive')
  const reflection = await reflectOn(
    await evalModel(),
    vars.conversation!.trim(),
    vars.existing?.trim() || '已确认：\n（无）\n\n待确认：\n（无）',
  )
  process.stdout.write(
    JSON.stringify({
      ...reflection,
      stored: reflection.candidates
        .filter((c) => !sensitiveReason(c.text))
        .map((c) => c.text),
    }),
  )
}
