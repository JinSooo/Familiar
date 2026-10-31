import { describe, expect, test } from 'bun:test'
import {
  chatGptRoute,
  collectResponse,
  rewriteBody,
} from '../src/agent/chatgpt-route'

const sse = (...events: unknown[]) =>
  events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join('')
const message = {
  type: 'message',
  role: 'assistant',
  id: 'm1',
  content: [{ type: 'output_text', text: 'ok', annotations: [] }],
}

describe('rewriteBody', () => {
  test('forces store:false and stream:true and drops unsupported fields', () => {
    const { body, stream } = rewriteBody({
      model: 'gpt-6.1-sol',
      input: [{ role: 'user', content: 'hi' }],
      temperature: 0.2,
      max_output_tokens: 32,
      store: true,
    })
    expect(stream).toBe(false)
    expect(body.store).toBe(false)
    expect(body.stream).toBe(true)
    expect(body).not.toHaveProperty('temperature')
    expect(body).not.toHaveProperty('max_output_tokens')
    expect(body.model).toBe('gpt-6.1-sol')
  })

  test('moves system items into instructions and remembers a streaming caller', () => {
    const { body, stream } = rewriteBody({
      stream: true,
      instructions: '已有说明',
      input: [
        { role: 'system', content: '你是小黑' },
        { role: 'system', content: [{ type: 'input_text', text: '用中文' }] },
        { role: 'user', content: 'hi' },
      ],
    })
    expect(stream).toBe(true)
    expect(body.input).toEqual([{ role: 'user', content: 'hi' }])
    expect(body.instructions).toBe('已有说明\n\n你是小黑\n\n用中文')
  })
})

describe('collectResponse', () => {
  test('uses the completed response', () => {
    const out = collectResponse(
      sse({
        type: 'response.completed',
        response: { id: 'r1', output: [message] },
      }),
    )
    expect(out.output).toEqual([message])
  })

  test('falls back to the output items seen on the way', () => {
    const out = collectResponse(
      sse(
        {
          type: 'response.output_item.done',
          output_index: 1,
          item: { ...message, id: 'b' },
        },
        {
          type: 'response.output_item.done',
          output_index: 0,
          item: { ...message, id: 'a' },
        },
        { type: 'response.completed', response: { id: 'r1', output: [] } },
      ),
    )
    expect((out.output as { id: string }[]).map((i) => i.id)).toEqual([
      'a',
      'b',
    ])
  })

  test('a failed response becomes an error object', () => {
    const out = collectResponse(
      sse({
        type: 'response.failed',
        response: {
          error: {
            code: 'subscription_sharing_usage_limit_exceeded',
            message: '额度用完',
          },
        },
      }),
    )
    expect(out.error).toMatchObject({
      code: 'subscription_sharing_usage_limit_exceeded',
      message: '额度用完',
    })
  })

  test('a stream with no completion is an error', () => {
    expect(() => collectResponse(sse({ type: 'response.created' }))).toThrow()
  })
})

describe('chatGptRoute', () => {
  const fake = (seen: { body?: Record<string, unknown> }) =>
    (async (input: RequestInfo | URL) => {
      seen.body = (await (input as Request).json()) as Record<string, unknown>
      return new Response(
        sse({
          type: 'response.completed',
          response: { id: 'r1', output: [message] },
        }),
        { status: 200, headers: { 'content-type': 'text/event-stream' } },
      )
    }) as typeof globalThis.fetch

  const post = (
    route: typeof globalThis.fetch,
    body: unknown,
    path = 'responses',
  ) =>
    route(`https://api.openai.com/v1/${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })

  test('a non-streaming caller gets one JSON response', async () => {
    const seen: { body?: Record<string, unknown> } = {}
    const response = await post(chatGptRoute(fake(seen)), {
      model: 'm',
      input: [{ role: 'user', content: 'hi' }],
      max_output_tokens: 32,
    })
    expect(seen.body).toMatchObject({ store: false, stream: true })
    expect(seen.body).not.toHaveProperty('max_output_tokens')
    const json = (await response.json()) as { output: unknown[] }
    expect(json.output).toHaveLength(1)
  })

  test('a streaming caller gets the stream untouched', async () => {
    const response = await post(chatGptRoute(fake({})), {
      model: 'm',
      stream: true,
      input: [],
    })
    expect(await response.text()).toContain('response.completed')
  })

  test('other endpoints pass through', async () => {
    const seen: { body?: Record<string, unknown> } = {}
    await post(
      chatGptRoute(fake(seen)),
      { model: 'm', temperature: 1 },
      'chat/completions',
    )
    expect(seen.body).toEqual({ model: 'm', temperature: 1 })
  })
})
