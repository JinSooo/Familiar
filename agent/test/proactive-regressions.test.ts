import { expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Isolate scheduler globals, native probes and model mocks from the rest of the suite.
for (const scenario of [
  'quiet-disabled',
  'quiet-muted',
  'dates',
  'date-tool',
  'hidden',
  'hidden-watch',
  'hidden-briefly',
  'cancel-race',
  'reschedule-race',
  'final-probe-race',
  'recovery',
  'claim-crash',
  'decision-disabled',
  'decision-quiet',
  'decision-meeting',
  'decision-away',
  'follow-up-busy',
  'clock-forward',
  'clock-backward',
  'sleep',
  'editor-race',
  'main-busy',
  'quick-busy',
  'startup',
]) {
  test(`proactive regression: ${scenario}`, async () => {
    const root = await mkdtemp(join(tmpdir(), 'familiar-proactive-'))
    try {
      const child = Bun.spawn(
        [
          process.execPath,
          join(import.meta.dir, 'fixtures/proactive-regressions.ts'),
          scenario,
        ],
        {
          env: {
            ...process.env,
            FAMILIAR_DATA_DIR: join(root, 'data'),
            FAMILIAR_CONVERSATIONS_DIR: join(root, 'conversations'),
          },
          stdout: 'pipe',
          stderr: 'pipe',
        },
      )
      const [code, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ])
      expect({ code, output: stdout + stderr }).toEqual({ code: 0, output: '' })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
}
