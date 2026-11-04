import { Markdown, PlainText } from './Markdown'
import { ImageViewer, SourceCards } from './Visual'
import { needsTimeDivider, formatMessageTime, replyParts } from './content'
import { useEffect, useRef, useState } from 'react'
import { Icon } from '../shared-ui/Icon'
import type { ChatView, PetState, Session, Settings } from '../../shared'
import { History, errorText } from './History'
import { api } from '../api'
import { Pet } from '../pet/Pet'
import { PetAvatar } from '../pet/PetAvatar'
import { Composer } from '../shared-ui/Composer'
import { Attachments } from './Attachments'
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
  /** The user message being edited, by index. */
  const [editing, setEditing] = useState<number>()
  const [actionError, setActionError] = useState('')
  const act = (work: Promise<unknown>, fallback: string) => {
    setActionError('')
    work.catch((e) => setActionError(errorText(e, fallback)))
  }
  /** The user message a reply answers: the nearest one before it. */
  const askedBefore = (i: number) =>
    session.messages.findLastIndex((m, k) => k < i && m.role === 'user')
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
  const [toolView, setToolView] = useState<ToolView>('brief')
  const bottom = useRef<HTMLDivElement>(null)
  const list = useRef<HTMLElement>(null)
  // Follow new output only while the reader is already near the bottom.
  const pinned = useRef(true)
  useEffect(() => {
    const update = () => {
      void api.getSettings().then((s) => {
        setName(s.pet.name)
        setToolView(s.toolView)
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
          <History
            currentId={session.id}
            running={session.running}
            onOpened={() => setView('chat')}
          />
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
                      className="resume"
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
                      <span className="muted">继续上次</span>
                      <span className="resume-title">
                        {session.previous.title}
                      </span>
                    </button>
                  )}
                  {openError && <p className="error">{openError}</p>}
                </div>
              )}
              {session.messages.map((m, i) => (
                <div className="turn" key={i}>
                  {m.content &&
                    needsTimeDivider(
                      session.messages[i - 1]?.createdAt,
                      m.createdAt,
                    ) && (
                      <div className="time-divider">
                        {formatMessageTime(m.createdAt, Date.now())}
                      </div>
                    )}
                  {m.role === 'assistant' ? (
                    <Reply
                      message={m}
                      tools={session.tools.filter((t) => t.turn === i)}
                      view={toolView}
                    />
                  ) : editing === i ? (
                    <EditMessage
                      text={m.content}
                      onCancel={() => setEditing(undefined)}
                      onSend={(text) => {
                        setEditing(undefined)
                        act(api.resend(i, text), '重新发送失败')
                      }}
                    />
                  ) : (
                    <>
                      {m.content && (
                        <article
                          className="message user"
                          title={stamp(m.createdAt)}
                        >
                          <PlainText content={m.content} />
                        </article>
                      )}
                      {m.attachments?.length ? (
                        <Attachments items={m.attachments} align="end" />
                      ) : null}
                    </>
                  )}
                  {m.error && (
                    <div className="error-row">
                      <p className="error" role="alert">
                        {m.error}
                      </p>
                      {!session.running && askedBefore(i) >= 0 && (
                        <button
                          type="button"
                          onClick={() =>
                            act(api.resend(askedBefore(i)), '重试失败')
                          }
                        >
                          重试
                        </button>
                      )}
                    </div>
                  )}
                  {!session.running &&
                    editing !== i &&
                    (m.content || m.attachments?.length) && (
                      <MessageActions
                        align={m.role === 'user' ? 'end' : 'start'}
                        text={m.content}
                        onEdit={
                          m.role === 'user' ? () => setEditing(i) : undefined
                        }
                        onRegenerate={
                          m.role === 'assistant' && askedBefore(i) >= 0
                            ? () =>
                                act(api.resend(askedBefore(i)), '重新生成失败')
                            : // A message left without a reply (branched off there) can be answered.
                              m.role === 'user' &&
                                i === session.messages.length - 1
                              ? () => act(api.resend(i), '回复失败')
                              : undefined
                        }
                        onBranch={() => act(api.branch(i), '分支失败')}
                      />
                    )}
                </div>
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
                    {(a.dir || a.server) && (
                      <button
                        title={
                          a.dir
                            ? `之后 ${a.dir} 里的请求都不再询问，可在设置「权限 › 目录规则」里删除`
                            : `之后 ${a.server} 的工具都不再询问，可在设置「扩展」里改回`
                        }
                        onClick={() => api.approve(a.id, 'always')}
                      >
                        全部允许
                      </button>
                    )}
                    <button onClick={() => api.approve(a.id, 'deny')}>
                      拒绝
                    </button>
                  </div>
                </article>
              ))}
              {actionError && (
                <p className="error" role="alert">
                  {actionError}
                </p>
              )}
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
          running={session.running}
          onOpened={() => setView('chat')}
        />
      </aside>
      {surface}
    </div>
  )
}

