import { describe, expect, test } from 'bun:test'
import { homedir, tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { settingsSchema } from '../../src/shared'
import { decideToolCall } from '../src/permissions'
import {
  credentialRoots,
  normalizePath,
  readableFamiliarDirs,
} from '../src/permissions/paths'
import { dataDir } from '../src/system'
import { sandboxProfile } from '../src/workspace/sandbox'

const data = normalizePath(dataDir)
const workspace = join(data, 'workspace')
const subpath = (path: string) =>
  `(subpath ${JSON.stringify(normalizePath(path))})`
const deny = (path: string) => `(deny file-read* file-write* ${subpath(path)})`

// Assert the emitted policy, not native enforcement (sandbox-exec needs a host macOS run).
function afterAllows(profile: string, rule: string): void {
  const lines = profile.split('\n')
  const lastAllow = lines.findLastIndex((line) => line.startsWith('(allow '))
  expect(lastAllow).toBeGreaterThan(-1)
  expect(lines.indexOf(rule)).toBeGreaterThan(lastAllow)
}

describe('sandbox rule precedence', () => {
  test('private data denials exclude only the managed workspace and readable folders', async () => {
    for (const workspacePath of [
      dirname(data),
      data,
      workspace,
      join(data, 'perception'),
    ]) {
      const profile = await sandboxProfile(
        settingsSchema.parse({ workspacePath }),
        true,
      )
      const exceptions = [
        ...(workspacePath === join(data, 'perception') ? [] : [workspace]),
        ...readableFamiliarDirs(),
      ]
      afterAllows(
        profile,
        `(deny file-read* file-write* (require-all ${subpath(data)} ${exceptions.map((dir) => `(require-not ${subpath(dir)})`).join(' ')}))`,
      )
    }
    const profile = await sandboxProfile(
      settingsSchema.parse({ workspacePath: homedir() }),
      false,
    )
    afterAllows(profile, deny(join(homedir(), '.familiar')))
    afterAllows(
      profile,
      deny(join(homedir(), 'Library/Application Support/Familiar')),
    )
  })

  test('user denials follow workspace, readable-folder and network allows', async () => {
    for (const path of [
      'private',
      workspace,
      dirname(data),
      ...readableFamiliarDirs(),
    ]) {
      const settings = settingsSchema.parse({
        workspacePath: workspace,
        dirRules: [
          { path, access: 'deny' },
          { path: join(workspace, 'private/public'), access: 'allow' },
        ],
      })
      const profile = await sandboxProfile(settings, true)
      afterAllows(profile, deny(normalizePath(path, workspace)))
    }
  })

  test('the four readable directories stay read-only inside a broader or nested workspace', async () => {
    for (const workspacePath of [
      dirname(data),
      data,
      ...readableFamiliarDirs(),
      join(data, 'memory/nested'),
    ]) {
      const profile = await sandboxProfile(
        settingsSchema.parse({ workspacePath }),
        false,
      )
      for (const dir of readableFamiliarDirs()) {
        expect(profile).toContain(`(allow file-read* ${subpath(dir)})`)
        afterAllows(profile, `(deny file-write* ${subpath(dir)})`)
      }
    }
  })

  test('normal workspace, temporary files and network retain their allows', async () => {
    const profile = await sandboxProfile(
      settingsSchema.parse({ workspacePath: workspace }),
      false,
    )
    expect(profile).toContain(
      `(allow file-read* file-write* ${subpath(workspace)})`,
    )
    expect(profile).toContain(`${subpath(tmpdir())} (literal "/dev/null"))`)
    expect(profile).not.toContain('(allow network*)')
    expect(
      await sandboxProfile(
        settingsSchema.parse({ workspacePath: workspace }),
        true,
      ),
    ).toContain('(allow network*)')
    for (const dir of readableFamiliarDirs())
      expect(profile).toContain(`(allow file-read* ${subpath(dir)})`)
  })

  test('credentials and browser secrets still override all allows', async () => {
    const profile = await sandboxProfile(
      settingsSchema.parse({ workspacePath: homedir() }),
      true,
    )
    for (const root of credentialRoots()) afterAllows(profile, deny(root))
    afterAllows(
      profile,
      '(deny file-read* file-write* (regex #"/(Login Data(-journal|-wal|-shm)?|logins[.]json|key4[.]db(-wal|-shm)?)$"))',
    )
  })
})

describe('matching file-tool boundaries', () => {
  for (const permissionMode of ['ask', 'auto', 'full'] as const) {
    test(`private data stays forbidden in ${permissionMode}`, async () => {
      for (const workspacePath of [
        dirname(data),
        data,
        join(data, 'perception'),
      ]) {
        const settings = settingsSchema.parse({ workspacePath, permissionMode })
        for (const path of [
          'settings.json',
          'mcp.json',
          'perception/buffer.enc',
        ]) {
          for (const toolName of ['read_file', 'write_file', 'delete_path']) {
            expect(
              (
                await decideToolCall(
                  { id: '1', toolName, input: { path: join(data, path) } },
                  settings,
                )
              ).decision,
            ).toBe('deny')
          }
        }
        expect(
          (
            await decideToolCall(
              { id: '1', toolName: 'delete_path', input: { path: data } },
              settings,
            )
          ).decision,
        ).toBe('deny')
      }
    })

    test(`managed folders stay read-only in ${permissionMode}`, async () => {
      for (const dir of readableFamiliarDirs()) {
        for (const workspacePath of [dirname(data), dir, join(dir, 'nested')]) {
          const settings = settingsSchema.parse({
            workspacePath,
            permissionMode,
          })
          const path = join(dir, 'nested/note.md')
          expect(
            (
              await decideToolCall(
                { id: '1', toolName: 'read_file', input: { path } },
                settings,
              )
            ).decision,
          ).toBe('allow')
          for (const toolName of [
            'write_file',
            'edit_file',
            'delete_path',
            'make_dir',
          ])
            expect(
              (
                await decideToolCall(
                  { id: '1', toolName, input: { path } },
                  settings,
                )
              ).decision,
            ).toBe('deny')
        }
      }
    })
  }

  test('the default workspace remains writable and readable', async () => {
    const settings = settingsSchema.parse({
      workspacePath: workspace,
      permissionMode: 'auto',
    })
    for (const toolName of ['read_file', 'write_file', 'delete_path'])
      expect(
        (
          await decideToolCall(
            { id: '1', toolName, input: { path: join(workspace, 'test.txt') } },
            settings,
          )
        ).decision,
      ).toBe('allow')
  })

  test('unsandboxed commands still ask about private data with a home workspace', async () => {
    const settings = settingsSchema.parse({
      workspacePath: homedir(),
      permissionMode: 'auto',
      shellSandbox: false,
    })
    expect(
      (
        await decideToolCall(
          {
            id: '1',
            toolName: 'run_shell',
            input: { command: 'cat ~/.familiar/mcp.json' },
          },
          settings,
        )
      ).decision,
    ).toBe('ask')
  })
})
