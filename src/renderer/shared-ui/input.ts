export const maxFiles = 10
export const maxBytes = 20 * 1024 * 1024

export interface Pending {
  file: File
  preview?: string
}

export function inputKey(event: {
  key: string
  isComposing: boolean
  shiftKey?: boolean
}): 'send' | 'close' | undefined {
  if (event.isComposing) return
  if (event.key === 'Escape') return 'close'
  if (event.key === 'Enter' && !event.shiftKey) return 'send'
}

export const sendError = (error: unknown) =>
  typeof error === 'string'
    ? error
    : error instanceof Error
      ? error.message
      : '没发出去，再试一次'

export function limitFiles(
  files: Pending[],
  revoke: (url: string) => void,
  limit = maxFiles,
): Pending[] {
  for (const item of files.slice(limit)) if (item.preview) revoke(item.preview)
  return files.slice(0, limit)
}

export const toBase64 = async (file: File) => {
  const bytes = new Uint8Array(await file.arrayBuffer())
  let binary = ''
  for (let i = 0; i < bytes.length; i += 0x8000)
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return btoa(binary)
}

export interface Draft {
  input: string
  files: Pending[]
  error?: string
}

/** One composer per WebView; hiding it must not discard its draft. */
export function createDraftStore() {
  let value: Draft = { input: '', files: [] }
  const listeners = new Set<() => void>()
  const store = {
    sending: false,
    get: () => value,
    set: (next: Draft) => {
      value = next
      listeners.forEach((listener) => listener())
    },
    subscribe: (listener: () => void) => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
  }
  return store
}

export async function sendDraft(
  store: ReturnType<typeof createDraftStore>,
  run: (
    text: string,
    uploads: { name: string; data: string }[],
  ) => Promise<void>,
  encode = toBase64,
  revoke = URL.revokeObjectURL,
) {
  if (store.sending) return
  const sent = store.get()
  if (sent.files.length > maxFiles)
    throw new Error(`一次最多 ${maxFiles} 个文件`)
  const text = sent.input.trim()
  store.sending = true
  store.set({ input: '', files: [] })
  try {
    const uploads = await Promise.all(
      sent.files.map(async ({ file }) => ({
        name: file.name,
        data: await encode(file),
      })),
    )
    await run(text, uploads)
    sent.files.forEach((f) => {
      if (f.preview) revoke(f.preview)
    })
  } catch (error) {
    const current = store.get()
    store.set({
      input: [sent.input, current.input].filter(Boolean).join('\n'),
      files: [...sent.files, ...current.files],
    })
    throw error
  } finally {
    store.sending = false
  }
}

export interface MessageEdit {
  sessionId: string
  index: number
  original: { role: string; content: string; createdAt: number }
}

export function activeEdit(
  session: {
    id: string
    running: boolean
    messages: MessageEdit['original'][]
  },
  edit: MessageEdit | undefined,
): number | undefined {
  if (!edit || session.running || edit.sessionId !== session.id) return
  const message = session.messages[edit.index]
  return message?.role === edit.original.role &&
    message.content === edit.original.content &&
    message.createdAt === edit.original.createdAt
    ? edit.index
    : undefined
}

export async function submitEdit(
  work: () => Promise<unknown>,
  done: () => void,
) {
  await work()
  done()
}
