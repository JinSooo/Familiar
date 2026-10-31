import { createAnthropic } from '@ai-sdk/anthropic'
import { createOpenAI } from '@ai-sdk/openai'
import { createOpenAICompatible } from '@ai-sdk/openai-compatible'
import type { LanguageModel } from 'ai'
import type { Settings } from '../../../src/shared'
import { chatGptAccessToken, chatGptResource } from './chatgpt-auth'
import { chatGptRoute } from './chatgpt-route'
import { createRelayFetch } from './fetch'

/** Adds the signed-in ChatGPT account's access token to every request. */
function withChatGptToken(
  send: typeof globalThis.fetch,
): typeof globalThis.fetch {
  return async (input, init) => {
    const request = new Request(input, init)
    request.headers.set('Authorization', `Bearer ${await chatGptAccessToken()}`)
    return send(request)
  }
}

export function createModel(
  config: Settings['model'],
  fetchImpl?: typeof globalThis.fetch,
): LanguageModel {
  const model = config.model.trim()
  const apiKey = config.apiKey.trim()
  const baseURL = config.baseURL.trim() || undefined
  if (!model) throw new Error('请先在设置里填写模型名称')
  if (config.protocol === 'chatgpt')
    // The key is a placeholder: the real credential is the OAuth token added per request.
    return createOpenAI({
      baseURL: chatGptResource,
      apiKey: 'chatgpt-login',
      fetch: chatGptRoute(
        withChatGptToken(createRelayFetch(config, fetchImpl)),
      ),
    }).responses(model)
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

/** The fetch for the ChatGPT-plan route: relay options, the login token, the request rewrite. */
export function chatGptFetch(
  config: Settings['model'],
  fetchImpl?: typeof globalThis.fetch,
): typeof globalThis.fetch {
  return chatGptRoute(withChatGptToken(createRelayFetch(config, fetchImpl)))
}
