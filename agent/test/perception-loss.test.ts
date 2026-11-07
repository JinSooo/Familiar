import { expect, spyOn, test } from 'bun:test'
import { mkdtempSync } from 'node:fs'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { MockLanguageModelV4 } from 'ai/test'
import { settingsSchema } from '../../src/shared'
import * as settings from '../src/settings'
import * as jobs from '../src/memory/jobs'
import * as memory from '../src/memory'
import { MemoryStore, MemoryIndex } from '../src/memory'
import { buffer, clearEvents, summarizeDue } from '../src/perception'
import { PerceptionBuffer } from '../src/perception/buffer'
import { dataDir } from '../src/system'

for (const minutes of ['all', 10] as const)
  test(`8: clearing ${minutes} during model inference discards candidates, history and cursor`, async () => {
    const dir = mkdtempSync(join(tmpdir(), 'familiar-clear-loss-'))
    const store = new MemoryStore(join(dir, 'memory'))
    const index = new MemoryIndex(store, join(dir, 'index.sqlite'))
    let key = ''
    const events = new PerceptionBuffer(
      join(dir, 'buffer'),
      async () => key,
      async (value) => {
        key = value
      },
    )
    const now = Date.now()
    const from = now - 5 * 60000
    await events.append({
      at: from + 1000,
      kind: 'app',
      bundleId: 'editor',
      app: 'Editor',
    })
    await mkdir(dataDir, { recursive: true })
    const state = join(dataDir, 'perception-summary.json')
    await writeFile(state, JSON.stringify({ until: from }))
    let started!: () => void
    let release!: () => void
    const entered = new Promise<void>((resolve) => {
      started = resolve
    })
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const model = new MockLanguageModelV4({
      doGenerate: async () => {
        started()
        await gate
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                title: '已删除的活动',
                summary: '已删除的活动摘要',
                candidates: [
                  {
                    target: 'habits',
                    text: '用户每天编辑代码',
                    confidence: 0.6,
                    evidence: '编辑器',
                  },
                ],
              }),
            },
          ],
          finishReason: { unified: 'stop', raw: 'stop' },
          usage: {
            inputTokens: {
              total: 1,
              noCache: 1,
              cacheRead: undefined,
              cacheWrite: undefined,
            },
            outputTokens: { total: 1, text: 1, reasoning: undefined },
          },
          warnings: [],
        }
      },
    })
    const spies = [
      spyOn(settings, 'getSettings').mockReturnValue(
        settingsSchema.parse({
          workspacePath: join(dir, 'workspace'),
          workspaceSnapshots: false,
          perception: { enabled: true },
        }),
      ),
      spyOn(settings, 'snapshotsEnabled').mockReturnValue(false),
      spyOn(jobs, 'backgroundModel').mockReturnValue(model),
      spyOn(memory, 'openMemory').mockReturnValue({ store, index }),
      spyOn(buffer, 'read').mockImplementation(events.read.bind(events)),
      spyOn(buffer, 'prune').mockImplementation(events.prune.bind(events)),
      spyOn(buffer, 'clear').mockImplementation(events.clear.bind(events)),
    ]
    let work: Promise<void> | undefined
    try {
      work = summarizeDue(true)
      await entered
      await clearEvents(minutes)
      const clearedState = await readFile(state, 'utf8')
      release()
      await work
      expect(await events.read(from)).toEqual([])
      expect(await store.list()).toEqual([])
      expect(await readFile(state, 'utf8')).toBe(clearedState)
    } finally {
      release()
      await work
      for (const spy of spies) spy.mockRestore()
      index.close()
      await rm(dir, { recursive: true, force: true })
      await rm(state, { force: true })
    }
  })
