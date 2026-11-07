import { expect, test } from 'bun:test'
import { readFile } from 'node:fs/promises'

const read = (path: string) =>
  readFile(new URL(path, import.meta.url), 'utf8')

// Found 2026-11-07 in the renderer review: the quick bar's retry was refused, and the chat
// panel never received the pet's state, so the reading pet never appeared above it.
test('every window that resends is allowed to', async () => {
  const main = await read('../src/main.ts')
  const quick = await read('../../src/renderer/quick/Quick.tsx')
  expect(quick).toContain('api.resend(')
  const senders = /case IPC\.agentResend:[\s\S]*?requireSender\(window, \[([^\]]*)\]/.exec(main)?.[1]
  expect(senders).toContain("'quick'")
})

test('pet state reaches every window that listens for it', async () => {
  const main = await read('../src/main.ts')
  const chat = await read('../../src/renderer/chat/Chat.tsx')
  expect(chat).toContain('api.onState(')
  const list = /petStateWindows = \[([^\]]*)\]/.exec(main)?.[1] ?? ''
  for (const label of ['pet', 'panel', 'chat', 'main']) expect(list).toContain(`'${label}'`)
})
