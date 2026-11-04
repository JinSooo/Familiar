import { describe, expect, test } from 'bun:test'
import { mkdtempSync, realpathSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { settingsSchema, type Settings } from '../../src/shared'
import { decideToolCall, grantedRule, withRule } from '../src/permissions'

const workspace = realpathSync(mkdtempSync(join(tmpdir(), 'familiar-ws-')))
const outside = realpathSync(mkdtempSync(join(tmpdir(), 'familiar-out-')))
const settings = (patch: Partial<Settings> = {}): Settings => ({
  ...settingsSchema.parse({ workspacePath: workspace }),
  ...patch,
})
const decide = (
  toolName: string,
  input: Record<string, unknown>,
  patch?: Partial<Settings>,
) => decideToolCall({ id: '1', toolName, input }, settings(patch))

describe('inside the workspace', () => {
  test('auto mode allows writes', async () => {
    expect(
      (
        await decide(
          'write_file',
          { path: 'a.txt' },
          { permissionMode: 'auto' },
        )
      ).decision,
    ).toBe('allow')
  })
  test('ask mode allows reads but asks for writes and shell', async () => {
    const ask = { permissionMode: 'ask' } as const
    expect((await decide('read_file', { path: 'a.txt' }, ask)).decision).toBe(
      'allow',
    )
    expect((await decide('write_file', { path: 'a.txt' }, ask)).decision).toBe(
      'ask',
    )
    expect((await decide('run_shell', { command: 'ls' }, ask)).decision).toBe(
      'ask',
    )
  })
  // Reported 2026-11-04: approving every networked command got tiresome. Auto mode now lets
  // sandboxed commands go online like web_search; ask mode still asks.
  test('networked shell asks in ask mode, runs in auto mode', async () => {
    const net = { command: 'curl x', network: true }
    expect(
      (await decide('run_shell', net, { permissionMode: 'ask' })).decision,
    ).toBe('ask')
    expect(
      (await decide('run_shell', net, { permissionMode: 'auto' })).decision,
    ).toBe('allow')
  })
})

describe('outside the workspace', () => {
  test('asks and offers the containing directory for "always allow"', async () => {
    const result = await decide('write_file', { path: join(outside, 'a.txt') })
    expect(result.decision).toBe('ask')
    expect(result.dir).toBe(outside)
  })
  test('../ cannot climb out of the workspace unnoticed', async () => {
    const result = await decide('write_file', {
      path: join('..', outside.split('/').at(-1)!, 'a.txt'),
    })
    expect(result.decision).toBe('ask')
  })
  test('an allow rule lets it through, without offering another rule', async () => {
    const result = await decide(
      'write_file',
      { path: join(outside, 'a.txt') },
      { dirRules: [{ path: outside, access: 'allow' }] },
    )
    expect(result).toMatchObject({ decision: 'allow' })
    expect(result.dir).toBeUndefined()
  })
  test('a deny rule wins even in full access', async () => {
    const result = await decide(
      'read_file',
      { path: join(outside, 'a.txt') },
      {
        permissionMode: 'full',
        dirRules: [{ path: outside, access: 'deny' }],
      },
    )
    expect(result.decision).toBe('deny')
  })
  test('deleting a folder that contains a denied one is refused', async () => {
    const result = await decide(
      'delete_path',
      { path: outside },
      {
        permissionMode: 'full',
        dirRules: [{ path: join(outside, 'secret'), access: 'deny' }],
      },
    )
    expect(result.decision).toBe('deny')
  })
})

describe('hard limits hold in every mode', () => {
  const full = { permissionMode: 'full' } as const
  test.each([
    ['~/.ssh/id_ed25519'],
    ['~/Library/Keychains/login.keychain-db'],
    ['~/Library/Application Support/Google/Chrome/Default/Login Data'],
    [process.env.FAMILIAR_DATA_DIR + '/settings.json'],
    // Computer History's encrypted raw events.
    [process.env.FAMILIAR_DATA_DIR + '/perception/2026-10-29-14.enc'],
  ])('%s', async (path) => {
    expect((await decide('read_file', { path }, full)).decision).toBe('deny')
  })
  test('deleting home (which contains ~/.ssh) is refused', async () => {
    expect(
      (await decide('delete_path', { path: homedir() }, full)).decision,
    ).toBe('deny')
  })
  test('unknown tools and missing paths are refused', async () => {
    expect((await decide('format_disk', { path: 'a' })).decision).toBe('deny')
    expect((await decide('write_file', {})).decision).toBe('deny')
  })
})

// Asked for 2026-11-04: ls ~/.familiar failed with "Operation not permitted" and nothing asked.
// The user can turn the command sandbox off; a command naming a protected place then asks first.
describe('command sandbox off', () => {
  const off = { permissionMode: 'auto' as const, shellSandbox: false }
  test('a command naming ~/.familiar or ~/.ssh asks, saying where', async () => {
    for (const command of [
      'ls ~/.familiar',
      'cat $HOME/.ssh/id_ed25519',
      `ls "${homedir()}/.familiar/mcp.json"`,
    ]) {
      const d = await decide('run_shell', { command }, off)
      expect(d.decision).toBe('ask')
      expect(d.reason).toContain('登录凭据')
    }
  })
  test('other commands run without asking; with the sandbox on nothing changes', async () => {
    expect(
      (await decide('run_shell', { command: `ls ${workspace}` }, off)).decision,
    ).toBe('allow')
    expect(
      (await decide('run_shell', { command: 'ls ~/Downloads' }, off)).decision,
    ).toBe('allow')
    const on = await decide(
      'run_shell',
      { command: 'ls ~/.familiar' },
      { permissionMode: 'auto' },
    )
    expect(on.decision).toBe('allow')
  })
})

// Reported 2026-11-04: directories the user had allowed never showed in 目录规则. Only the
// "always" link saved a rule, and network asks did not offer one at all.
describe('an approval leaves a rule', () => {
  const net = { command: 'curl x', network: true, cwd: outside }
  test('a network ask offers its directory, and the rule it leaves lets it go online', async () => {
    const asked = await decide('run_shell', net, { permissionMode: 'ask' })
    expect(asked).toMatchObject({ decision: 'ask', dir: outside })
    const rule = grantedRule({
      toolName: 'run_shell',
      input: net,
      dir: asked.dir,
    })
    expect(rule).toEqual({ path: outside, access: 'allow', network: true })
    expect(
      (
        await decide('run_shell', net, {
          permissionMode: 'ask',
          dirRules: [rule!],
        })
      ).decision,
    ).toBe('allow')
  })
  test('a plain allow rule still asks before going online', async () => {
    const result = await decide('run_shell', net, {
      permissionMode: 'ask',
      dirRules: [{ path: outside, access: 'allow' }],
    })
    expect(result).toMatchObject({ decision: 'ask', dir: outside })
  })
  test('in ask mode a network rule does not skip asking for workspace commands', async () => {
    const result = await decide(
      'run_shell',
      { command: 'curl x', network: true },
      {
        permissionMode: 'ask',
        dirRules: [{ path: workspace, access: 'allow', network: true }],
      },
    )
    expect(result.decision).toBe('ask')
  })
  test('a later file grant keeps the network access', () => {
    const rules = withRule(
      [{ path: outside, access: 'allow', network: true }],
      {
        path: outside,
        access: 'allow',
      },
    )
    expect(rules).toEqual([{ path: outside, access: 'allow', network: true }])
  })
  test('a request without a directory leaves no rule', () => {
    expect(grantedRule({ toolName: 'run_shell', input: {} })).toBeUndefined()
  })
})
