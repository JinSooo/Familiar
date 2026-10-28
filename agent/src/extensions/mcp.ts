import { execFile } from 'node:child_process'
import { readFile, rename, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { createMCPClient, type MCPClient } from '@ai-sdk/mcp'
import { Experimental_StdioMCPTransport } from '@ai-sdk/mcp/mcp-stdio'
import type { ToolSet } from 'ai'
import { z } from 'zod'
import type { McpCandidate, McpServerStatus } from '../../../src/shared'
import { systemFetch } from '../agent/fetch'
import { dataDir } from '../system'

/**
 * MCP servers from `<data dir>/mcp.json` — the Claude Desktop layout (`mcpServers`), plus an
 * `access` per server. It lives in the app data dir, not the workspace: these entries often
 * hold tokens, and the workspace is committed to git after every change.
 */
const exec = promisify(execFile)
export const mcpFile = () => join(dataDir, 'mcp.json')

const access = z.enum(['allow', 'ask', 'off']).default('ask')
const serverSchema = z.union([
  z.object({
    command: z.string().min(1),
    args: z.array(z.string()).default([]),
    env: z.record(z.string(), z.string()).default({}),
    cwd: z.string().optional(),
    access,
  }),
  z.object({
    url: z.string().url(),
    type: z.enum(['http', 'sse']).optional(),
    headers: z.record(z.string(), z.string()).default({}),
    access,
  }),
])
export type McpServer = z.infer<typeof serverSchema>
const fileSchema = z
  .object({ mcpServers: z.record(z.string(), z.unknown()).default({}) })
  .loose()

export interface McpConfig {
  servers: Record<string, McpServer>
  /** Entries that do not parse, by name, with the reason. */
  invalid: Record<string, string>
}
export async function readMcpConfig(): Promise<McpConfig> {
  let raw: unknown = {}
  try {
    raw = JSON.parse(await readFile(mcpFile(), 'utf8'))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
      return { servers: {}, invalid: { 'mcp.json': '文件不是有效的 JSON' } }
  }
  const file = fileSchema.safeParse(raw)
  const config: McpConfig = { servers: {}, invalid: {} }
  if (!file.success) {
    config.invalid['mcp.json'] = '缺少 mcpServers'
    return config
  }
  for (const [name, entry] of Object.entries(file.data.mcpServers)) {
    const parsed = serverSchema.safeParse(entry)
    if (parsed.success) config.servers[name] = parsed.data
    else config.invalid[name] = '需要 command，或 url'
  }
  return config
}
/** Rewrites one server's entry (or removes it with null), keeping everything else in the file. */
export async function updateMcpServer(
  name: string,
  change: (
    entry: Record<string, unknown> | undefined,
  ) => Record<string, unknown> | null,
): Promise<void> {
  let raw: Record<string, unknown> = {}
  try {
    raw = JSON.parse(await readFile(mcpFile(), 'utf8')) as Record<
      string,
      unknown
    >
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
      throw new Error('mcp.json 不是有效的 JSON，先手动修好它')
  }
  const servers = { ...((raw.mcpServers as Record<string, unknown>) ?? {}) }
  const next = change(servers[name] as Record<string, unknown> | undefined)
  if (next) servers[name] = next
  else delete servers[name]
  const text = `${JSON.stringify({ ...raw, mcpServers: servers }, null, 2)}\n`
  await writeFile(`${mcpFile()}.tmp`, text, { mode: 0o600 })
  await rename(`${mcpFile()}.tmp`, mcpFile())
}

/** Tool names must match [A-Za-z0-9_-]{1,64}; the server goes into the name so access can be checked. */
export function slug(name: string): string {
  return name.replace(/[^A-Za-z0-9_-]+/g, '_').slice(0, 24) || 'server'
}
export function serverOfTool(toolName: string): string | undefined {
  return /^mcp__(.+?)__/.exec(toolName)?.[1]
}

// GUI apps start with a bare PATH; servers launched via npx/uvx need the login shell's.
let shellPath: Promise<string> | undefined
function loginPath(): Promise<string> {
  shellPath ??= exec('/bin/zsh', ['-lic', 'printf %s "$PATH"'], {
    timeout: 5000,
  })
    .then(({ stdout }) => stdout.trim() || process.env.PATH || '')
    .catch(() => process.env.PATH ?? '/usr/bin:/bin')
  return shellPath
}

interface Connection {
  key: string
  name: string
  client?: MCPClient
  tools: ToolSet
  error?: string
}
const connections = new Map<string, Connection>()
let latest: McpConfig = { servers: {}, invalid: {} }

async function connect(name: string, server: McpServer): Promise<Connection> {
  const key = JSON.stringify(server)
  try {
    const transport =
      'command' in server
        ? new Experimental_StdioMCPTransport({
            command: server.command,
            args: server.args,
            env: {
              ...(process.env as Record<string, string>),
              PATH: await loginPath(),
              ...server.env,
            },
            cwd: server.cwd ?? homedir(),
          })
        : {
            type: server.type ?? ('http' as const),
            url: server.url,
            headers: server.headers,
            fetch: systemFetch,
          }
    const client = await createMCPClient({
      transport,
      clientName: 'familiar',
      initializationOptions: { timeout: 20000 },
      onUncaughtError: (error) => console.error(`MCP ${name}:`, error),
    })
    const raw = await client.tools()
    const tools: ToolSet = {}
    for (const [tool, definition] of Object.entries(raw))
      tools[`mcp__${slug(name)}__${tool}`.slice(0, 64)] =
        definition as ToolSet[string]
    return { key, name, client, tools }
  } catch (error) {
    return {
      key,
      name,
      tools: {},
      error: error instanceof Error ? error.message.split('\n')[0] : '连接失败',
    }
  }
}

/** Connects what is configured and enabled, drops what is not; returns all MCP tools. */
export async function mcpTools(): Promise<ToolSet> {
  latest = await readMcpConfig()
  const wanted = Object.entries(latest.servers).filter(
    ([, s]) => s.access !== 'off',
  )
  for (const [name, c] of connections)
    if (!wanted.some(([n, s]) => n === name && JSON.stringify(s) === c.key)) {
      connections.delete(name)
      void c.client?.close().catch(() => {})
    }
  await Promise.all(
    wanted
      .filter(([name]) => !connections.has(name))
      .map(async ([name, server]) =>
        connections.set(name, await connect(name, server)),
      ),
  )
  const tools: ToolSet = {}
  for (const c of connections.values()) Object.assign(tools, c.tools)
  return tools
}

/** Drop a server's connection so the next run reconnects (after an error, or on request). */
export function resetMcp(name?: string): void {
  for (const [n, c] of connections)
    if (!name || n === name) {
      connections.delete(n)
      void c.client?.close().catch(() => {})
    }
}

export function closeMcp(): Promise<unknown> {
  return Promise.all(
    [...connections.values()].map((c) => c.client?.close().catch(() => {})),
  )
}

/** Access for a prefixed MCP tool name, from the config read at the start of this run. */
export function mcpAccess(
  toolName: string,
): { server: string; access: 'allow' | 'ask' | 'off' } | undefined {
  const s = serverOfTool(toolName)
  if (!s) return undefined
  const name = Object.keys(latest.servers).find((n) => slug(n) === s)
  return name
    ? { server: name, access: latest.servers[name]!.access }
    : { server: s, access: 'off' }
}

export async function mcpStatus(): Promise<McpServerStatus[]> {
  const config = await readMcpConfig()
  return [
    ...Object.entries(config.servers).map(([name, server]): McpServerStatus => {
      const c = connections.get(name)
      return {
        name,
        target:
          'command' in server
            ? [server.command, ...server.args].join(' ')
            : server.url,
        access: server.access,
        state:
          server.access === 'off'
            ? 'off'
            : !c
              ? 'idle'
              : c.error
                ? 'error'
                : 'connected',
        tools: c
          ? Object.keys(c.tools).map((t) => t.replace(/^mcp__.+?__/, ''))
          : [],
        ...(c?.error ? { error: c.error } : {}),
      }
    }),
    ...Object.entries(config.invalid).map(([name, error]): McpServerStatus => ({
      name,
      target: '',
      access: 'off',
      state: 'error',
      tools: [],
      error,
    })),
  ]
}

/** Servers configured in Cursor, Codex, Claude Desktop and Claude Code that could be imported. */
export async function mcpCandidates(): Promise<McpCandidate[]> {
  const existing = (await readMcpConfig()).servers
  const found: McpCandidate[] = []
  const add = (
    source: string,
    name: string,
    entry: Record<string, unknown>,
  ) => {
    const parsed = serverSchema.safeParse(entry)
    if (!parsed.success) return
    const s = parsed.data
    found.push({
      source,
      name,
      target: 'command' in s ? [s.command, ...s.args].join(' ') : s.url,
      exists: name in existing,
      entry: { ...entry, access: 'ask' },
    })
  }
  const json = async (source: string, path: string) => {
    try {
      const data = JSON.parse(await readFile(path, 'utf8')) as {
        mcpServers?: Record<string, Record<string, unknown>>
      }
      for (const [name, entry] of Object.entries(data.mcpServers ?? {}))
        add(source, name, entry)
    } catch {
      /* Not installed. */
    }
  }
  const home = homedir()
  await json('Cursor', join(home, '.cursor/mcp.json'))
  await json(
    'Claude Desktop',
    join(home, 'Library/Application Support/Claude/claude_desktop_config.json'),
  )
  await json('Claude Code', join(home, '.claude.json'))
  try {
    const toml = Bun.TOML.parse(
      await readFile(join(home, '.codex/config.toml'), 'utf8'),
    ) as {
      mcp_servers?: Record<string, Record<string, unknown>>
    }
    for (const [name, s] of Object.entries(toml.mcp_servers ?? {})) {
      const headers = { ...((s.http_headers as Record<string, string>) ?? {}) }
      const tokenVar = s.bearer_token_env_var
      if (typeof tokenVar === 'string' && process.env[tokenVar])
        headers.Authorization = `Bearer ${process.env[tokenVar]}`
      add(
        'Codex',
        name,
        typeof s.url === 'string'
          ? { url: s.url, headers }
          : {
              command: s.command,
              args: s.args ?? [],
              env: s.env ?? {},
              ...(s.cwd ? { cwd: s.cwd } : {}),
            },
      )
    }
  } catch {
    /* No Codex config. */
  }
  return found
}
