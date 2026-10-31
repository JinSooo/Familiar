/**
 * The ChatGPT-plan route (Sign in with ChatGPT) only takes streaming Responses requests with
 * store:false and a limited set of fields. These helpers rewrite what the AI SDK sends and turn
 * the event stream back into one response object for callers that did not ask for a stream
 * (reflection, timeline compression, perception summaries, web search, the connection test).
 */

/** Request fields the route rejects (docs: Sign in with ChatGPT › Preview limitations). */
const dropped = [
  'temperature',
  'top_p',
  'max_output_tokens',
  'max_tool_calls',
  'metadata',
  'previous_response_id',
  'conversation',
  'prompt_cache_retention',
  'safety_identifier',
  'truncation',
  'user',
  'top_logprobs',
  'background',
  'moderation',
  'multi_agent',
  'prompt',
]

type Json = Record<string, unknown>
const isObject = (value: unknown): value is Json =>
  value !== null && typeof value === 'object' && !Array.isArray(value)

/** Text of a system input item: a string, or a list of text parts. */
function systemText(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .map((part) =>
      isObject(part) && typeof part.text === 'string' ? part.text : '',
    )
    .join('')
}

/**
 * The body the route accepts. `stream` says whether the caller asked for a stream; if not, the
 * response has to be collected back into one object.
 */
export function rewriteBody(body: Json): { body: Json; stream: boolean } {
  const stream = body.stream === true
  const next: Json = { ...body, store: false, stream: true }
  for (const key of dropped) delete next[key]
  if (Array.isArray(next.input)) {
    // Explicit system-role items are rejected; their text goes into instructions.
    const system: string[] = []
    next.input = next.input.filter((item) => {
      if (!isObject(item) || item.role !== 'system') return true
      const text = systemText(item.content)
      if (text) system.push(text)
      return false
    })
    const instructions = [
      typeof next.instructions === 'string' ? next.instructions : '',
      ...system,
    ].filter(Boolean)
    if (instructions.length) next.instructions = instructions.join('\n\n')
  }
  return { body: next, stream }
}

/** One response object from an event stream, in the shape of a non-streaming Responses reply. */
export function collectResponse(sse: string): Json {
  const items = new Map<number, unknown>()
  let finished: Json | undefined
  for (const block of sse.split(/\r?\n\r?\n/)) {
    const data = block
      .split(/\r?\n/)
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).trim())
      .join('\n')
    if (!data || data === '[DONE]') continue
    let event: unknown
    try {
      event = JSON.parse(data)
    } catch {
      continue
    }
    if (!isObject(event)) continue
    if (event.type === 'response.output_item.done') {
      if (typeof event.output_index === 'number')
        items.set(event.output_index, event.item)
    } else if (
      event.type === 'response.completed' ||
      event.type === 'response.incomplete'
    ) {
      if (isObject(event.response)) finished = event.response
    } else if (event.type === 'response.failed') {
      const error = isObject(event.response) ? event.response.error : undefined
      return failure(error)
    } else if (event.type === 'error') {
      return failure(event)
    }
  }
  if (!finished) throw new Error('ChatGPT 通道没有返回完整的响应')
  // The completed event normally carries the output; the items seen on the way fill a gap.
  if (!Array.isArray(finished.output) || finished.output.length === 0)
    finished.output = [...items.entries()]
      .sort(([a], [b]) => a - b)
      .map(([, item]) => item)
  return finished
}

/** The error object the AI SDK turns into an APICallError. */
function failure(error: unknown): Json {
  const e = isObject(error) ? error : {}
  return {
    error: {
      message:
        typeof e.message === 'string' ? e.message : 'ChatGPT 通道返回了错误',
      type: 'response.failed',
      code: typeof e.code === 'string' ? e.code : 'response_failed',
    },
  }
}

/** Wraps a fetch so that POST .../responses requests go through the rewrite above. */
export function chatGptRoute(
  send: typeof globalThis.fetch,
): typeof globalThis.fetch {
  return async (input, init) => {
    const request = new Request(input, init)
    if (
      request.method !== 'POST' ||
      !/\/responses$/.test(new URL(request.url).pathname)
    )
      return send(request)
    let parsed: unknown
    try {
      parsed = await request.clone().json()
    } catch {
      return send(request)
    }
    if (!isObject(parsed)) return send(request)
    const { body, stream } = rewriteBody(parsed)
    const headers = new Headers(request.headers)
    headers.delete('content-length')
    const response = await send(
      new Request(request, { body: JSON.stringify(body), headers }),
    )
    if (stream || !response.ok) return response
    return new Response(
      JSON.stringify(collectResponse(await response.text())),
      {
        status: 200,
        headers: { 'content-type': 'application/json' },
      },
    )
  }
}
