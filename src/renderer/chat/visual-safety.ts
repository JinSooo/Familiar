import type { Loader } from 'vega'

export function chartSpec(code: string): Record<string, unknown> {
  const spec: unknown = JSON.parse(code)
  if (!spec || typeof spec !== 'object' || Array.isArray(spec))
    throw new Error('图表需要一个 JSON 对象')
  // Metadata is model content, not permission to change embedding options.
  const { usermeta: _usermeta, ...chart } = spec as Record<string, unknown>
  void _usermeta
  return chart
}

export function restrictChartLoader(loader: Loader): Loader {
  const blocked = () => Promise.reject(new Error('图表不能读取外部数据或链接'))
  loader.load = blocked
  loader.sanitize = blocked
  return loader
}

/** Dispose resources even if creation finishes after the component unmounts. */
export function asyncResource() {
  let finalize: (() => void) | undefined
  let disposed = false
  return {
    accept: (dispose: () => void) => {
      if (disposed) dispose()
      else finalize = dispose
    },
    dispose: () => {
      if (disposed) return
      disposed = true
      finalize?.()
      finalize = undefined
    },
  }
}
