import { Markdown, PlainText } from './Markdown'
import { ImageViewer, SourceCards } from './Visual'
import { needsTimeDivider, formatMessageTime } from './content'
import { Fragment, useEffect, useRef, useState } from 'react'
import { Icon } from '../shared-ui/Icon'
import type { ChatView, PetState, Session } from '../../shared'
import { History, errorText } from './History'
import { api } from '../api'
import { Pet } from '../pet/Pet'
import { PetAvatar } from '../pet/PetAvatar'
import { Composer } from '../shared-ui/Composer'
import { useSession } from '../shared-ui/session'
import { useTurnStatus } from '../shared-ui/status'
/** `panel`: the small floating panel by the pet. `window`: the big resizable window with history beside it. */
export function Chat({ variant = 'panel' }: { variant?: 'panel' | 'window' }) {
  const big = variant === 'window'
  const session = useSession()
  const [state, setState] = useState<PetState>('idle')
  useEffect(() => api.onState(setState), [])
  const [view, setView] = useState<ChatView>('chat')
  const [openError, setOpenError] = useState('')
  useEffect(() => api.onView(setView), [])
  // Esc steps out: history → chat, then the whole panel and capsule close at once.
  useEffect(() => {
    const escape = (e: KeyboardEvent) => {
      if (big || e.key !== 'Escape' || e.isComposing) return
      if (view === 'history') setView('chat')
      else api.dismissChat()
    }
    window.addEventListener('keydown', escape)
    return () => window.removeEventListener('keydown', escape)
  }, [view, big])
  const [name, setName] = useState('小黑')
  const [mode, setMode] = useState('自动')
  const bottom = useRef<HTMLDivElement>(null)
  const list = useRef<HTMLElement>(null)
  // Follow new output only while the reader is already near the bottom.
  const pinned = useRef(true)
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
  const status = useTurnStatus(session, name)
  const last = session.messages.at(-1)
  const contentKey = `${session.messages.length}:${last?.content.length ?? 0}:${session.approvals.length}:${session.tools.length}`
  useEffect(() => {
    if (pinned.current) bottom.current?.scrollIntoView()
  }, [contentKey])
  // A message the user just sent always scrolls into view.
  useEffect(() => {
    if (last?.role === 'user' || (session.running && !last?.content)) {
      pinned.current = true
      bottom.current?.scrollIntoView()
    }
  }, [session.messages.length])
  const surface = (
    <main className="chat-shell">
      <ImageViewer />
      {session.running && state === 'thinking' && (
        <div className="perched">
          <Pet embedded scale={0.38} forceState="thinking" />
        </div>
      )}
      <div className="chat-surface">
        <header className="chat-header" data-tauri-drag-region="deep">
          <PetAvatar />
          <strong>{name}</strong>
          <small className="muted">{mode}</small>
          <div className="header-actions">
            {!big && (
              <button
                className={`icon ${view === 'history' ? 'active' : ''}`}
                aria-label="历史对话"
                aria-pressed={view === 'history'}
                onClick={() => setView(view === 'history' ? 'chat' : 'history')}
              >
                <Icon name="history" />
              </button>
            )}
            {!big && (
              <button
                className="icon"
                aria-label="新对话"
                onClick={() => {
                  api.newSession()
                  setView('chat')
                }}
              >
                <Icon name="new" />
              </button>
            )}
            {!big && (
              <button
                className="icon"
                aria-label="在大窗口打开"
                title="在大窗口打开"
                onClick={() => api.openMainWindow()}
              >
                <Icon name="window" />
              </button>
            )}
            <button
              className="icon"
              aria-label="设置"
              onClick={() => api.openSettings()}
            >
              <Icon name="settings" />
            </button>
            {!big && (
              <button
                className="icon"
                aria-label="收起成胶囊"
                onClick={() => api.toggleChat()}
              >
                <Icon name="collapse" />
              </button>
            )}
          </div>
        </header>
        {view === 'history' && !big ? (
          <History currentId={session.id} onOpened={() => setView('chat')} />
        ) : (
          <>
            <section
              className="messages"
              aria-label="聊天消息"
              aria-live="polite"
              ref={list}
              onScroll={(e) => {
                const el = e.currentTarget
                pinned.current =
                  el.scrollHeight - el.scrollTop - el.clientHeight < 48
              }}
            >
              {!session.messages.length && (
                <div className="empty muted">
                  <p>和{name}说句话…</p>
                  {session.previous && (
                    <button
                      className="link"
                      onClick={() => {
                        if (!session.previous) return
                        setOpenError('')
                        api
                          .openConversation(session.previous.id)
                          .catch((e) =>
                            setOpenError(errorText(e, '打不开上次的对话')),
                          )
                      }}
                    >
                      继续上次：{session.previous.title}
                    </button>
                  )}
                  {openError && <p className="error">{openError}</p>}
                </div>
              )}
              {session.messages.map((m, i) => (
                <Fragment key={i}>
                  {m.content &&
                    needsTimeDivider(
                      session.messages[i - 1]?.createdAt,
                      m.createdAt,
                    ) && (
                      <div className="time-divider">
                        {formatMessageTime(m.createdAt, Date.now())}
                      </div>
                    )}
                  <ToolSteps
                    tools={session.tools.filter((t) => t.turn === i)}
                  />
                  {m.content && (
                    <article
                      className={`message ${m.role}`}
                      title={new Date(m.createdAt).toLocaleString('zh-CN', {
                        hour12: false,
                      })}
                    >
                      {m.role === 'assistant' ? (
                        <Markdown content={m.content} />
                      ) : (
                        <PlainText content={m.content} />
                      )}
                    </article>
                  )}
                  {m.role === 'assistant' && m.sources?.length ? (
                    <SourceCards sources={m.sources} />
                  ) : null}
                  {m.error && (
                    <p className="error" role="alert">
                      {m.error}
                    </p>
                  )}
                </Fragment>
              ))}
              {session.approvals.map((a) => (
                <article className="approval" key={a.id}>
                  <strong>需要你的允许</strong>
                  <p>{a.reason}</p>
                  <ApprovalDetail toolName={a.toolName} input={a.input} />
                  <div className="approval-actions">
                    <button
                      className="primary"
                      onClick={() => api.approve(a.id, 'approve')}
                    >
                      允许
                    </button>
                    <button onClick={() => api.approve(a.id, 'deny')}>
                      拒绝
                    </button>
                  </div>
                  {a.dir && (
                    <button
                      className="link"
                      title={a.dir}
                      onClick={() => api.approve(a.id, 'always')}
                    >
                      总是允许{' '}
                      {a.dir.split('/').filter(Boolean).at(-1) ?? a.dir} 目录
                    </button>
                  )}
                </article>
              ))}
              {session.running && <p className="muted status">{status}</p>}
              <div ref={bottom} />
            </section>
            <Composer running={session.running} name={name} />
          </>
        )}
      </div>
    </main>
  )
  if (!big) return surface
  return (
    <div className="big-window">
      <aside className="chat-sidebar">
        <div className="sidebar-titlebar" data-tauri-drag-region="deep" />
        <button
          className="sidebar-new"
          onClick={() => {
            api.newSession()
            setView('chat')
          }}
        >
          <Icon name="new" />
          新对话
        </button>
        <History
          compact
          currentId={session.id}
          onOpened={() => setView('chat')}
        />
      </aside>
      {surface}
    </div>
  )
}

