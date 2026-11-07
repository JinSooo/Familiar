import { tmpdir } from 'node:os'
import {
  forbiddenRoots,
  credentialRoots,
  familiarWorkspaceDir,
  normalizePath,
  readableFamiliarDirs,
  within,
} from '../permissions/paths'
import type { Settings } from '../../../src/shared'

export async function sandboxProfile(
  settings: Settings,
  network: boolean,
): Promise<string> {
  const quote = (s: string): string => JSON.stringify(s)
  const subpath = (path: string): string => `(subpath ${quote(path)})`
  const workspace = normalizePath(settings.workspacePath)
  const managedWorkspace = familiarWorkspaceDir()
  const readableDirs = readableFamiliarDirs()
  const exceptions = [
    ...(within(workspace, managedWorkspace)
      ? [workspace]
      : within(managedWorkspace, workspace)
        ? [managedWorkspace]
        : []),
    ...readableDirs,
  ]
  return [
    '(version 1)',
    '(deny default)',
    '(allow process*)',
    '(allow sysctl-read)',
    '(allow mach-lookup)',
    '(allow file-read*)',
    `(allow file-write* (subpath ${quote(workspace)}) (subpath ${quote(normalizePath(tmpdir()))}) (literal "/dev/null"))`,
    ...readableDirs.map((dir) => `(allow file-read* (subpath ${quote(dir)}))`),
    `(allow file-read* file-write* (subpath ${quote(workspace)}))`,
    ...(network ? ['(allow network*)'] : []),
    // Later rules win. Carve out only managed data, never a broad workspace.
    ...[...new Set(await forbiddenRoots())].map((root) => {
      const excluded = exceptions
        .filter((dir) => within(dir, root))
        .map((dir) => `(require-not ${subpath(dir)})`)
      const filter = excluded.length
        ? `(require-all ${subpath(root)} ${excluded.join(' ')})`
        : subpath(root)
      return `(deny file-read* file-write* ${filter})`
    }),
    ...readableDirs.map((dir) => `(deny file-write* ${subpath(dir)})`),
    // Credentials and user denials have no exceptions.
    ...credentialRoots().map(
      (root) => `(deny file-read* file-write* (subpath ${quote(root)}))`,
    ),
    '(deny file-read* file-write* (regex #"/(Login Data(-journal|-wal|-shm)?|logins[.]json|key4[.]db(-wal|-shm)?)$"))',
    ...settings.dirRules
      .filter((rule) => rule.access === 'deny')
      .map(
        (rule) =>
          `(deny file-read* file-write* ${subpath(normalizePath(rule.path, workspace))})`,
      ),
  ].join('\n')
}
