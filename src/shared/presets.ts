import type { Settings } from './index'

/** A model service with a known address and protocol: the user only has to add a key. */
export interface ProviderPreset {
  id: string
  name: string
  protocol: Settings['model']['protocol']
  baseURL: string
  /** Where the key is created. */
  keyURL: string
}

export const providerPresets: ProviderPreset[] = [
  {
    id: 'openai',
    name: 'OpenAI',
    protocol: 'openai-responses',
    baseURL: 'https://api.openai.com/v1',
    keyURL: 'https://platform.openai.com/api-keys',
  },
  {
    id: 'anthropic',
    name: 'Anthropic',
    protocol: 'anthropic',
    baseURL: 'https://api.anthropic.com/v1',
    keyURL: 'https://platform.claude.com/settings/keys',
  },
  {
    id: 'deepseek',
    name: 'DeepSeek',
    protocol: 'openai-compatible',
    baseURL: 'https://api.deepseek.com',
    keyURL: 'https://platform.deepseek.com/api_keys',
  },
  {
    id: 'kimi',
    name: 'Kimi',
    protocol: 'openai-compatible',
    baseURL: 'https://api.moonshot.cn/v1',
    keyURL: 'https://platform.moonshot.cn/console/api-keys',
  },
  {
    id: 'gemini',
    name: 'Gemini',
    protocol: 'openai-compatible',
    baseURL: 'https://generativelanguage.googleapis.com/v1beta/openai',
    keyURL: 'https://aistudio.google.com/apikey',
  },
]

const same = (a: string, b: string) =>
  a.trim().replace(/\/+$/, '') === b.replace(/\/+$/, '')

/** The preset a saved configuration matches; none means a custom relay. */
export function presetOf(
  model: Pick<Settings['model'], 'protocol' | 'baseURL'>,
): ProviderPreset | undefined {
  return providerPresets.find(
    (p) => p.protocol === model.protocol && same(model.baseURL, p.baseURL),
  )
}
