import type { PublicSettings } from '../../shared'

/** Keep live events authoritative over an in-flight initial read. */
export function observeSnapshot<T>(
  read: () => Promise<T>,
  subscribe: (receive: (value: T) => void) => () => void,
  receive: (value: T) => void,
  failed: (error: unknown) => void = console.error,
) {
  let active = true
  let revision = 0
  const off = subscribe((value) => {
    revision++
    if (active) receive(value)
  })
  const refresh = () => {
    if (!active) return
    const requested = ++revision
    void read()
      .then((value) => {
        if (active && revision === requested) receive(value)
      })
      .catch((error: unknown) => {
        if (active && revision === requested) failed(error)
      })
  }
  refresh()
  return Object.assign(
    () => {
      active = false
      off()
    },
    { refresh },
  )
}

/** Ready broadcasts may only run after the window's listeners are installed. */
export function createListenerBarrier() {
  const pending = new Set<Promise<unknown>>()
  let scheduled = false
  const wait = async () => {
    await Promise.resolve()
    while (pending.size) await Promise.allSettled([...pending])
  }
  return {
    wait,
    track: (promise: Promise<unknown>) => {
      pending.add(promise)
      void promise.then(
        () => pending.delete(promise),
        () => pending.delete(promise),
      )
      return promise
    },
    ready: (send: () => void) => {
      if (scheduled) return
      scheduled = true
      // Effects in this commit finish subscribing before the microtask runs.
      void wait().then(() => {
        scheduled = false
        send()
      })
    },
  }
}

export function recoverSettings(
  current: PublicSettings | undefined,
  loaded: PublicSettings,
) {
  return current ? { ...current, dirRules: loaded.dirRules } : loaded
}
