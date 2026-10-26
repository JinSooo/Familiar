import { useEffect, useRef, useState } from 'react'
import { Icon } from './Icon'
import { api } from '../api'
export function Composer({
  running,
  mini = false,
  name = '小黑',
  status = '',
  failed = '',
}: {
  running: boolean
  mini?: boolean
  name?: string
  /** Mini only: what the pet is doing, shown in place of the field while running. */
  status?: string
  /** Mini only: the last turn's error; the failed message comes back for a resend. */
  failed?: string
}) {
  const [input, setInput] = useState('')
  const [error, setError] = useState('')
  const field = useRef<HTMLInputElement>(null)
  const busy = useRef(false)
  const lastSent = useRef('')
  const [asked, setAsked] = useState(false)
  // The capsule cannot take a second message mid-turn, so it shows progress instead of an idle field.
  const working = mini && running
  useEffect(() => {
    return () => api.typing(false)
  }, [])
  useEffect(() => {
    if (!working) field.current?.focus()
  }, [working])
  useEffect(() => {
    if (mini && failed && lastSent.current) {
      setInput((current) => current || lastSent.current)
      lastSent.current = ''
    }
  }, [mini, failed])
  return (
    <div className="composer-wrap" data-hit>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      <form
        className={`composer ${mini ? 'mini' : ''} ${working ? 'working' : ''}`}
        onKeyDown={(e) => {
          if (e.key === 'Escape' && mini) api.capsule(false)
        }}
        onSubmit={async (e) => {
          e.preventDefault()
          if (!input.trim() || running || busy.current) return
          const text = input.trim()
          setInput('')
          setError('')
          busy.current = true
          lastSent.current = text
          setAsked(true)
          api.typing(false)
          try {
            await api.run(text)
          } catch (err) {
            setInput(text)
            lastSent.current = ''
            setError(err instanceof Error ? err.message : '对话启动失败')
          } finally {
            busy.current = false
          }
        }}
      >
        {mini && (
          <button
            type="button"
            className="icon"
            aria-label="展开聊天"
            onClick={() => api.toggleChat()}
          >
            <Icon name="expand" />
          </button>
        )}
        {working ? (
          <button
            type="button"
            className="capsule-status"
            role="status"
            title="展开聊天查看过程"
            onClick={() => api.toggleChat()}
          >
            <span className="dots" aria-hidden="true">
              <i />
              <i />
              <i />
            </span>
            <span>{status || `${name}在想…`}</span>
          </button>
        ) : (
          <input
            ref={field}
            aria-label="消息"
            placeholder={mini && asked ? `继续问${name}…` : `问${name}…`}
            value={input}
            onChange={(e) => {
              setInput(e.target.value)
              api.typing(Boolean(e.target.value))
            }}
            onKeyDown={(e) => {
              if (e.nativeEvent.isComposing && e.key === 'Enter')
                e.preventDefault()
            }}
          />
        )}
        {running ? (
          <button
            type="button"
            className="send stop"
            aria-label="停止"
            onClick={() => api.stop()}
          >
            ■
          </button>
        ) : (
          <button
            className="send primary"
            aria-label="发送"
            disabled={!input.trim()}
          >
            ↑
          </button>
        )}
      </form>
    </div>
  )
}
