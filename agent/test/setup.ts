import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// system.ts reads these at import time; point them at throwaway folders so tests never touch
// the real app data, conversations or Keychain item.
const root = mkdtempSync(join(tmpdir(), 'familiar-test-'))
process.env.FAMILIAR_DATA_DIR = join(root, 'data')
process.env.FAMILIAR_CONVERSATIONS_DIR = join(root, 'conversations')
process.env.FAMILIAR_KEYCHAIN_SERVICE = 'com.allinpet.familiar.unit-test'
