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
