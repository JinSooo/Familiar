import { describe, expect, test } from 'bun:test'
import { presetOf, providerPresets } from '../../src/shared/presets'

describe('provider presets', () => {
  test('a saved configuration is matched by protocol and address', () => {
    expect(
      presetOf({
        protocol: 'openai-compatible',
        baseURL: 'https://api.deepseek.com/',
      })?.id,
    ).toBe('deepseek')
    expect(
      presetOf({
        protocol: 'anthropic',
        baseURL: 'https://api.anthropic.com/v1',
      })?.id,
    ).toBe('anthropic')
  })

  test('a relay, or the right address with the wrong protocol, is custom', () => {
    expect(
      presetOf({
        protocol: 'openai-compatible',
        baseURL: 'https://api.cometapi.com/v1',
      }),
    ).toBeUndefined()
    expect(
      presetOf({
        protocol: 'anthropic',
        baseURL: 'https://api.deepseek.com',
      }),
    ).toBeUndefined()
  })

  test('every preset is found again from its own settings', () => {
    for (const p of providerPresets) expect(presetOf(p)?.id).toBe(p.id)
  })
})
