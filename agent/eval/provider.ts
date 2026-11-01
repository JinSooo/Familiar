/**
 * promptfoo `exec:` provider (see promptfooconfig.yaml). promptfoo runs, from this directory,
 * `bun provider.ts <prompt> <options json> <context json>` and reads stdout.
 *
 * - kind=reflect: one real reflection call with the configured background model (costs a
 *   request), printed with the candidates that would survive the sensitive filter.
 * - kind=recall: builds a throwaway memory from `memories` and prints what the index finds.
 * - kind=perception: one real Computer History summary of `activity` (segment lines as
 *   describe() writes them) with the background model.
 * - kind=proactive: one real speak-or-not decision for `facts`, with `context` and `recent`.
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
    else await store.add({ category: where as 'profile' | 'habits', text })
  }
  const index = new MemoryIndex(store, join(dir, 'index.sqlite'))
  const hits = await index.search(vars.query!)
  process.stdout.write(JSON.stringify({ hits: hits.map((h) => h.text) }))
} else if (vars.kind === 'proactive') {
  const { loadSettings } = await import('../src/settings')
  const { backgroundModel } = await import('../src/memory/jobs')
  const { decide } = await import('../src/proactive/decide')
  await loadSettings()
  const decision = await decide({
    model: backgroundModel(),
    name: '小黑',
    facts: vars.facts!.trim(),
    context: vars.context?.trim() || '相处：和主人刚认识不久。你现在精神不错。',
    recent: vars.recent?.trim() ?? '',
  })
  process.stdout.write(JSON.stringify(decision))
} else if (vars.kind === 'perception') {
  const { loadSettings } = await import('../src/settings')
  const { backgroundModel } = await import('../src/memory/jobs')
  const { digestActivity } = await import('../src/perception/summarize')
  await loadSettings()
  const digest = await digestActivity(
    backgroundModel(),
    vars.activity!.trim(),
    vars.existing?.trim() ||
      '已确认：\n（无）\n\n待确认：\n（无）\n\n当天时间线：\n（无）',
  )
  process.stdout.write(JSON.stringify(digest))
} else {
  const { loadSettings } = await import('../src/settings')
  const { backgroundModel } = await import('../src/memory/jobs')
  const { reflectOn } = await import('../src/memory/reflect')
  const { sensitiveReason } = await import('../src/memory/sensitive')
  await loadSettings()
  const reflection = await reflectOn(
    backgroundModel(),
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
