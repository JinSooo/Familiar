import { createAnthropic } from '@ai-sdk/anthropic'
import { createOpenAI } from '@ai-sdk/openai'
import { createOpenAICompatible } from '@ai-sdk/openai-compatible'
import type { LanguageModel } from 'ai'
import type { Settings } from '../../shared'
import { createRelayFetch } from './fetch'

export function createModel(
  config: Settings['model'],
  fetchImpl?: typeof globalThis.fetch,
): LanguageModel {
  const model = config.model.trim()
  const apiKey = config.apiKey.trim()
  const baseURL = config.baseURL.trim() || undefined
  if (!model) throw new Error('请先在设置里填写模型名称')
  if (!apiKey) throw new Error('请先在设置里填写 API Key')
  const fetch = createRelayFetch(config, fetchImpl)
  switch (config.protocol) {
    case 'anthropic':
      return createAnthropic({
        baseURL,
        ...(config.authStyle === 'bearer' ? { authToken: apiKey } : { apiKey }),
        fetch,
      })(model)
    case 'openai-responses':
      return createOpenAI({ baseURL, apiKey, fetch }).responses(model)
    case 'openai-compatible':
      if (!baseURL) throw new Error('请先在设置里填写 Base URL')
      return createOpenAICompatible({ name: 'custom', baseURL, apiKey, fetch })(
        model,
      )
  }
}
