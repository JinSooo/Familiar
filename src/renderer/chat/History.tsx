import { useEffect, useState } from 'react'
import type { ConversationSummary } from '../../shared'
import { api } from '../api'

const day = 24 * 60 * 60 * 1000
function group(at: number, now: number): string {
  const today = new Date(now).setHours(0, 0, 0, 0)
  if (at >= today) return '今天'
  if (at >= today - day) return '昨天'
  if (at >= today - 6 * day) return '最近 7 天'
  return '更早'
}
function when(at: number, now: number): string {
  const today = new Date(now).setHours(0, 0, 0, 0)
  return new Date(at).toLocaleString(
    'zh-CN',
    at >= today
      ? { hour: '2-digit', minute: '2-digit', hour12: false }
      : { month: 'numeric', day: 'numeric' },
  )
}
export const errorText = (error: unknown, fallback: string): string =>
  typeof error === 'string'
    ? error
    : error instanceof Error
      ? error.message
      : fallback

/** `compact`: the big window's sidebar — one line per conversation, the current one highlighted. */
export function History({
  currentId,
  onOpened,
  compact = false,
  running = false,
}: {
  currentId: string
  onOpened: () => void
  compact?: boolean
  /** Read again when a turn ends: an edited first message changes the title, a reply the preview. */
  running?: boolean
}) {
  const [query, setQuery] = useState('')
  const [items, setItems] = useState<ConversationSummary[]>()
  const [confirming, setConfirming] = useState('')
  const [error, setError] = useState('')
  const [version, setVersion] = useState(0)
  useEffect(() => {
    let stale = false
    const timer = setTimeout(() => {
      api
        .listConversations(query)
        .then((list) => {
          if (!stale) setItems(list)
        })
        .catch(() => setError('读不到对话记录'))
    }, 150)
    return () => {
      stale = true
      clearTimeout(timer)
    }
  }, [query, version, currentId, running])
  const now = Date.now()
  let lastGroup = ''
  return (
    <section
      className={`history ${compact ? 'compact' : ''}`}
      aria-label="历史对话"
    >
      <input
        className="history-search"
        type="search"
        placeholder="搜索对话…"
        value={query}
        autoFocus={!compact}
        onChange={(e) => setQuery(e.target.value)}
      />
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      <ul>
        {items?.map((item) => {
          const heading = group(item.updatedAt, now)
          const showHeading = heading !== lastGroup
          lastGroup = heading
          return (
            <li key={item.id}>
              {showHeading && <h4>{heading}</h4>}
              {confirming === item.id ? (
                <div className="history-item confirming">
                  <span>
                    {compact
                      ? '移到废纸篓？'
                      : `把「${item.title}」移到废纸篓？`}
                  </span>
                  <button
                    className="danger"
                    onClick={() => {
                      setConfirming('')
                      api
                        .deleteConversation(item.id)
                        .then(() => setVersion((v) => v + 1))
                        .catch((e) => setError(errorText(e, '删除失败')))
                    }}
                  >
                    删除
                  </button>
                  <button onClick={() => setConfirming('')}>取消</button>
                </div>
              ) : (
                <div
                  className={`history-item ${item.id === currentId ? 'is-current' : ''}`}
                >
                  <button
                    className="history-open"
                    onClick={() => {
                      if (item.id === currentId) return onOpened()
                      api
                        .openConversation(item.id)
                        .then(onOpened)
                        .catch((e) => setError(errorText(e, '打不开这个对话')))
                    }}
                  >
                    <span className="history-title">
                      {item.title}
                      {!compact && item.id === currentId && (
                        <small className="current">当前</small>
                      )}
                    </span>
                    {!compact && (
                      <span className="muted history-preview">
                        {item.preview || '（没有回复）'}
                      </span>
                    )}
                  </button>
                  {!compact && (
                    <time className="muted">{when(item.updatedAt, now)}</time>
                  )}
                  <button
                    className="icon history-delete"
                    aria-label={`删除 ${item.title}`}
                    onClick={() => setConfirming(item.id)}
                  >
                    ×
                  </button>
                </div>
              )}
            </li>
          )
        })}
      </ul>
      {items && !items.length && (
        <p className="empty muted">
          {query ? '没有找到相关对话' : '还没有对话记录'}
        </p>
      )}
      {/* The big window's sidebar stays a list of conversations; the folder is on the 隐私 page. */}
      {!compact && (
        <button className="link" onClick={() => api.revealConversations()}>
          在 Finder 中打开对话文件夹
        </button>
      )}
    </section>
  )
}
