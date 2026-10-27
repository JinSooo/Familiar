import { appendFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { dataDir } from '../system'
import type { MemoryEntry } from './store'

/**
 * What the user did with an inference: future evaluation data for reflection (docs/design.md
 * §12). Kept in the app data dir, not the workspace, so it never goes into prompts.
 */
export async function recordFeedback(
  kind: 'confirm' | 'correct' | 'reject',
  entry: MemoryEntry,
  corrected?: string,
): Promise<void> {
  const dir = join(dataDir, 'evals')
  await mkdir(dir, { recursive: true })
  await appendFile(
    join(dir, 'memory-feedback.jsonl'),
    `${JSON.stringify({
      at: new Date().toISOString(),
      kind,
      text: entry.text,
      ...(corrected ? { corrected } : {}),
      category: entry.category,
      target: entry.target,
      source: entry.source,
      confidence: entry.confidence,
      evidence: entry.evidence,
    })}\n`,
    { mode: 0o600 },
  )
}
