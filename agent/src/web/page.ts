import { lookup } from 'node:dns/promises'
import { isIP } from 'node:net'

/**
 * fetch_page: one public web page as plain text plus its main images. Everything here is
 * untrusted input that goes to the model, so it is size-capped and the request can only reach
 * public addresses (no localhost, LAN or link-local, also after redirects).
 */
export interface Page {
  url: string
  title: string
  description: string
  images: { url: string; alt: string }[]
  text: string
}

const maxBytes = 3 * 1024 * 1024
const maxText = 12000

export function privateAddress(ip: string): boolean {
  if (isIP(ip) === 6) {
    const v6 = ip.toLowerCase()
    if (v6 === '::1' || v6 === '::') return true
    if (/^(fc|fd|fe8|fe9|fea|feb)/.test(v6)) return true
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(v6)
    return mapped ? privateAddress(mapped[1]!) : false
  }
  const [a, b] = ip.split('.').map(Number) as [number, number]
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    a >= 224
  )
}

/** Throws unless the URL is http(s) on a host that resolves only to public addresses. */
export async function assertPublic(raw: string): Promise<URL> {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw new Error('网址无效')
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:')
    throw new Error('只能读取 http 或 https 网页')
  const host = url.hostname.replace(/^\[|\]$/g, '')
  if (/^localhost$|\.local$|\.localhost$|\.internal$/i.test(host))
    throw new Error('不能读取本机或局域网地址')
  const addresses = isIP(host)
    ? [host]
    : (await lookup(host, { all: true })).map((a) => a.address)
  if (!addresses.length || addresses.some(privateAddress))
    throw new Error('不能读取本机或局域网地址')
  return url
}

export async function fetchPage(
  raw: string,
  fetchImpl: typeof globalThis.fetch,
  signal?: AbortSignal,
  /** Longer for a page saved to the knowledge base than for one read into the chat. */
  textLimit = maxText,
): Promise<Page> {
  let url = await assertPublic(raw)
  let response: Response | undefined
  // Follow redirects by hand so every hop gets the same address check.
  for (let hop = 0; hop < 5; hop++) {
    response = await fetchImpl(url, {
      redirect: 'manual',
      signal: signal ?? AbortSignal.timeout(20000),
      headers: {
        'user-agent':
          'Mozilla/5.0 (Macintosh; Intel Mac OS X 15_0) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/19.0 Safari/605.1.15',
        accept: 'text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.5',
        'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8',
      },
    })
    const next = response.headers.get('location')
    if (response.status < 300 || response.status >= 400 || !next) break
    url = await assertPublic(new URL(next, url).toString())
  }
  if (!response) throw new Error('读取失败')
  if (!response.ok) throw new Error(`网页返回 ${response.status}`)
  const type = response.headers.get('content-type') ?? ''
  if (!/text\/|json|xml/i.test(type))
    throw new Error(`不是网页（${type.split(';')[0] || '未知类型'}）`)
  const body = await readCapped(response)
  if (!/html|xml/i.test(type))
    return {
      url: url.toString(),
      title: '',
      description: '',
      images: [],
      text: body.slice(0, textLimit),
    }
  return parseHtml(body, url, textLimit)
}

async function readCapped(response: Response): Promise<string> {
  const reader = response.body?.getReader()
  if (!reader) return ''
  const chunks: Uint8Array[] = []
  let size = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    chunks.push(value)
    size += value.byteLength
    if (size > maxBytes) {
      await reader.cancel()
      break
    }
  }
  return new TextDecoder().decode(Buffer.concat(chunks))
}

const entities: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: '\u00a0',
  mdash: '—',
  ndash: '–',
  hellip: '…',
  ldquo: '“',
  rdquo: '”',
  lsquo: '‘',
  rsquo: '’',
}
export function decodeEntities(text: string): string {
  return text.replace(/&(#x[\da-f]+|#\d+|[a-z]+);/gi, (whole, code: string) => {
    if (code[0] === '#') {
      const n =
        code[1] === 'x' || code[1] === 'X'
          ? parseInt(code.slice(2), 16)
          : parseInt(code.slice(1), 10)
      return Number.isFinite(n) && n > 0 && n < 0x110000
        ? String.fromCodePoint(n)
        : whole
    }
    return entities[code.toLowerCase()] ?? whole
  })
}
const attr = (tag: string, name: string): string =>
  decodeEntities(
    new RegExp(`\\s${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i')
      .exec(tag)
      ?.slice(2)
      .find((v) => v !== undefined) ?? '',
  ).trim()
function meta(html: string, key: string): string {
  for (const tag of html.match(/<meta\b[^>]*>/gi) ?? [])
    if (
      attr(tag, 'property').toLowerCase() === key ||
      attr(tag, 'name').toLowerCase() === key
    )
      return attr(tag, 'content')
  return ''
}

export function parseHtml(html: string, base: URL, textLimit = maxText): Page {
  const title = decodeEntities(
    meta(html, 'og:title') ||
      (/<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1] ?? ''),
  )
    .replace(/\s+/g, ' ')
    .trim()
  const description = meta(html, 'og:description') || meta(html, 'description')
  let body = html
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(
      /<(script|style|noscript|svg|template|iframe|form|nav|footer|aside)\b[\s\S]*?<\/\1>/gi,
      ' ',
    )
  // Prefer the article itself over menus and sidebars when the page marks it.
  const main =
    /<article\b[\s\S]*<\/article>/i.exec(body)?.[0] ??
    /<main\b[\s\S]*<\/main>/i.exec(body)?.[0]
  if (main && main.length > 500) body = main
  const absolute = (src: string) => {
    try {
      const u = new URL(src, base)
      return u.protocol === 'https:' || u.protocol === 'http:'
        ? u.toString()
        : ''
    } catch {
      return ''
    }
  }
  const images: Page['images'] = []
  const seen = new Set<string>()
  const addImage = (src: string, alt: string) => {
    const url = absolute(src)
    if (!url || seen.has(url) || images.length >= 6) return
    if (
      /\.(svg|gif|ico)(\?|$)|logo|icon|avatar|sprite|pixel|tracking|badge|emoji/i.test(
        url,
      )
    )
      return
    seen.add(url)
    images.push({ url, alt: alt.slice(0, 120) })
  }
  const og = meta(html, 'og:image')
  if (og) addImage(og, title)
  for (const tag of body.match(/<img\b[^>]*>/gi) ?? []) {
    const width = Number(attr(tag, 'width'))
    if (width && width < 120) continue
    addImage(attr(tag, 'src') || attr(tag, 'data-src'), attr(tag, 'alt'))
  }
  const text = decodeEntities(
    body
      .replace(/<(br|hr)\b[^>]*>/gi, '\n')
      .replace(/<\/(p|div|section|h[1-6]|li|tr|blockquote|pre)>/gi, '\n')
      .replace(/<li\b[^>]*>/gi, '\n- ')
      .replace(/<[^>]+>/g, ' '),
  )
    .replace(/[ \t\f\v\u00a0]+/g, ' ')
    .replace(/\s*\n\s*/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
  return {
    url: base.toString(),
    title,
    description,
    images,
    text: text.length > textLimit ? `${text.slice(0, textLimit)}…` : text,
  }
}
