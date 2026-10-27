import { describe, expect, test } from 'bun:test'
import { mkdtempSync, realpathSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { settingsSchema, type Settings } from '../../src/shared'
import { decideToolCall } from '../src/permissions'

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
  test('networked shell always asks below full access', async () => {
    expect(
      (await decide('run_shell', { command: 'curl x', network: true }))
        .decision,
    ).toBe('ask')
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
