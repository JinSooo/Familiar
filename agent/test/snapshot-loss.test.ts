import { afterEach, expect, spyOn, test } from 'bun:test'
import { mkdtempSync } from 'node:fs'
import { chmod, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { settingsSchema } from '../../src/shared'
import { ensureWorkspace, snapshot } from '../src/workspace'

const dirs: string[] = []
const temp = () => {
  const dir = mkdtempSync(join(tmpdir(), 'familiar-git-loss-'))
  dirs.push(dir)
  return dir
}
const git = (path: string, ...args: string[]) =>
  execFileSync('/usr/bin/git', ['-C', path, ...args], {
    encoding: 'utf8',
  }).trim()
afterEach(async () => {
  for (const dir of dirs.splice(0))
    await rm(dir, { recursive: true, force: true })
})

test('1: concurrent snapshots serialize the whole git transaction', async () => {
  const dir = temp()
  await ensureWorkspace(settingsSchema.parse({ workspacePath: dir }))
  const hook = join(dir, '.git/hooks/pre-commit')
  await writeFile(hook, '#!/bin/sh\nsleep 0.15\n')
  await chmod(hook, 0o700)
  await writeFile(join(dir, 'note.md'), '必须进入快照')
  const errors = spyOn(console, 'error').mockImplementation(() => {})
  try {
    await Promise.all(
      Array.from({ length: 8 }, (_, i) => snapshot(dir, `snapshot ${i}`)),
    )
    expect(errors.mock.calls).toEqual([])
    expect(git(dir, 'show', 'HEAD:note.md')).toBe('必须进入快照')
    expect(git(dir, 'status', '--porcelain')).toBe('')
  } finally {
    errors.mockRestore()
  }
})

test('1: a transient external index lock is retried without removing the lock', async () => {
  const dir = temp()
  await ensureWorkspace(settingsSchema.parse({ workspacePath: dir }))
  await writeFile(join(dir, 'note.md'), '短暂冲突后保存')
  const lock = join(dir, '.git/index.lock')
  await writeFile(lock, 'external lock')
  const errors = spyOn(console, 'error').mockImplementation(() => {})
  const release = new Promise<void>((resolve, reject) =>
    setTimeout(() => {
      readFile(lock, 'utf8')
        .then((text) => {
          expect(text).toBe('external lock')
          return rm(lock)
        })
        .then(resolve, reject)
    }, 80),
  )
  try {
    await Promise.all([snapshot(dir, 'retry'), release])
    expect(errors.mock.calls).toEqual([])
    expect(git(dir, 'show', 'HEAD:note.md')).toBe('短暂冲突后保存')
  } finally {
    errors.mockRestore()
  }
})

test('2: initialization is committed once and editor changes still get a meaningful snapshot', async () => {
  const dir = temp()
  await mkdir(join(dir, 'notes'))
  await writeFile(join(dir, 'notes/manual.md'), '原内容')
  const settings = settingsSchema.parse({ workspacePath: dir })
  await ensureWorkspace(settings)
  await writeFile(join(dir, 'notes/manual.md'), '手工更新')
  await ensureWorkspace(settings)
  await ensureWorkspace(settings)
  expect(git(dir, 'log', '--format=%s')).toBe('Initialize Familiar')
  // Conversation, memory and reflection callers snapshot edits before doing their own work.
  await snapshot(dir, 'familiar: 保存之前的改动')
  expect(git(dir, 'log', '--format=%s').split('\n')).toEqual([
    'familiar: 保存之前的改动',
    'Initialize Familiar',
  ])
  expect(git(dir, 'show', 'HEAD:notes/manual.md')).toBe('手工更新')
})
