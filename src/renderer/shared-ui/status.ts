import { useEffect, useState } from 'react'
import type { PublicSettings, Session } from '../../shared'

/**
 * One line for what the pet is doing in the current turn. While nothing has come back yet it
 * counts the seconds, so a slow model service reads as slow rather than frozen.
 */
export function useTurnStatus(session: Session, name: string): string {
  const [now, setNow] = useState(Date.now())
  useEffect(() => {
    if (!session.running) return
    setNow(Date.now())
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [session.running])
  if (session.approvals.length) return '等你允许…'
  const tool = session.tools.findLast((t) => !t.done)
  if (tool) return `正在${tool.name}…`
  if (session.bubble) return '正在回复…'
  const turn = session.messages.length - 1
  const startedAt = session.messages.findLast(
    (m) => m.role === 'user',
  )?.createdAt
  const waited = startedAt ? Math.floor((now - startedAt) / 1000) : 0
  // Only before anything came back: after tools ran, a long turn is work, not a stalled service.
  const nothingYet =
    !session.messages[turn]?.content &&
    !session.tools.some((t) => t.turn === turn)
  if (nothingYet && waited >= 20) return `模型服务回应慢… ${waited} 秒`
  if (waited >= 5) return `${name}在想… ${waited} 秒`
  return `${name}在想…`
}

/** The chat model has what a reply needs: a model, and a key or the ChatGPT sign-in. */
export function modelReady(model: PublicSettings['model']): boolean {
  if (!model.model.trim()) return false
  if (model.protocol === 'chatgpt') return true
  if (model.protocol === 'openai-compatible' && !model.baseURL.trim())
    return false
  return model.apiKeySet
}

/** An error the user fixes on the 模型 settings page (agent/src/agent/provider.ts, errors.ts). */
export const needsModelSetup = (error: string) =>
  /设置里的「模型」|在设置里用 ChatGPT 登录|在设置里重新登录|检查 API Key|在设置里换一个模型/.test(
    error,
  )
