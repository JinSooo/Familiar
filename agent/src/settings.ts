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
/** Keychain accounts of the keys besides the chat model's (which uses the default account). */
const keyAccounts = {
  imageModel: 'image-api-key',
  embeddingModel: 'embedding-api-key',
} as const
const keyed = ['imageModel', 'embeddingModel'] as const
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
  const object = (value: unknown) =>
    value && typeof value === 'object' ? value : {}
  current = settingsSchema.parse({
    ...raw,
    model: { ...object(raw.model), apiKey: '' },
    ...Object.fromEntries(
      keyed.map((k) => [k, { ...object(raw[k]), apiKey: '' }]),
    ),
  })
  current.model.apiKey = await readKey()
  for (const k of keyed) current[k].apiKey = await readKey(keyAccounts[k])
  if (current.workspacePath.startsWith('~/'))
    current.workspacePath = join(homedir(), current.workspacePath.slice(2))
}
/** Before settings load (tests, early startup) snapshots count as on, the default. */
export function snapshotsEnabled(): boolean {
  return current?.workspaceSnapshots ?? true
}
export function getSettings(): Settings {
  return structuredClone(current)
}
export function publicSettings(): PublicSettings {
  const hide = <T extends { apiKey: string }>({ apiKey, ...rest }: T) => ({
    ...rest,
    apiKeySet: Boolean(apiKey),
  })
  return {
    ...current,
    model: hide(current.model),
    imageModel: hide(current.imageModel),
    embeddingModel: hide(current.embeddingModel),
  }
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
    ...Object.fromEntries(
      keyed.map((k) => [
        k,
        { ...input[k], apiKey: input[k].apiKey ?? current[k].apiKey },
      ]),
    ),
  })
  if (input.model.apiKey !== undefined) await writeKey(next.model.apiKey)
  for (const k of keyed)
    if (input[k].apiKey !== undefined)
      await writeKey(next[k].apiKey, keyAccounts[k])
  const strip = <T extends { apiKey: string }>({ apiKey: _, ...rest }: T) =>
    rest
  const stored = {
    ...next,
    model: strip(next.model),
    imageModel: strip(next.imageModel),
    embeddingModel: strip(next.embeddingModel),
  }
  await mkdir(dataDir, { recursive: true })
  await writeFile(`${file()}.tmp`, JSON.stringify(stored, null, 2), {
    mode: 0o600,
  })
  await rename(`${file()}.tmp`, file())
  current = next
  return publicSettings()
}
