import type { Settings } from '../../shared'

/** Resolve lazily so importing the provider also works in plain Node tests. */
const systemFetch: typeof globalThis.fetch = async (input, init) => {
  if (process.versions.electron && process.type === 'browser') {
    const { net } = await import('electron')
    return net.fetch(input instanceof URL ? input.toString() : input, init)
  }
  return globalThis.fetch(input, init)
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
        return fetchImpl(
          new Request(request, {
            body: JSON.stringify({ ...body, ...config.extraBody }),
          }),
        )
      }
    }
    return fetchImpl(request)
  }
}
