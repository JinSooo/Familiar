import { useEffect, useRef, useState } from 'react'
import { Icon } from './Icon'
import { api } from '../api'
export function Composer({
  running,
  mini = false,
  name = '小黑',
}: {
  running: boolean
  mini?: boolean
  name?: string
}) {
  const [input, setInput] = useState('')
  const [error, setError] = useState('')
  const field = useRef<HTMLInputElement>(null)
  const busy = useRef(false)
  useEffect(() => {
    field.current?.focus()
    return () => api.typing(false)
  }, [])
  return (
    <div className="composer-wrap" data-hit>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      <form
        className={`composer ${mini ? 'mini' : ''}`}
        onSubmit={async (e) => {
          e.preventDefault()
          if (!input.trim() || running || busy.current) return
          const text = input.trim()
          setInput('')
          setError('')
          busy.current = true
          api.typing(false)
          try {
            await api.run(text)
          } catch (err) {
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
        <input
          ref={field}
          aria-label="消息"
          placeholder={`问${name}…`}
          value={input}
          onChange={(e) => {
            setInput(e.target.value)
            api.typing(Boolean(e.target.value))
          }}
          onKeyDown={(e) => {
            if (e.nativeEvent.isComposing && e.key === 'Enter')
              e.preventDefault()
            if (e.key === 'Escape' && mini) api.capsule(false)
          }}
        />
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
