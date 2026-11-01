/** Normalize model math delimiters, leaving fenced/inline code untouched. */
export function normalizeMath(text: string): string {
  const protectedCode =
    /(^ {0,3}(`{3,}|~{3,})[^\n]*(?:\n|$)[\s\S]*?(?:^ {0,3}\2[ \t]*(?:\n|$)|(?![\s\S]))|(`+)[\s\S]*?\3)/gm
  let result = ''
  let offset = 0
  const convert = (value: string) =>
    value
      .replace(
        /\\\[([\s\S]*?)\\\]/g,
        (_, math: string) => `\n$$\n${math}\n$$\n`,
      )
      .replace(/\\\(([\s\S]*?)\\\)/g, (_, math: string) => `$${math}$`)
  for (const match of text.matchAll(protectedCode)) {
    result += convert(text.slice(offset, match.index)) + match[0]
    offset = match.index + match[0].length
  }
  return result + convert(text.slice(offset))
}

export function needsTimeDivider(
  previous: number | undefined,
  current: number,
): boolean {
  return previous === undefined || current - previous >= 5 * 60 * 1000
}
export function formatMessageTime(timestamp: number, now: number): string {
  const date = new Date(timestamp)
  const today = new Date(now)
  const yesterday = new Date(
    today.getFullYear(),
    today.getMonth(),
    today.getDate() - 1,
  )
  const clock = `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
  const sameDay = (a: Date, b: Date) =>
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  return sameDay(date, today)
    ? clock
    : sameDay(date, yesterday)
      ? `昨天 ${clock}`
      : `${date.getMonth() + 1}月${date.getDate()}日 ${clock}`
}

export function bubblePlainText(markdown: string, limit = 80): string {
  // Protect formulas so Markdown cleanup never eats their original notation.
  const math: string[] = []
  const text = markdown
    .replace(
      /(^|\n) {0,3}(`{3,}|~{3,})[^\n]*\n[\s\S]*?(?:\n {0,3}\2[^\n]*(?=\n|$)|$)/g,
      '$1[代码]',
    )
    .replace(
      /\$\$[\s\S]*?\$\$|\$[^$\n]+\$|\\\([\s\S]*?\\\)|\\\[[\s\S]*?\\\]/g,
      (value) => `\uE000${math.push(value) - 1}\uE000`,
    )
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/<https?:\/\/([^>]+)>/g, 'https://$1')
    .replace(/<[^>]*>/g, '')
    .replace(/^\s{0,3}(?:#{1,6}\s+|>\s*|[-*+]\s+|\d+[.)]\s+)/gm, '')
    .replace(/\[[ xX]\]\s*/g, '')
    .replace(/[*_~`|]/g, '')
    .replace(/\uE000(\d+)\uE000/g, (_, i: string) => math[Number(i)] ?? '')
    .replace(/\s+/g, ' ')
    .trim()
  const chars = [...text]
  return chars.length > limit ? `${chars.slice(0, limit).join('')}…` : text
}

type Placed = { at?: number }
/** A reply in the order it happened: text, the tool steps between, and what they brought back. */
export type ReplyPart<T, S, F> =
  | { kind: 'text'; text: string }
  | { kind: 'tools'; tools: T[] }
  | { kind: 'sources'; sources: S[] }
  | { kind: 'files'; files: F[] }
/**
 * Splits a reply's text at the offsets its tool steps, sources and files were recorded at.
 * Things recorded at the same point stay together: steps, then sources, then files. Without an
 * offset (older transcripts) steps go first and sources and files last, as they used to.
 */
export function replyParts<
  T extends Placed,
  S extends Placed,
  F extends Placed,
>(text: string, tools: T[], sources: S[], files: F[]): ReplyPart<T, S, F>[] {
  const clamp = (at: number | undefined, fallback: number) =>
    Math.min(Math.max(at ?? fallback, 0), text.length)
  const points = new Map<number, { tools: T[]; sources: S[]; files: F[] }>()
  const at = (n: number) => {
    let p = points.get(n)
    if (!p) points.set(n, (p = { tools: [], sources: [], files: [] }))
    return p
  }
  for (const t of tools) at(clamp(t.at, 0)).tools.push(t)
  for (const s of sources) at(clamp(s.at, text.length)).sources.push(s)
  for (const f of files) at(clamp(f.at, text.length)).files.push(f)
  const parts: ReplyPart<T, S, F>[] = []
  let from = 0
  for (const n of [...points.keys()].sort((a, b) => a - b)) {
    const p = points.get(n)!
    if (n > from && text.slice(from, n).trim())
      parts.push({ kind: 'text', text: text.slice(from, n) })
    from = Math.max(from, n)
    if (p.tools.length) parts.push({ kind: 'tools', tools: p.tools })
    if (p.sources.length) parts.push({ kind: 'sources', sources: p.sources })
    if (p.files.length) parts.push({ kind: 'files', files: p.files })
  }
  if (text.slice(from).trim())
    parts.push({ kind: 'text', text: text.slice(from) })
  return parts
}
