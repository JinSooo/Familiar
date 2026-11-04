export function agentError(error: unknown): Error {
  const chain: string[] = []
  let current = error
  for (let i = 0; i < 6 && current; i++) {
    if (current instanceof Error) chain.push(current.message)
    if (typeof current !== 'object') break
    const item = current as {
      statusCode?: number
      cause?: unknown
      lastError?: unknown
      code?: string
      responseBody?: unknown
    }
    chain.push(
      String(item.statusCode ?? ''),
      item.code ?? '',
      // Relays explain themselves in the body (e.g. model_not_found), not in the status line.
      typeof item.responseBody === 'string'
        ? item.responseBody.slice(0, 500)
        : '',
    )
    // RetryError keeps the final attempt in lastError rather than cause.
    current = item.cause ?? item.lastError
  }
  const text = chain.join(' ')
  let message: string
  if (/ResponseTimeoutError|sent no response within/.test(text))
    message =
      '模型服务 45 秒没有回应（中转站拥堵或这个模型暂时不可用），请稍后再试或换个模型。'
  else if (
    /model_not_found|no available channel|model .*does not exist|unknown model|模型不存在|无可用渠道/i.test(
      text,
    )
  )
    message =
      '这个模型在你的账号里用不了（中转站没有它的可用渠道），请在设置里换一个模型，可以先「获取模型列表」看看有哪些。'
  else if (/401|403|unauthorized|invalid.*key/i.test(text))
    message = '模型服务拒绝访问，请检查 API Key 和账号权限。'
  else if (/404|model.*not.*found|unknown model/i.test(text))
    message = '模型或接口不存在，请检查模型名称、协议和 Base URL。'
  else if (/429|rate.limit/i.test(text))
    message = '模型服务请求过多或额度不足，请检查余额或稍后重试。'
  else if (
    /\b50[0234]\b|Service Unavailable|Bad Gateway|Gateway Time-?out|Internal Server Error/i.test(
      text,
    )
  )
    message =
      '模型服务暂时不可用（服务端 5xx），已自动重试仍失败，请稍后再试或换个模型。'
  else if (
    /ERR_INCOMPLETE_CHUNKED_ENCODING|ERR_CONNECTION_(RESET|CLOSED)|terminated|Failed to process successful response|stream ended without/i.test(
      text,
    )
  )
    message = '回复传到一半连接断开了（中转站或代理不稳定），请重试。'
  else if (
    /fetch failed|network|ECONN|ENOTFOUND|EHOST|ETIMEDOUT|timeout/i.test(text)
  )
    message = '无法连接模型服务，请检查网络、代理和 Base URL。'
  else if (error instanceof Error && /[\u3400-\u9fff]/u.test(error.message))
    message = error.message
  else {
    // Nothing above recognised it: say what the service said, so the next one can be classified.
    const said = chain.find((line) => line.trim())?.replace(/\s+/g, ' ')
    message = `模型运行失败，请检查模型设置或稍后重试。${
      said ? `（${said.length > 120 ? `${said.slice(0, 119)}…` : said}）` : ''
    }`
  }
  return new Error(message, { cause: error })
}
