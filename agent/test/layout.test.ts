import { describe, expect, test } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { settingsSchema } from '../../src/shared'
import { migrateLegacyWorkspace } from '../src/migrate'
import { decideToolCall } from '../src/permissions'
import { dataDir } from '../src/system'
import { gitignore } from '../src/workspace'

const git = (cwd: string, ...args: string[]) =>
  execFileSync(
    '/usr/bin/git',
    ['-C', cwd, '-c', 'user.name=t', '-c', 'user.email=t@t', ...args],
    {
      encoding: 'utf8',
    },
  )

describe('one ~/.familiar', () => {
  const workspace = join(dataDir, 'workspace')
  const settings = settingsSchema.parse({
    workspacePath: workspace,
    permissionMode: 'auto',
  })
  const decide = (toolName: string, input: Record<string, unknown>) =>
    decideToolCall({ id: '', toolName, input }, settings)

  test('workspace read-write, data folders read-only, config out of reach', async () => {
    expect(
      (await decide('write_file', { path: join(workspace, 'a.txt') })).decision,
    ).toBe('allow')
    expect(
      (
        await decide('read_file', {
          path: join(dataDir, 'memory', 'profile.md'),
        })
      ).decision,
    ).toBe('allow')
    expect(
      (
        await decide('read_file', {
          path: join(dataDir, 'conversations', 'x.md'),
        })
      ).decision,
    ).toBe('allow')
    expect(
      (
        await decide('write_file', {
          path: join(dataDir, 'memory', 'profile.md'),
        })
      ).decision,
    ).toBe('deny')
    expect(
      (await decide('read_file', { path: join(dataDir, 'settings.json') }))
        .decision,
    ).toBe('deny')
    expect(
      (await decide('read_file', { path: join(dataDir, '.git', 'config') }))
        .decision,
    ).toBe('deny')
    expect((await decide('delete_path', { path: dataDir })).decision).toBe(
      'deny',
    )
  })
})

describe('moving ~/Familiar in', () => {
  test('folders, files and git history move; config never gets committed', async () => {
    const home = mkdtempSync(join(tmpdir(), 'familiar-home-'))
    const legacy = join(home, 'Familiar')
    const root = join(home, '.familiar')
    await mkdir(join(legacy, 'memory'), { recursive: true })
    await mkdir(join(legacy, 'conversations'), { recursive: true })
    await mkdir(join(legacy, 'knowledge'), { recursive: true })
    await writeFile(join(legacy, 'memory', 'profile.md'), '- 喜欢山竹\n')
    await writeFile(join(legacy, 'conversations', 'c.md'), 'hi')
    await writeFile(join(legacy, 'index.html'), '<p>x</p>')
    await writeFile(join(legacy, '.DS_Store'), '')
    git(legacy, 'init', '-q')
    git(legacy, 'add', '-A')
    git(legacy, 'commit', '-qm', 'old')
    await mkdir(root, { recursive: true })
    await writeFile(join(root, 'settings.json'), '{"secret":1}')
    await writeFile(join(root, 'mcp.json'), '{"token":1}')

    const moved = await migrateLegacyWorkspace(legacy, root, legacy)
    expect(moved).toBe(join(root, 'workspace'))
    expect(await readFile(join(root, 'memory', 'profile.md'), 'utf8')).toBe(
      '- 喜欢山竹\n',
    )
    expect(await readdir(join(root, 'workspace'))).toEqual(['index.html'])
    expect(await readFile(join(root, '.gitignore'), 'utf8')).toBe(gitignore)
    git(root, 'add', '-A')
    git(root, 'commit', '-qm', 'move')
    const files = git(root, 'ls-files').trim().split('\n').sort()
    expect(files).toEqual([
      '.gitignore',
      'conversations/c.md',
      'memory/profile.md',
      'workspace/index.html',
    ])
    expect(git(root, 'log', '--oneline').trim().split('\n')).toHaveLength(2)
    // Emptied apart from .DS_Store, the old folder is removed.
    expect(
      await stat(legacy).then(
        () => true,
        () => false,
      ),
    ).toBe(false)
  })

  test('does nothing for a custom workspace, refuses to merge into existing data', async () => {
    const home = mkdtempSync(join(tmpdir(), 'familiar-home-'))
    const legacy = join(home, 'Familiar')
    const root = join(home, '.familiar')
    await mkdir(join(legacy, 'memory'), { recursive: true })
    expect(
      await migrateLegacyWorkspace(legacy, root, join(home, 'elsewhere')),
    ).toBeUndefined()
    await mkdir(join(root, 'memory'), { recursive: true })
    await writeFile(join(root, 'memory', 'x.md'), 'x')
    await expect(migrateLegacyWorkspace(legacy, root, legacy)).rejects.toThrow(
      '已经有内容',
    )
    expect(await readdir(join(legacy, 'memory'))).toEqual([])
  })

  test('an interrupted move finishes on the next start', async () => {
    const home = mkdtempSync(join(tmpdir(), 'familiar-home-'))
    const legacy = join(home, 'Familiar')
    const root = join(home, '.familiar')
    await mkdir(join(root, 'memory'), { recursive: true })
    await writeFile(join(root, 'memory', 'x.md'), 'moved already')
    await mkdir(legacy, { recursive: true })
    await writeFile(join(legacy, '.DS_Store'), '')
    expect(await migrateLegacyWorkspace(legacy, root, legacy)).toBe(
      join(root, 'workspace'),
    )
    expect(
      await stat(legacy).then(
        () => true,
        () => false,
      ),
    ).toBe(false)
  })
})

test('a leftover .git beside a moved history does not block the move, and is kept', async () => {
  const home = mkdtempSync(join(tmpdir(), 'familiar-home-'))
  const legacy = join(home, 'Familiar')
  const root = join(home, '.familiar')
  await mkdir(join(root, '.git'), { recursive: true })
  await mkdir(join(legacy, '.git'), { recursive: true })
  expect(await migrateLegacyWorkspace(legacy, root, legacy)).toBe(
    join(root, 'workspace'),
  )
  expect(await readdir(legacy)).toEqual(['.git'])
})
