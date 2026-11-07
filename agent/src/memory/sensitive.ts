/**
 * Things that must never reach memory, checked on every write path. Returns why the text was
 * refused, or null. Errs on the side of refusing: a false positive only costs a re-phrase.
 */
export function sensitiveReason(text: string): string | null {
  if (/-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(text)) return '包含私钥'
  if (
    /\b(sk-[A-Za-z0-9_-]{16,}|sk-ant-[A-Za-z0-9_-]{16,}|AKIA[0-9A-Z]{16}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|xox[abpr]-[A-Za-z0-9-]{10,}|AIza[0-9A-Za-z_-]{30,})/.test(
      text,
    )
  )
    return '包含 API 密钥或访问令牌'
  if (/\bBearer\s+[A-Za-z0-9._~+/=-]{16,}/i.test(text)) return '包含访问令牌'
  if (
    /(密码|口令|密钥|验证码|password|passwd|pwd|passcode|secret|token|api[ _-]?key)["']?\s*(是|为|：|:|=)\s*["']?\S+/i.test(
      text,
    )
  )
    return '包含密码或密钥'
  for (const match of text.matchAll(/(?<!\d)(?:\d[ -]?){12,18}\d(?!\d)/g)) {
    const digits = match[0].replace(/\D/g, '')
    if (digits.length >= 13 && digits.length <= 19 && luhn(digits))
      return '包含银行卡号'
  }
  if (
    /(?<![0-9])[1-9]\d{5}(19|20)\d{2}(0[1-9]|1[0-2])\d{2}\d{3}[\dXx](?![0-9])/.test(
      text,
    )
  )
    return '包含身份证号'
  // Long random-looking strings: unknown key formats.
  for (const match of text.matchAll(/[A-Za-z0-9_+/=-]{32,}/g))
    if (/[A-Za-z]/.test(match[0]) && /\d/.test(match[0]))
      return '包含疑似密钥的长字符串'
  return null
}

function luhn(digits: string): boolean {
  let sum = 0
  for (let i = 0; i < digits.length; i++) {
    let d = Number(digits[digits.length - 1 - i])
    if (i % 2 === 1) {
      d *= 2
      if (d > 9) d -= 9
    }
    sum += d
  }
  return sum % 10 === 0
}