const actions: Record<string, string> = {
  write_file: '写入文件',
  edit_file: '修改文件',
  read_file: '读取文件',
  list_dir: '查看目录',
  make_dir: '新建目录',
  delete_path: '移到废纸篓',
  run_shell: '执行命令',
  web_search: '联网搜索',
  fetch_page: '读取网页',
}
/** What an approval would do, in words plus the one detail that matters (path, command, URL). */
function ApprovalDetail({
  toolName,
  input,
}: {
  toolName: string
  input: unknown
}) {
  const field = (key: string) =>
    input && typeof input === 'object' && key in input
      ? String((input as Record<string, unknown>)[key] ?? '')
      : ''
  const detail =
    field('command') || field('path') || field('url') || field('query')
  const extra = [
    field('cwd') && `目录：${field('cwd')}`,
    toolName === 'run_shell' && field('network') === 'true' && '需要联网',
  ].filter(Boolean)
  return (
    <div className="approval-detail">
      <span className="muted">{actions[toolName] ?? '使用工具'}</span>
      {detail && <code>{detail}</code>}
      {extra.length > 0 && <span className="muted">{extra.join(' · ')}</span>}
    </div>
  )
}

/** One line per tool step; more than three fold into a summary like 「搜索 4 次 · 读网页 9 次」. */
function ToolSteps({ tools }: { tools: Session['tools'] }) {
  const row = (t: Session['tools'][number]) => (
    <p className="tool muted" key={t.id}>
      {t.done ? '✓ 已' : '正在'}
      {t.name}
    </p>
  )
  if (tools.length <= 3) return <>{tools.map(row)}</>
  const running = tools.filter((t) => !t.done)
  const counts = new Map<string, number>()
  for (const t of tools) {
    const verb = t.name.split(' ')[0] ?? t.name
    counts.set(verb, (counts.get(verb) ?? 0) + 1)
  }
  const summary = [...counts]
    .map(([verb, n]) => (n > 1 ? `${verb} ${n} 次` : verb))
    .join(' · ')
  return (
    <>
      <details className="tool tool-group muted">
        <summary>
          {running.length ? '' : '✓ '}
          {summary}
        </summary>
        {tools.filter((t) => t.done).map(row)}
      </details>
      {running.map(row)}
    </>
  )
}
