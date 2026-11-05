import { execFile, spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { dirname, join, resolve } from 'node:path'
const exec = promisify(execFile)
if (!process.env.FAMILIAR_DATA_DIR)
  throw new Error('FAMILIAR_DATA_DIR is required')
export const dataDir = resolve(process.env.FAMILIAR_DATA_DIR)
/** User-readable conversation transcripts, beside memory/ in ~/.familiar. */
export const conversationsDir = resolve(
  process.env.FAMILIAR_CONVERSATIONS_DIR ?? join(dataDir, 'conversations'),
)
/** Finder's delete, so the item lands in the Trash and can be put back. */
export async function moveToTrash(path: string): Promise<void> {
  await exec('/usr/bin/osascript', [
    '-e',
    // Without `as alias` Finder cannot resolve the POSIX path (-1728) and nothing moves.
    'on run argv\n tell application "Finder" to delete (POSIX file (item 1 of argv) as alias)\nend run',
    path,
  ])
}
export async function reveal(path: string): Promise<void> {
  await exec('/usr/bin/open', [path])
}
/** Opens a web page in the default browser; only https addresses. */
export async function openExternal(url: string): Promise<void> {
  if (!/^https:\/\//.test(url)) throw new Error('只能打开 https 地址')
  await exec('/usr/bin/open', [url])
}
export const resourcesDir = resolve(
  process.env.FAMILIAR_RESOURCES_DIR ?? 'resources',
)
const service = process.env.FAMILIAR_KEYCHAIN_SERVICE ?? 'com.allinpet.familiar'
/** Keychain items by account: the model API key, and the perception buffer's key. */
export async function readKey(account = 'model-api-key'): Promise<string> {
  try {
    return (
      await exec('/usr/bin/security', [
        'find-generic-password',
        '-s',
        service,
        '-a',
        account,
        '-w',
      ])
    ).stdout.replace(/\r?\n$/, '')
  } catch (error) {
    if ((error as { code?: number }).code === 44) return ''
    throw new Error('无法读取钥匙串 API Key')
  }
}
export async function writeKey(
  key: string,
  account = 'model-api-key',
): Promise<void> {
  // security's interactive parser accepts quoted words; forbid line separators.
  const quote = (s: string) => {
    if (/[\r\n\0]/.test(s)) throw new Error('钥匙串值不能包含换行或 NUL')
    return '"' + s.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"'
  }
  if (!key) {
    try {
      await exec('/usr/bin/security', [
        'delete-generic-password',
        '-s',
        service,
        '-a',
        account,
      ])
    } catch (error) {
      if ((error as { code?: number }).code !== 44)
        throw new Error('无法删除钥匙串 API Key')
    }
    return
  }
  const command =
    'add-generic-password -U -s ' +
    quote(service) +
    ' -a ' +
    quote(account) +
    ' -w ' +
    quote(key) +
    '\n'
  await new Promise<void>((resolve, reject) => {
    const child = spawn('/usr/bin/security', ['-i'], {
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    let failed = false
    child.stdout.resume()
    child.stderr.on('data', (data: Buffer) => {
      if (/SecKeychain|Error:|error:/i.test(data.toString())) failed = true
    })
    child.on('error', () => reject(new Error('无法写入钥匙串 API Key')))
    child.stdin.on('error', () => reject(new Error('无法写入钥匙串 API Key')))
    child.on('close', (code) =>
      code === 0 && !failed
        ? resolve()
        : reject(new Error('无法写入钥匙串 API Key')),
    )
    child.stdin.end(command)
  })
  if ((await readKey(account)) !== key)
    throw new Error('钥匙串 API Key 写入校验失败')
}
let proxies: { http?: string; https?: string } = {}
export async function refreshProxy() {
  try {
    const output = (await exec('/usr/sbin/scutil', ['--proxy'])).stdout
    const value = (name: string) =>
      output.match(new RegExp('\\b' + name + '\\s*:\\s*(.+)'))?.[1]?.trim()
    const proxy = (prefix: string) => {
      const host = value(prefix + 'Proxy'),
        port = value(prefix + 'Port')
      if (
        value(prefix + 'Enable') !== '1' ||
        !host ||
        !port ||
        !/^\d+$/.test(port)
      )
        return undefined
      return (
        'http://' + (host.includes(':') ? '[' + host + ']' : host) + ':' + port
      )
    }
    proxies = { http: proxy('HTTP'), https: proxy('HTTPS') }
  } catch {
    proxies = {}
  }
}
export function proxyFor(url: string) {
  const parsed = new URL(url)
  if (['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname))
    return undefined
  return parsed.protocol === 'https:'
    ? (proxies.https ?? proxies.http)
    : proxies.http
}
export async function idleSeconds(): Promise<number> {
  const output = (await exec('/usr/sbin/ioreg', ['-c', 'IOHIDSystem'])).stdout
  return Number(output.match(/"HIDIdleTime"\s*=\s*(\d+)/)?.[1] ?? 0) / 1e9
}
/** Bytes under a directory, following no symlinks; unreadable entries count as zero. */
export async function directorySize(path: string): Promise<number> {
  const { readdir, lstat } = await import('node:fs/promises')
  let total = 0
  const walk = async (dir: string): Promise<void> => {
    let entries: import('node:fs').Dirent[]
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      const full = join(dir, e.name)
      if (e.isDirectory()) await walk(full)
      else if (e.isFile())
        total += (await lstat(full).catch(() => ({ size: 0 }))).size
    }
  }
  await walk(path)
  return total
}

/** familiar-sensor. Release: beside the agent in Contents/MacOS. Development: `pnpm sensor:build`. */
export function sensorPath(): string | null {
  const candidates = [
    join(dirname(process.execPath), 'familiar-sensor'),
    fileURLToPath(
      new URL('../../sensor/.build/familiar-sensor', import.meta.url),
    ),
  ]
  return candidates.find((p) => existsSync(p)) ?? null
}
