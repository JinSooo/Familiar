import { describe, expect, test } from 'bun:test'
import { agentError } from '../src/agent/errors'
import { createRelayFetch } from '../src/agent/fetch'
import { settingsSchema } from '../../src/shared'

// Shapes the AI SDK actually throws: APICallError carries statusCode and responseBody;
// RetryError keeps the final attempt in lastError.
const apiError = (statusCode: number, responseBody = '') =>
  Object.assign(new Error(`HTTP ${statusCode}`), { statusCode, responseBody })
const retried = (last: Error) =>
  Object.assign(
    new Error(`Failed after 3 attempts. Last error: ${last.message}`),
    {
      lastError: last,
    },
  )

describe('what the user is told', () => {
  test.each([
    [
      'relay has no channel for the model',
      retried(
        apiError(
          503,
          '{"error":{"code":"model_not_found","message":"no available channel for group test and model gpt-6.1-terra"}}',
        ),
      ),
      '这个模型在你的账号里用不了',
    ],
    [
      'relay overloaded',
      retried(
        apiError(
          503,
          '<html><body><h1>503 Service Unavailable</h1>No server is available to handle this request.</body></html>',
        ),
      ),
      '服务端 5xx',
    ],
    [
      'no response at all',
      Object.assign(new Error('Model service sent no response within 45s'), {
        name: 'ResponseTimeoutError',
      }),
      '45 秒没有回应',
    ],
    // Seen 2026-11-04: the relay's upstream Responses stream stopped after a tool ran.
    [
      'relay stream cut before the end',
      new Error('responses stream ended without ***.completed'),
      '传到一半连接断开',
    ],
    ['bad key', apiError(401, '{"error":"invalid api key"}'), 'API Key'],
    [
      'out of quota',
      apiError(429, 'All available accounts are currently rate-limited.'),
      '额度不足',
    ],
  ])('%s', (_, error, expected) => {
    expect(agentError(error).message).toContain(expected)
  })
  // Reported 2026-11-03: a finished reply ended in 模型运行失败 and nothing said why, so it could
  // not be traced. An error nothing recognises now carries what the service said.
  test('an unrecognised error keeps a short form of the original', () => {
    const message = agentError(
      new Error('Type validation failed: Value: {"choices":[]}'),
    ).message
    expect(message).toContain('模型运行失败')
    expect(message).toContain('Type validation failed')
    expect(agentError(new Error('x'.repeat(300))).message.length).toBeLessThan(
      160,
    )
    expect(agentError({}).message).toBe(
      '模型运行失败，请检查模型设置或稍后重试。',
    )
  })
})

describe('relay fetch', () => {
  const config = settingsSchema.shape.model.parse({
    protocol: 'openai-compatible',
    baseURL: 'http://relay.test/v1',
    model: 'm',
    apiKey: 'k',
    headers: [{ name: 'X-Team', value: 'a' }],
    extraBody: { reasoning_effort: 'low' },
  })

  test('a 503 that means "no such model" becomes a 404 so it is not retried', async () => {
    const send = createRelayFetch(
      config,
      async () =>
        new Response('{"error":{"code":"model_not_found"}}', { status: 503 }),
    )
    const response = await send('http://relay.test/v1/chat/completions', {
      method: 'POST',
    })
    expect(response.status).toBe(404)
    expect(await response.text()).toContain('model_not_found')
  })

  test('an ordinary 503 stays retryable', async () => {
    const send = createRelayFetch(
      config,
      async () => new Response('busy', { status: 503 }),
    )
    expect((await send('http://relay.test/v1/x')).status).toBe(503)
  })

  test('custom headers and extra body fields reach the relay', async () => {
    let seen: Request | undefined
    const send = createRelayFetch(config, async (input) => {
      seen = input as Request
      return new Response('{}')
    })
    await send('http://relay.test/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'm', messages: [] }),
    })
    expect(seen?.headers.get('X-Team')).toBe('a')
    expect(await seen?.json()).toEqual({
      model: 'm',
      messages: [],
      reasoning_effort: 'low',
    })
  })
})
