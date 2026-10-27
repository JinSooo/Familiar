export function agentError(error: unknown): Error {
  const chain: string[] = []
  let current = error
  for (let i = 0; i < 6 && current; i++) {
    if (current instanceof Error) chain.push(current.message)
    if (typeof current !== 'object') break
    const item = current as {
      statusCode?: number
      cause?: unknown
      code?: string
    }
    chain.push(String(item.statusCode ?? ''), item.code ?? '')
    current = item.cause
  }
  const text = chain.join(' ')
  let message: string
  if (/ResponseTimeoutError|sent no response within/.test(text))
    message =
      '模型服务 45 秒没有回应（中转站拥堵或这个模型暂时不可用），请稍后再试或换个模型。'
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
    /ERR_INCOMPLETE_CHUNKED_ENCODING|ERR_CONNECTION_(RESET|CLOSED)|terminated|Failed to process successful response/i.test(
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
  else message = '模型运行失败，请检查模型设置或稍后重试。'
  return new Error(message, { cause: error })
}
