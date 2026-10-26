import { execFile, spawn } from 'node:child_process'
import { promisify } from 'node:util'
import { resolve } from 'node:path'
const exec = promisify(execFile)
if (!process.env.FAMILIAR_DATA_DIR)
  throw new Error('FAMILIAR_DATA_DIR is required')
export const dataDir = resolve(process.env.FAMILIAR_DATA_DIR)
export const resourcesDir = resolve(
  process.env.FAMILIAR_RESOURCES_DIR ?? 'resources',
)
const service = process.env.FAMILIAR_KEYCHAIN_SERVICE ?? 'com.allinpet.familiar'
const account = 'model-api-key'
export async function readKey(): Promise<string> {
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
export async function writeKey(key: string): Promise<void> {
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
  if ((await readKey()) !== key) throw new Error('钥匙串 API Key 写入校验失败')
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
export async function accent(): Promise<string> {
  try {
    const value = Number(
      (
        await exec('/usr/bin/defaults', ['read', '-g', 'AppleAccentColor'])
      ).stdout.trim(),
    )
    return (
      (
        {
          '-1': '#8E8E93',
          0: '#FF3B30',
          1: '#FF9500',
          2: '#FFCC00',
          3: '#34C759',
          4: '#0A66D8',
          5: '#AF52DE',
          6: '#FF2D55',
        } as Record<number, string>
      )[value] ?? '#0A66D8'
    )
  } catch {
    return '#0A66D8'
  }
}
export async function idleSeconds(): Promise<number> {
  const output = (await exec('/usr/sbin/ioreg', ['-c', 'IOHIDSystem'])).stdout
  return Number(output.match(/"HIDIdleTime"\s*=\s*(\d+)/)?.[1] ?? 0) / 1e9
}
