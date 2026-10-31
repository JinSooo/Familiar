import { generateText } from 'ai'
import type { ModelDraft, ModelTestResult, Settings } from '../../../src/shared'
import { getSettings } from '../settings'
import { agentError } from './errors'
import { createRelayFetch } from './fetch'
import { createModel } from './provider'

/** The settings window tests what is on screen; an empty key field means "the saved one". */
function resolveDraft(draft: ModelDraft): Settings['model'] {
  return {
    ...draft,
    apiKey: draft.apiKey?.trim() || getSettings().model.apiKey,
  }
}

const defaultBase: Record<Settings['model']['protocol'], string> = {
  'openai-compatible': '',
  'openai-responses': 'https://api.openai.com/v1',
  anthropic: 'https://api.anthropic.com/v1',
  chatgpt: 'https://api.openai.com/v1',
}

export async function listModels(draft: ModelDraft): Promise<string[]> {
  const config = resolveDraft(draft)
  const base = (config.baseURL.trim() || defaultBase[config.protocol]).replace(
    /\/+$/,
    '',
  )
  if (!base) throw new Error('请先填写 Base URL')
  if (!config.apiKey.trim()) throw new Error('请先填写 API Key')
  const key = config.apiKey.trim()
  // Anthropic auth is set by the relay fetch itself; the OpenAI style always uses Bearer.
  const headers: Record<string, string> =
    config.protocol === 'anthropic'
      ? { 'anthropic-version': '2023-06-01' }
      : { authorization: `Bearer ${key}` }
  try {
    const response = await createRelayFetch(config)(`${base}/models`, {
      headers,
      signal: AbortSignal.timeout(20_000),
    })
    const body = await response.text()
    if (!response.ok)
      throw Object.assign(new Error(`HTTP ${response.status}`), {
        statusCode: response.status,
        responseBody: body,
      })
    const data = (JSON.parse(body) as { data?: { id?: unknown }[] }).data
    if (!Array.isArray(data)) throw new Error('中转站没有返回模型列表')
    return [
      ...new Set(
        data
          .map((m) => m.id)
          .filter((id): id is string => typeof id === 'string'),
      ),
    ].sort((a, b) => a.localeCompare(b))
  } catch (error) {
    throw agentError(error)
  }
}

export async function testModel(draft: ModelDraft): Promise<ModelTestResult> {
  const started = Date.now()
  try {
    const result = await generateText({
      model: createModel(resolveDraft(draft)),
      prompt: '只回复：ok',
      maxOutputTokens: 32,
      maxRetries: 0,
      abortSignal: AbortSignal.timeout(60_000),
    })
    return { ms: Date.now() - started, reply: result.text.trim().slice(0, 80) }
  } catch (error) {
    throw agentError(error)
  }
}
