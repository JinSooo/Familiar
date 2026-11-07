import { expect, test } from 'bun:test'
import { openAiOptions } from '../src/agent'

// 2026-11-07: three plan-route turns with the same ~6k prefix all reported 0 cached tokens.
test('Responses routes key the prompt cache by conversation', () => {
  expect(openAiOptions('chatgpt', 'c1')).toEqual({
    providerOptions: {
      openai: { store: false, promptCacheKey: 'familiar-c1' },
    },
  })
  expect(openAiOptions('openai-responses', 'c1')).toEqual({
    providerOptions: { openai: { promptCacheKey: 'familiar-c1' } },
  })
  expect(openAiOptions('chatgpt', '')).toEqual({
    providerOptions: { openai: { store: false } },
  })
  expect(openAiOptions('anthropic', 'c1')).toEqual({})
})