const glyphs = {
  copy: 'M9 9h11v11H9zM5 15H4V4h11v1',
  check: 'M5 12l5 5L20 7',
  edit: 'M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z',
  regenerate: 'M20 11a8 8 0 1 0-2.3 5.7M20 4v7h-7',
  branch:
    'M6 3v12M18 9a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM6 21a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM18 9a9 9 0 0 1-9 9',
}
function Glyph({ d }: { d: string }) {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d={d} />
    </svg>
  )
}

/** Copy, edit, regenerate and branch for one message; shown while the pointer is over it. */
export function MessageActions({
  align,
  text,
  onEdit,
  onRegenerate,
  onBranch,
}: {
  align: 'start' | 'end'
  text: string
  onEdit?: () => void
  onRegenerate?: () => void
  onBranch?: () => void
}) {
  const [copied, setCopied] = useState(false)
  useEffect(() => {
    if (!copied) return
    const timer = setTimeout(() => setCopied(false), 1500)
    return () => clearTimeout(timer)
  }, [copied])
  const button = (label: string, d: string, onClick: () => void) => (
    <button
      type="button"
      className="icon"
      data-tip={label}
      aria-label={label}
      onClick={onClick}
    >
      <Glyph d={d} />
    </button>
  )
  return (
    <div className={`message-actions ${align}`}>
      {text &&
        button(
          copied ? '已复制' : '复制',
          copied ? glyphs.check : glyphs.copy,
          () =>
            void navigator.clipboard
              .writeText(text)
              .then(() => setCopied(true))
              .catch(console.error),
        )}
      {onEdit && button('编辑后重新发送', glyphs.edit, onEdit)}
      {onRegenerate && button('重新生成', glyphs.regenerate, onRegenerate)}
      {onBranch && button('从这里分支成新对话', glyphs.branch, onBranch)}
    </div>
  )
}

/** A user message opened for editing; sending drops what came after it and runs again. */
function EditMessage({
  text,
  onSend,
  onCancel,
}: {
  text: string
  onSend: (text: string) => void
  onCancel: () => void
}) {
  const [value, setValue] = useState(text)
  const send = () => value.trim() && onSend(value.trim())
  return (
    <div className="message-edit">
      <textarea
        autoFocus
        value={value}
        rows={Math.min(8, value.split('\n').length + 1)}
        aria-label="修改消息"
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            e.stopPropagation()
            onCancel()
          }
          if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
            e.preventDefault()
            send()
          }
        }}
      />
      <div className="message-edit-actions">
        <span className="muted">之后的内容会被替换</span>
        <button type="button" onClick={onCancel}>
          取消
        </button>
        <button
          type="button"
          className="primary"
          disabled={!value.trim()}
          onClick={send}
        >
          发送
        </button>
      </div>
    </div>
  )
}

export const stamp = (at: number) =>
  new Date(at).toLocaleString('zh-CN', { hour12: false })

/** A reply in the order it happened: text, tool steps, source cards and made files interleaved. */
export type ToolView = Settings['toolView']
export function Reply({
  message,
  tools,
  view = 'brief',
}: {
  message: Session['messages'][number]
  tools: Session['tools']
  /** How tool steps show: one line each, opened, or not at all (settings 对话过程). */
  view?: ToolView
}) {
  const parts = replyParts(
    message.content,
    tools,
    message.sources ?? [],
    message.attachments ?? [],
  )
  return parts.map((part, k) =>
    part.kind === 'text' ? (
      <article
        key={k}
        className="message assistant"
        title={stamp(message.createdAt)}
      >
        <Markdown content={part.text} />
      </article>
    ) : part.kind === 'tools' ? (
      <ToolSteps key={k} tools={part.tools} view={view} />
    ) : part.kind === 'sources' ? (
      <SourceCards key={k} sources={part.sources} />
    ) : (
      <Attachments key={k} items={part.files} />
    ),
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
/** One line per step; a step with its command or result opens to show them in full. */
function ToolSteps({
  tools,
  view,
}: {
  tools: Session['tools']
  view: ToolView
}) {
  if (view === 'hidden') return null
  const row = (t: Session['tools'][number]) => {
    const label = (
      <>
        {t.done ? '✓ 已' : '正在'}
        {t.name}
      </>
    )
    if (!t.detail && !t.output)
      return (
        <p className="tool muted" key={t.id}>
          {label}
        </p>
      )
    return (
      <details
        className="tool tool-step muted"
        key={t.id}
        open={view === 'full'}
      >
        <summary>{label}</summary>
        {t.detail && <pre className="tool-io">{t.detail}</pre>}
        {t.output && <pre className="tool-io output">{t.output}</pre>}
      </details>
    )
  }
  if (view === 'full' || tools.length <= 3) return <>{tools.map(row)}</>
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
