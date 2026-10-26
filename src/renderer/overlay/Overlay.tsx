import { bubblePlainText } from '../chat/content'
import { useEffect, useState, type CSSProperties } from 'react'
import { api } from '../api'
import { Pet } from '../pet/Pet'
import { scales } from '../pet/logic'
import { Composer } from '../shared-ui/Composer'
const bubbleTimeout = (text: string) =>
  12000 + Math.min(8000, [...text].length * 60)
import { useSession } from '../shared-ui/session'
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
          <Composer running={session.running} mini name={name} />
        </div>
      )}
    </div>
  )
}
