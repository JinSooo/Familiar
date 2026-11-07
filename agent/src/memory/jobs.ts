import { readFile, writeFile } from 'node:fs/promises'
import type { LanguageModel } from 'ai'
import type { ReflectResult } from '../../../src/shared'
import { join } from 'node:path'
import { listConversations, loadConversation } from '../conversations'
import { createModel } from '../agent/provider'
import { getSettings } from '../settings'
import { dataDir } from '../system'
import { ensureWorkspace, snapshot } from '../workspace'
import { openMemory } from '.'
import {
  applyReflection,
  existingMemories,
  reflectOn,
  reflectionInput,
} from './reflect'
import { today } from './store'
import { compressTimeline } from './timeline'

/** A conversation is reflected on once it has been quiet this long, or left for another. */
export const quietAfter = 30 * 60 * 1000
const recentDays = 3
const perRun = 3

/** Conversation id → how many messages have been reflected on. */
type Ledger = Record<string, number>
const ledgerFile = () => join(dataDir, 'reflected.json')
async function readLedger(): Promise<Ledger> {
  try {
    return JSON.parse(await readFile(ledgerFile(), 'utf8')) as Ledger
  } catch {
    return {}
  }
}

/** The small model when one is set, else the main one. */
export function backgroundModel() {
  const config = getSettings().model
  return createModel({
    ...config,
    model: config.smallModel.trim() || config.model,
  })
}

let running: Promise<ReflectResult> | undefined
/**
 * Reflects on recent conversations with unreflected messages. `currentId` is the one still on
 * screen: it waits for `quietAfter` unless `force` (the memory page's "整理" button).
 */
export function reflectDue(
  currentId: string,
  force = false,
): Promise<ReflectResult> {
  running ??= work(currentId, force).finally(() => {
    running = undefined
  })
  return running
}

async function work(currentId: string, force: boolean): Promise<ReflectResult> {
  const result: ReflectResult = {
    conversations: 0,
    pending: 0,
    promoted: 0,
    timeline: 0,
    failed: 0,
  }
  const now = Date.now()
  const ledger = await readLedger()
  const settings = getSettings()
  const workspace = await ensureWorkspace(settings)
  await snapshot(workspace, 'familiar: 保存之前的改动')
  const { store } = openMemory()
  const due = (await listConversations())
    .filter(
      (c) =>
        now - c.updatedAt < recentDays * 86400000 &&
        (ledger[c.id] ?? 0) < c.messages &&
        (force || c.id !== currentId || now - c.updatedAt > quietAfter),
    )
    .reverse()
    .slice(0, perRun)
  let model: LanguageModel | undefined
  try {
    model = backgroundModel()
  } catch (error) {
    // Without a model, roll-ups preserve every line; reflection must wait.
    if (due.length) throw error
  }
  for (const summary of due) {
    try {
      const conversation = await loadConversation(summary.id)
      const from = ledger[summary.id] ?? 0
      const fresh = conversation.messages.slice(from)
      if (fresh.some((m) => m.role === 'user' && m.content.trim())) {
        const last = new Date(conversation.updatedAt)
        const input = reflectionInput(
          conversation.messages,
          from,
          settings.pet.name,
        )
        const reflection = await reflectOn(
          model!,
          input.text,
          await existingMemories(store, today(last)),
        )
        const applied = await applyReflection(
          store,
          reflection,
          {
            id: summary.id,
            day: today(last),
            time: last.toTimeString().slice(0, 5),
          },
          {
            // With Computer History on, the timeline is written per period, from activity and conversations together.
            timeline: !settings.perception.enabled,
            userTexts: input.userTexts,
          },
        )
        result.pending += applied.pending
        result.promoted += applied.promoted
        result.timeline += applied.timeline ? 1 : 0
      }
      result.conversations++
      ledger[summary.id] = conversation.messages.length
      await writeFile(ledgerFile(), JSON.stringify(ledger), { mode: 0o600 })
    } catch (error) {
      result.failed++
      console.error(`Reflecting on ${summary.id} failed:`, error)
    }
  }
  try {
    result.timeline += await compressTimeline(store, model)
  } catch (error) {
    console.error('Timeline roll-up failed:', error)
  }
  if (result.conversations || result.timeline)
    await snapshot(workspace, 'familiar: reflect')
  return result
}
