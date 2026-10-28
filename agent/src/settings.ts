import { dataDir, readKey, writeKey } from './system'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { homedir } from 'node:os'
import {
  settingsSchema,
  type PublicSettings,
  type Settings,
  type SettingsUpdate,
} from '../../src/shared'
let current: Settings
const file = () => join(dataDir, 'settings.json')
export async function loadSettings(): Promise<void> {
  let raw: Record<string, unknown> = {}
  try {
    raw = JSON.parse(await readFile(file(), 'utf8')) as Record<string, unknown>
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
      throw new Error('设置文件损坏或无法读取', { cause: error })
  }
  // Never accept plaintext API keys from disk.
  const model = raw.model && typeof raw.model === 'object' ? raw.model : {}
  current = settingsSchema.parse({ ...raw, model: { ...model, apiKey: '' } })
  current.model.apiKey = await readKey()
  if (current.workspacePath === '~/Familiar')
    current.workspacePath = join(homedir(), 'Familiar')
}
/** Before settings load (tests, early startup) snapshots count as on, the default. */
export function snapshotsEnabled(): boolean {
  return current?.workspaceSnapshots ?? true
}
export function getSettings(): Settings {
  return structuredClone(current)
}
export function publicSettings(): PublicSettings {
  const { apiKey, ...model } = current.model
  return { ...current, model: { ...model, apiKeySet: Boolean(apiKey) } }
}
let saving: Promise<unknown> = Promise.resolve()
export function saveSettings(input: SettingsUpdate): Promise<PublicSettings> {
  const result = saving.then(() => persistSettings(input))
  saving = result.catch(() => undefined)
  return result
}
async function persistSettings(input: SettingsUpdate): Promise<PublicSettings> {
  const next = settingsSchema.parse({
    ...input,
    model: {
      ...input.model,
      apiKey: input.model.apiKey ?? current.model.apiKey,
    },
  })
  const { apiKey, ...model } = next.model
  if (input.model.apiKey !== undefined) await writeKey(apiKey)
  const stored = { ...next, model }
  await mkdir(dataDir, { recursive: true })
  await writeFile(`${file()}.tmp`, JSON.stringify(stored, null, 2), {
    mode: 0o600,
  })
  await rename(`${file()}.tmp`, file())
  current = next
  return publicSettings()
}
