import { useEffect, useRef, useState } from 'react'
import { Icon } from '../shared-ui/Icon'
import type { PetState } from '../../shared'
import { api } from '../api'
import { Pet } from '../pet/Pet'
import { Composer } from '../shared-ui/Composer'
import { useSession } from '../shared-ui/session'
export function Chat() {
  const session = useSession()
  const [state, setState] = useState<PetState>('idle')
  useEffect(() => api.onState(setState), [])
  const [name, setName] = useState('小黑')
  const [mode, setMode] = useState('自动')
  const bottom = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const update = () => {
      void api.getSettings().then((s) => {
        setName(s.pet.name)
        setMode(
          { ask: '询问', auto: '自动', full: '完全访问' }[s.permissionMode],
        )
      })
    }
    update()
    window.addEventListener('focus', update)
    return () => window.removeEventListener('focus', update)
  }, [])
  useEffect(() => {
    bottom.current?.scrollIntoView()
  }, [session])
  return (
    <main className="chat-shell">
      {session.running && state === 'thinking' && (
        <div className="perched">
          <Pet embedded scale={0.38} forceState="thinking" />
        </div>
      )}
      <div className="chat-surface">
        <header className="chat-header">
          <Pet embedded scale={0.12} />
          <strong>{name}</strong>
          <small className="muted">{mode}</small>
          <div className="header-actions">
            <button
              className="icon"
              aria-label="新对话"
              onClick={() => api.newSession()}
            >
              <Icon name="new" />
            </button>
            <button
              className="icon"
              aria-label="设置"
              onClick={() => api.openSettings()}
            >
              <Icon name="settings" />
            </button>
            <button
              className="icon"
              aria-label="收起成胶囊"
              onClick={() => api.toggleChat()}
            >
              <Icon name="collapse" />
            </button>
          </div>
        </header>
        <section className="messages" aria-label="聊天消息" aria-live="polite">
          {!session.messages.length && (
            <p className="empty muted">和{name}说句话…</p>
          )}
          {session.messages.map(
            (m, i) =>
              m.content && (
                <article className={`message ${m.role}`} key={i}>
                  {m.content}
                </article>
              ),
          )}
          {session.tools.map((t) => (
            <details className="tool muted" key={t.id}>
              <summary>
                {t.done ? '✓ 已' : '正在'}
                {t.name}
              </summary>
              <p>调用编号：{t.id}</p>
            </details>
          ))}
          {session.approvals.map((a) => (
            <article className="approval" key={a.id}>
              <strong>需要你的允许</strong>
              <p>{a.reason}</p>
              <details>
                <summary>{a.toolName}</summary>
                <pre>{JSON.stringify(a.input, null, 2)}</pre>
              </details>
              <div className="approval-actions">
                <button
                  className="primary"
                  onClick={() => api.approve(a.id, 'approve')}
                >
                  允许
                </button>
                <button onClick={() => api.approve(a.id, 'deny')}>拒绝</button>
              </div>
              <button className="link" onClick={() => {}}>
                总是允许这个目录
              </button>
            </article>
          ))}
          {session.running && (
            <p className="muted status">
              {session.approvals.length ? '等你允许…' : `${name}正在思考…`}
            </p>
          )}
          {session.error && (
            <p className="error" role="alert">
              {session.error}
            </p>
          )}
          <div ref={bottom} />
        </section>
        <Composer running={session.running} name={name} />
      </div>
    </main>
  )
}
