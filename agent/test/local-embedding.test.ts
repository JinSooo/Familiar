import { describe, expect, test } from 'bun:test'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { embedderFor } from '../src/embedding'
import { stopLeftoverServer } from '../src/local-embedding'
import { dataDir } from '../src/system'
import { settingsSchema } from '../../src/shared'

describe('local embeddings', () => {
  test('a stale pid that is not llama-server is left alone', async () => {
    const dir = join(dataDir, 'models')
    await mkdir(dir, { recursive: true })
    // The test runner itself: signalling it would end the run.
    await writeFile(join(dir, 'llama-server.pid'), String(process.pid))
    await stopLeftoverServer()
    expect(
      await readFile(join(dir, 'llama-server.pid'), 'utf8').catch(() => null),
    ).toBeNull()
  })

  test('local means full-text only until the model is downloaded', () => {
    const settings = settingsSchema.parse({
      embeddingModel: { source: 'local' },
    })
    expect(embedderFor(settings, false)).toBeUndefined()
    expect(embedderFor(settings, true)?.key).toBe(
      'local|qwen3-embedding-0.6b-q8',
    )
    // An online source with no model stays off, as before.
    expect(embedderFor(settingsSchema.parse({}))).toBeUndefined()
  })
})
