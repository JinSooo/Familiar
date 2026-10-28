import { tmpdir } from 'node:os'
import {
  forbiddenRoots,
  normalizePath,
  readableFamiliarDirs,
} from '../permissions/paths'
import type { Settings } from '../../../src/shared'

export async function sandboxProfile(
  settings: Settings,
  network: boolean,
): Promise<string> {
  const quote = (s: string): string => JSON.stringify(s)
  const roots = [
    ...(await forbiddenRoots()),
    ...settings.dirRules
      .filter((r) => r.access === 'deny')
      .map((r) => normalizePath(r.path, normalizePath(settings.workspacePath))),
  ]
  return [
    '(version 1)',
    '(deny default)',
    '(allow process*)',
    '(allow sysctl-read)',
    '(allow mach-lookup)',
    '(allow file-read*)',
    `(allow file-write* (subpath ${quote(normalizePath(settings.workspacePath))}) (subpath ${quote(normalizePath(tmpdir()))}) (literal "/dev/null"))`,
    '(deny file-read* file-write* (regex #"/(Login Data(-journal|-wal|-shm)?|logins[.]json|key4[.]db(-wal|-shm)?)$"))',
    ...roots.map(
      (root) => `(deny file-read* file-write* (subpath ${quote(root)}))`,
    ),
    // Later rules win: inside the forbidden ~/.familiar, the workspace stays read-write and
    // memory, conversations, knowledge and skills stay readable.
    ...readableFamiliarDirs().map(
      (dir) => `(allow file-read* (subpath ${quote(dir)}))`,
    ),
    `(allow file-read* file-write* (subpath ${quote(normalizePath(settings.workspacePath))}))`,
    ...(network ? ['(allow network*)'] : []),
  ].join('\n')
}
