import { bubblePlainText } from '../chat/content'
import { useEffect, useState, type CSSProperties } from 'react'
import {
  proactiveChoices,
  type ProactiveMessage,
  type Session,
} from '../../shared'
import { api } from '../api'
import { Pet } from '../pet/Pet'
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
 * A line the pet said on its own, or a reminder the user set: why now, and its buttons.
 * Clicking the text is the first button.
 */
function ProactiveBubble({ message }: { message: ProactiveMessage }) {
  const answer = (choice: 'ok' | 'later' | 'quiet') =>
    void api.respondProactive(message.id, choice).catch(console.error)
  const { buttons } = proactiveChoices(message.trigger)
  return (
    <div data-hit className="bubble proactive" role="status">
      <button
        type="button"
        className="proactive-text"
        onClick={() => answer('ok')}
      >
        {message.text}
      </button>
      {message.reason && (
        <span className="proactive-why">{message.reason}</span>
      )}
      <div className="proactive-actions">
        {buttons.map(([choice, label]) => (
          <button key={choice} type="button" onClick={() => answer(choice)}>
            {label}
          </button>
        ))}
      </div>
      <span className="tail" />
    </div>
  )
}
/**
 * Above the reopened capsule: where the conversation stands, so hiding the capsule never
 * loses the thread. Continues the current one, or offers the one set aside after a long pause.
 */
function ContextStrip({ session }: { session: Session }) {
  const [error, setError] = useState('')
  if (session.running || session.bubble) return null
  // A failed or stopped turn has no reply worth recalling; show the last real one.
  const reply = session.messages.findLast(
    (m) => m.role === 'assistant' && m.content,
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
          <span>{reply ? bubblePlainText(reply.content, 36) : '…'}</span>
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
/** Lines that went unseen while the user was away; the dot on the pet brings the newest back. */
function useMissed(): ProactiveMessage[] {
  const [missed, setMissed] = useState<ProactiveMessage[]>([])
  useEffect(() => {
    const load = () =>
      void api
        .proactiveStatus()
        .then((s) => setMissed(s.missed))
        .catch(console.error)
    load()
    const off = api.onProactiveChanged((s) => setMissed(s.missed))
    // Own lines go stale after a while even when nothing else changes.
    const timer = setInterval(load, 60000)
    return () => {
      off()
      clearInterval(timer)
    }
  }, [])
  return missed
}
export function Overlay() {
  const session = useSession()
  const missed = useMissed()
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
  // Closing keeps the capsule on screen for its shrink animation.
  const [capsule, setCapsule] = useState<'open' | 'closing' | 'closed'>(
    'closed',
  )
  const open = capsule === 'open'
  useEffect(() => {
    if (capsule !== 'closing') return
    const timer = setTimeout(() => setCapsule('closed'), 180)
    return () => clearTimeout(timer)
  }, [capsule])
  const [name, setName] = useState('小黑')
  const [scale, setScale] = useState<number>(0.73)
  useEffect(() => {
    const off = [
      api.onCapsule((next) =>
        setCapsule((c) => (next ? 'open' : c === 'closed' ? c : 'closing')),
      ),
      api.onSize(setScale),
    ]
    const update = () => {
      void api
        .getSettings()
        .then((s) => {
          setName(s.pet.name)
          setScale(s.pet.scale)
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
      {missed[0] && !session.proactive && !open && !session.running && (
        <button
          type="button"
          data-hit
          className="missed-dot"
          title={
            missed.length > 1
              ? `有 ${missed.length} 句刚才没看到`
              : '有一句刚才没看到'
          }
          aria-label="看看刚才想说的话"
          onClick={() =>
            void api.reopenProactive(missed[0]!.id).catch(console.error)
          }
        />
      )}
      {session.proactive && !open && !session.running && (
        <ProactiveBubble message={session.proactive} />
      )}
      {!session.proactive && session.bubble && session.origin === 'capsule' && (
        <Bubble text={bubblePlainText(session.bubble)} fading={fading} />
      )}
      {capsule !== 'closed' && (
        <div className={`capsule ${open ? '' : 'closing'}`}>
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
