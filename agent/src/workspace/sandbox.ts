import { tmpdir } from 'node:os'
import { forbiddenRoots, normalizePath } from '../permissions/paths'
import { importedSkillsDir } from '../extensions/skills'
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
    // Later rules win: imported skills' scripts and files stay readable inside ~/.familiar.
    `(allow file-read* (subpath ${quote(normalizePath(importedSkillsDir()))}))`,
    ...(network ? ['(allow network*)'] : []),
  ].join('\n')
}
