import { bubblePlainText } from '../chat/content'
import { useEffect, useState, type CSSProperties } from 'react'
import type { Session } from '../../shared'
import { api } from '../api'
import { Pet } from '../pet/Pet'
import { scales } from '../pet/logic'
import { Composer } from '../shared-ui/Composer'
const bubbleTimeout = (text: string) =>
  12000 + Math.min(8000, [...text].length * 60)
import { useSession } from '../shared-ui/session'
import { useTurnStatus } from '../shared-ui/status'
export function Bubble({
  text,
  variant = 'reply',
  fading = false,
}: {
  text: string
  variant?: 'reply' | 'proactive'
  fading?: boolean
}) {
  return (
    <button
      data-hit
      className={`bubble ${variant} ${fading ? 'fading' : ''}`}
      onClick={() => api.toggleChat()}
      aria-label="展开完整对话"
    >
      {text}
      <span className="tail" />
    </button>
  )
}
/**
 * Above the reopened capsule: where the conversation stands, so hiding the capsule never
 * loses the thread. Continues the current one, or offers the one set aside after a long pause.
 */
function ContextStrip({ session }: { session: Session }) {
  const [error, setError] = useState('')
  if (session.running || session.bubble) return null
  const reply = session.messages.findLast(
    (m) => m.role === 'assistant' && (m.content || m.error),
  )
  if (session.messages.length)
    return (
      <div className="context-strip" data-hit>
        <button
          className="context-main"
          title="展开完整对话"
          onClick={() => api.toggleChat()}
        >
          <span className="muted">上次聊到</span>
          <span>
            {reply
              ? bubblePlainText(reply.content || reply.error || '', 36)
              : '…'}
          </span>
        </button>
        <button className="context-action" onClick={() => api.newSession()}>
          新对话
        </button>
      </div>
    )
  if (!session.previous) return null
  const { id, title } = session.previous
  return (
    <div className="context-strip" data-hit>
      <span className="context-main muted">{error || '已开始新对话'}</span>
      <button
        className="context-action"
        title={title}
        onClick={() => {
          setError('')
          api.openConversation(id).catch(() => setError('上次的对话打不开了'))
        }}
      >
        继续上次
      </button>
    </div>
  )
}
export function Overlay() {
  const session = useSession()
  const [fading, setFading] = useState(false)
  useEffect(() => {
    setFading(false)
    if (session.running || !session.bubble) return
    const timer = setTimeout(
      () => setFading(true),
      bubbleTimeout(session.bubble) - 400,
    )
    return () => clearTimeout(timer)
  }, [session.running, session.bubble])
  const [open, setOpen] = useState(false)
  const [name, setName] = useState('小黑')
  const [scale, setScale] = useState(scales.medium)
  useEffect(() => {
    const off = [api.onCapsule(setOpen), api.onSize((s) => setScale(scales[s]))]
    const update = () => {
      void api
        .getSettings()
        .then((s) => {
          setName(s.pet.name)
          setScale(scales[s.pet.size])
        })
        .catch(console.error)
    }
    update()
    window.addEventListener('focus', update)
    return () => {
      off.forEach((f) => f())
      window.removeEventListener('focus', update)
    }
  }, [])
  const status = useTurnStatus(session, name)
  return (
    <div
      className="overlay"
      style={
        {
          '--pet-width': `${192 * scale}px`,
          '--pet-height': `${208 * scale}px`,
        } as CSSProperties
      }
    >
      <Pet />
      {session.bubble && session.origin === 'capsule' && (
        <Bubble text={bubblePlainText(session.bubble)} fading={fading} />
      )}
      {open && (
        <div className="capsule">
          <ContextStrip session={session} />
          <Composer
            running={session.running}
            mini
            name={name}
            status={status}
            failed={session.error}
            continuing={session.messages.length > 0}
          />
        </div>
      )}
    </div>
  )
}
