import { expect, test } from 'bun:test'
import { createOpenAI } from '@ai-sdk/openai'
import { tool } from 'ai'
import { z } from 'zod'
import { runAgentCore } from '../src/agent/core'

const sse = (...events: unknown[]) =>
  events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join('') +
  'data: [DONE]\n\n'
const usage = {
  input_tokens: 1,
  output_tokens: 1,
  input_tokens_details: { cached_tokens: 0 },
  output_tokens_details: { reasoning_tokens: 0 },
}
const reasoning = {
  type: 'reasoning',
  id: 'rs_1',
  encrypted_content: 'sealed',
  summary: [],
}
const call = {
  type: 'function_call',
  id: 'fc_1',
  call_id: 'call_1',
  name: 'look',
  arguments: '{}',
  status: 'completed',
}
const reply = {
  type: 'message',
  id: 'msg_1',
  role: 'assistant',
  status: 'completed',
  content: [{ type: 'output_text', text: '好了', annotations: [] }],
}
const turn = (id: string, items: Record<string, unknown>[]) =>
  sse(
    {
      type: 'response.created',
      response: { id, created_at: 0, model: 'gpt-6.1-sol' },
    },
    ...items.flatMap((item, output_index) => [
      { type: 'response.output_item.added', output_index, item },
      { type: 'response.output_item.done', output_index, item },
    ]),
    { type: 'response.completed', response: { id, usage } },
  )

async function secondInput(
  providerOptions?: Record<string, Record<string, string | boolean>>,
) {
  const bodies: { input: { type?: string }[] }[] = []
  const fetch = (async (_url: unknown, init?: RequestInit) => {
    bodies.push(JSON.parse(String(init?.body)) as (typeof bodies)[number])
    const body =
      bodies.length === 1
        ? turn('resp_1', [reasoning, call])
        : turn('resp_2', [reply])
    return new Response(body, {
      headers: { 'content-type': 'text/event-stream' },
    })
  }) as typeof globalThis.fetch
  await runAgentCore(
    [{ role: 'user', content: '看一下' }],
    () => {},
    new AbortController().signal,
    {
      model: createOpenAI({ apiKey: 'test', fetch }).responses('gpt-6.1-sol'),
      tools: {
        look: tool({ inputSchema: z.object({}), execute: () => 'ok' }),
      },
      instructions: '',
      workspacePath: '/tmp',
      decide: () => Promise.resolve({ decision: 'allow', reason: '' }),
      snapshot: () => Promise.resolve(),
      ...(providerOptions ? { providerOptions } : {}),
    },
  )
  return bodies[1]?.input ?? []
}

// Reported 2026-11-07: on the ChatGPT plan (store:false) a multi-step turn failed with 404
// 「Item with id 'rs_…' not found」: the SDK sent the reasoning back by id.
test('with store:false the next step carries the reasoning itself, not a reference', async () => {
  const input = await secondInput({ openai: { store: false } })
  expect(input.some((item) => item.type === 'item_reference')).toBe(false)
  expect(input).toContainEqual(
    expect.objectContaining({ type: 'reasoning', encrypted_content: 'sealed' }),
  )
})
test('without it the SDK refers to the stored item (what the route rejected)', async () => {
  const input = await secondInput()
  expect(input.some((item) => item.type === 'item_reference')).toBe(true)
})
