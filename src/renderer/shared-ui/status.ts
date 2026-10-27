import { useEffect, useState } from 'react'
import type { Session } from '../../shared'

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
