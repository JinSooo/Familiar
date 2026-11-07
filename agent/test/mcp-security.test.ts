import { afterEach, expect, spyOn, test } from 'bun:test'
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import * as sdk from '@ai-sdk/mcp'
import { z } from 'zod'
import { tool } from 'ai'
import { settingsSchema } from '../../src/shared'
import { decideToolCall } from '../src/permissions'
import {
  mcpAccess,
  mcpFile,
  mcpTools,
  resetMcp,
  closeMcp,
  updateMcpServer,
} from '../src/extensions/mcp'

let restore = () => {}
afterEach(async () => {
  await closeMcp()
  resetMcp()
  restore()
})
const config = async (servers: Record<string, unknown>) => {
  resetMcp()
  await mkdir(dirname(mcpFile()), { recursive: true })
  await writeFile(mcpFile(), JSON.stringify({ mcpServers: servers }))
}
const endpoint = (access = 'ask') => ({
  url: 'https://example.test/mcp',
  access,
})
function clients(
  options: { failTools?: boolean; wait?: Promise<void>; names?: string[] } = {},
) {
  const state = { created: 0, closed: 0 }
  const spy = spyOn(sdk, 'createMCPClient').mockImplementation(async () => {
    state.created++
    return {
      tools: async () => {
        await options.wait
        if (options.failTools) throw new Error('tools failed')
        return Object.fromEntries(
          (options.names ?? ['read']).map((name) => [
            name,
            tool({ inputSchema: z.object({}), execute: () => 'external' }),
          ]),
        )
      },
      close: async () => {
        state.closed++
      },
    } as unknown as sdk.MCPClient
  })
  restore = () => spy.mockRestore()
  return state
}

test('colliding server slugs keep tools and permissions separate', async () => {
  clients()
  await config({
    'service.a': endpoint('allow'),
    'service a': endpoint(),
    service_a_2: endpoint(),
    ['long'.repeat(12) + 'a']: endpoint(),
    ['long'.repeat(12) + 'b']: endpoint(),
  })
  const tools = await mcpTools()
  expect(Object.keys(tools)).toHaveLength(5)
  const access = Object.keys(tools).map(mcpAccess)
  expect(access).toContainEqual({ server: 'service.a', access: 'allow' })
  expect(access).toContainEqual({ server: 'service a', access: 'ask' })
  expect(new Set(access.map((a) => a?.server)).size).toBe(5)
  for (const name of Object.keys(tools)) {
    expect(name).toMatch(/^[A-Za-z0-9_-]{1,64}$/)
    for (const permissionMode of ['ask', 'auto', 'full'] as const) {
      const decision = await decideToolCall(
        { id: 'mcp', toolName: name, input: {} },
        settingsSchema.parse({ permissionMode }),
      )
      expect(decision.decision).toBe(
        permissionMode === 'full' || mcpAccess(name)?.access === 'allow'
          ? 'allow'
          : 'ask',
      )
    }
  }
  expect(mcpAccess('mcp__service_a__invented')?.access).toBe('off')
})

test('truncated and normalized tool names cannot overwrite one another', async () => {
  clients({
    names: ['read.a', 'read a', 'x'.repeat(80) + 'a', 'x'.repeat(80) + 'b'],
  })
  await config({ tools: endpoint() })
  const names = Object.keys(await mcpTools())
  expect(names).toHaveLength(4)
  expect(new Set(names).size).toBe(4)
  for (const name of names) {
    expect(name).toMatch(/^[A-Za-z0-9_-]{1,64}$/)
    expect(mcpAccess(name)).toEqual({ server: 'tools', access: 'ask' })
  }
})

test('simultaneous connection requests share one pending client', async () => {
  let release!: () => void
  const wait = new Promise<void>((resolve) => {
    release = resolve
  })
  const state = clients({ wait })
  await config({ shared: endpoint() })
  const a = mcpTools(),
    b = mcpTools()
  // Yield until both config reads reach the pending tools request.
  await new Promise((resolve) => setTimeout(resolve, 30))
  release()
  await Promise.all([a, b])
  expect(state.created).toBe(1)
  await closeMcp()
  expect(state.closed).toBe(1)
})

test('tools discovery failure closes the established client', async () => {
  const state = clients({ failTools: true })
  await config({ broken: endpoint() })
  expect(await mcpTools()).toEqual({})
  expect(state.created).toBe(1)
  expect(state.closed).toBe(1)
})

test('reset during discovery closes the pending client instead of restoring it', async () => {
  let release!: () => void
  const wait = new Promise<void>((resolve) => {
    release = resolve
  })
  const state = clients({ wait })
  await config({ pending: endpoint() })
  const pending = mcpTools()
  await new Promise((resolve) => setTimeout(resolve, 30))
  expect(state.created).toBe(1)
  resetMcp('pending')
  release()
  expect(await pending).toEqual({})
  expect(state.closed).toBe(1)
})

test('always allowing a server refreshes permissions in the current turn', async () => {
  clients()
  await config({ current: endpoint() })
  const [name] = Object.keys(await mcpTools())
  expect(mcpAccess(name!)?.access).toBe('ask')
  await updateMcpServer('current', (entry) => ({ ...entry, access: 'allow' }))
  expect(mcpAccess(name!)?.access).toBe('allow')
  await updateMcpServer('current', (entry) => ({ ...entry, access: 'off' }))
  expect(mcpAccess(name!)?.access).toBe('off')
  expect(
    (
      await decideToolCall(
        { id: 'off', toolName: name!, input: {} },
        settingsSchema.parse({ permissionMode: 'full' }),
      )
    ).decision,
  ).toBe('deny')
})
