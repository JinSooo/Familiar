import type { Settings } from '../../../src/shared'

import { proxyFor } from '../system'
const systemFetch: typeof globalThis.fetch = async (input, init) => {
  const url = input instanceof Request ? input.url : String(input)
  const options: RequestInit & { proxy?: string } = {
    ...init,
    proxy: proxyFor(url),
  }
  return globalThis.fetch(input, options)
}

/** Healthy relays answer a streaming request within seconds; a sick one can sit for a minute per try. */
export const responseTimeoutMs = 45_000
export class ResponseTimeoutError extends Error {
  override name = 'ResponseTimeoutError'
  constructor() {
    super(`Model service sent no response within ${responseTimeoutMs / 1000}s`)
  }
}
/**
 * Bounds the wait for response headers only; once streaming starts the body may take as long as
 * it needs. A plain Error (not an abort, not an APICallError) makes the SDK fail without retrying,
 * so a stalled relay costs one timeout instead of three.
 */
async function withResponseTimeout(
  send: typeof globalThis.fetch,
  request: Request,
): Promise<Response> {
  const timer = new AbortController()
  const id = setTimeout(
    () => timer.abort(new ResponseTimeoutError()),
    responseTimeoutMs,
  )
  try {
    return await send(
      new Request(request, {
        signal: AbortSignal.any([request.signal, timer.signal]),
      }),
    )
  } finally {
    clearTimeout(id)
  }
}

export function createRelayFetch(
  config: Settings['model'],
  fetchImpl: typeof globalThis.fetch = systemFetch,
): typeof globalThis.fetch {
  return async (input, init) => {
    const request = new Request(input, init)
    for (const { name, value } of config.headers) {
      if (name.trim()) request.headers.set(name.trim(), value)
    }
    if (config.protocol === 'anthropic') {
      // Authentication mode wins over conflicting custom header rows.
      request.headers.delete('x-api-key')
      request.headers.delete('authorization')
      if (config.authStyle === 'bearer')
        request.headers.set('Authorization', `Bearer ${config.apiKey.trim()}`)
      else request.headers.set('x-api-key', config.apiKey.trim())
    }
    if (
      request.body !== null &&
      request.headers.get('content-type')?.split(';')[0]?.trim() ===
        'application/json' &&
      Object.keys(config.extraBody).length
    ) {
      const body: unknown = await request.clone().json()
      if (body !== null && typeof body === 'object' && !Array.isArray(body)) {
        request.headers.delete('content-length')
        return withResponseTimeout(
          fetchImpl,
          new Request(request, {
            body: JSON.stringify({ ...body, ...config.extraBody }),
          }),
        )
      }
    }
    return withResponseTimeout(fetchImpl, request)
  }
}
