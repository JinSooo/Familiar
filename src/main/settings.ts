import { app, safeStorage } from 'electron'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { homedir } from 'node:os'
import {
  settingsSchema,
  type PublicSettings,
  type Settings,
  type SettingsUpdate,
} from '../shared'
let current: Settings
const file = () => join(app.getPath('userData'), 'settings.json')
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
  if (typeof raw.encryptedApiKey === 'string') {
    if (!(await safeStorage.isAsyncEncryptionAvailable()))
      throw new Error('钥匙串加密不可用，无法解密 API key')
    const { result } = await safeStorage.decryptStringAsync(
      Buffer.from(raw.encryptedApiKey, 'base64'),
    )
    current.model.apiKey = result
  }
  if (current.workspacePath === '~/Familiar')
    current.workspacePath = join(homedir(), 'Familiar')
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
  if (apiKey && !(await safeStorage.isAsyncEncryptionAvailable()))
    throw new Error('钥匙串加密不可用，未保存 API key')
  const stored = {
    ...next,
    model,
    encryptedApiKey: apiKey
      ? (await safeStorage.encryptStringAsync(apiKey)).toString('base64')
      : undefined,
  }
  await mkdir(app.getPath('userData'), { recursive: true })
  await writeFile(`${file()}.tmp`, JSON.stringify(stored, null, 2), {
    mode: 0o600,
  })
  await rename(`${file()}.tmp`, file())
  current = next
  return publicSettings()
}
