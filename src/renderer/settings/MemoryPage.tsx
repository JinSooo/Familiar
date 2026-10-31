import { Fragment, useCallback, useEffect, useState } from 'react'
import type { MemoryItem } from '../../shared'
import { api } from '../api'

const targetLabel = { profile: '画像', habits: '习惯', topic: '主题' } as const
const failure = (e: unknown) =>
  typeof e === 'string' ? e : e instanceof Error ? e.message : '操作失败'
const pad = (n: number) => String(n).padStart(2, '0')
const dayKey = (d: Date) =>
  `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
const isDay = (key: string) => /^\d{4}-\d{2}-\d{2}$/.test(key)
const periodLabel = (key: string) => {
  if (key === dayKey(new Date())) return '今天'
  if (key === dayKey(new Date(Date.now() - 86400000))) return '昨天'
  return key
}
const clock = (at: number) => new Date(at).toTimeString().slice(0, 5)
/** What a timeline line shows: conversation lines start with their time, activity lines carry theirs. */
function view(item: MemoryItem): { time: string; title: string; body: string } {
  if (item.activity)
    return {
      time: clock(item.activity.start),
      title: item.activity.title,
      body: item.text,
    }
  const m = /^(\d{2}:\d{2}) ([\s\S]*)$/.exec(item.text)
  return m
    ? { time: m[1]!, title: '', body: m[2]! }
    : { time: '', title: '', body: item.text }
}

/** The settings window's 记忆 tab: what Familiar believes about the user, editable in place. */
export function MemoryPage() {
  const [items, setItems] = useState<MemoryItem[]>()
  const [notice, setNotice] = useState('')
  const [busy, setBusy] = useState(false)
  const [icons, setIcons] = useState<Record<string, string>>({})
  const [editing, setEditing] = useState<{ id: string; text: string }>()
  /** Timeline lines that still restate a memory the user just deleted. */
  const [leftovers, setLeftovers] = useState<MemoryItem[]>([])
  const load = useCallback(() => {
    api
      .listMemory()
      .then(setItems)
      .catch((e: unknown) => setNotice(failure(e)))
  }, [])
  useEffect(() => {
    load()
    const off = api.onMemoryChanged((change) => {
      load()
      const r = change.reflect
      if (!r) return
      setBusy(false)
      if ('error' in r) setNotice(`整理失败：${r.error}`)
      else if (!r.conversations) setNotice('没有需要整理的新对话。')
      else
        setNotice(
          `整理了 ${r.conversations} 个对话：${r.pending} 条新判断待确认${r.promoted ? `，${r.promoted} 条因反复出现已记下` : ''}${r.timeline ? `，时间线 +${r.timeline}` : ''}${r.failed ? `，${r.failed} 个失败` : ''}。`,
        )
    })
    window.addEventListener('focus', load)
    return () => {
      off()
      window.removeEventListener('focus', load)
    }
  }, [load])
  // Icons for every app the timeline mentions, fetched once each.
  useEffect(() => {
    const missing = [
      ...new Set(
        (items ?? []).flatMap(
          (i) => i.activity?.apps.map((a) => a.bundleId) ?? [],
        ),
      ),
    ].filter((id) => !(id in icons))
    if (!missing.length) return
    void api
      .perceptionIcons(missing)
      .then((found) =>
        setIcons((old) => ({
          ...old,
          // Remember misses too, so they are not asked for again.
          ...Object.fromEntries(missing.map((id) => [id, ''])),
          ...found,
        })),
      )
      .catch(console.error)
  }, [items, icons])
  if (!items) return <p role="status">{notice || '读取记忆…'}</p>
  const act = (work: Promise<unknown>) => {
    setEditing(undefined)
    setLeftovers([])
    work.catch((e: unknown) => setNotice(failure(e)))
  }
  const remove = (item: MemoryItem) => {
    setEditing(undefined)
    api
      .deleteMemory(item.id)
      .then(setLeftovers)
      .catch((e: unknown) => setNotice(failure(e)))
  }
  const live = items.filter((i) => i.status !== 'superseded')
  const pending = live.filter((i) => i.status === 'pending')
  const kept = (category: MemoryItem['category'], key?: string) =>
    live.filter(
      (i) =>
        i.category === category && i.status === 'confirmed' && i.key === key,
    )
  const topics = [
    ...new Set(live.filter((i) => i.category === 'topic').map((i) => i.key!)),
  ]
  const periods = [
    ...new Set(
      live.filter((i) => i.category === 'timeline').map((i) => i.key!),
    ),
  ]
    .sort()
    .reverse()

  const row = (item: MemoryItem, actions: 'kept' | 'pending' | 'timeline') => {
    if (editing?.id === item.id)
      return (
        <li key={item.id} className="memory-item">
          <form
            className="memory-edit"
            onSubmit={(e) => {
              e.preventDefault()
              const text = editing.text.trim()
              if (!text) return
              act(
                actions === 'pending'
                  ? api.confirmMemory(item.id, text)
                  : api.correctMemory(item.id, text),
              )
            }}
          >
            <input
              autoFocus
              maxLength={300}
              value={editing.text}
              aria-label="修改记忆"
              onChange={(e) =>
                setEditing({ id: item.id, text: e.target.value })
              }
              onKeyDown={(e) => {
                if (e.key === 'Escape') {
                  e.stopPropagation()
                  setEditing(undefined)
                }
              }}
            />
            <button type="submit" className="primary">
              {actions === 'pending' ? '改好并记下' : '保存'}
            </button>
            <button type="button" onClick={() => setEditing(undefined)}>
              取消
            </button>
          </form>
        </li>
      )
    return (
      <li key={item.id} className="memory-item">
        <div className="memory-text">
          <span>{item.text}</span>
          {actions === 'pending' ? (
            <span className="muted">
              推测 · 归入{targetLabel[item.target ?? 'profile']}
              {item.targetTopic ? `「${item.targetTopic}」` : ''} · 把握{' '}
              {Math.round((item.confidence ?? 0) * 100)}%
              {item.seen && item.seen > 1
                ? ` · ${item.seen} 个对话里出现过`
                : ''}
              {item.evidence ? ` · 依据「${item.evidence}」` : ''}
            </span>
          ) : (
            item.at && (
              <span className="muted">
                {item.at}
                {item.source === 'reflection' && actions === 'kept'
                  ? ' · 从对话里整理'
                  : ''}
              </span>
            )
          )}
        </div>
        <span className="row-actions">
          {actions === 'pending' && (
            <button
              type="button"
              onClick={() => act(api.confirmMemory(item.id))}
            >
              对
            </button>
          )}
          {item.conversation && (
            <button
              type="button"
              title="打开产生这条记录的对话"
              onClick={() => {
                const id = item.conversation!
                api
                  .openConversation(id)
                  .then(() => api.openMainWindow())
                  .catch((e: unknown) => setNotice(failure(e)))
              }}
            >
              打开对话
            </button>
          )}
          {actions !== 'timeline' && (
            <button
              type="button"
              onClick={() => setEditing({ id: item.id, text: item.text })}
            >
              改
            </button>
          )}
          <button
            type="button"
            title={actions === 'pending' ? '这条判断不对，删掉' : '删除这条'}
            onClick={() => remove(item)}
          >
            {actions === 'pending' ? '不对' : '删除'}
          </button>
        </span>
      </li>
    )
  }
  const group = (
    title: string,
    list: MemoryItem[],
    actions: 'kept' | 'pending' | 'timeline',
    empty?: string,
  ) =>
    (list.length > 0 || empty) && (
      <Fragment key={title}>
        <h3 className="memory-heading">{title}</h3>
        <ul className="group memory-list">
          {list.length ? (
            list.map((i) => row(i, actions))
          ) : (
            <li className="memory-item muted">{empty}</li>
          )}
        </ul>
      </Fragment>
    )

  /** Day lines run newest first; week and month lines keep the order they were written in. */
  const ordered = (key: string, list: MemoryItem[]) =>
    isDay(key)
      ? [...list].sort((a, b) => view(b).time.localeCompare(view(a).time))
      : list
  /** Opens the conversation behind a line (the latest one when several were merged) in the big window. */
  const openOrigin = (ids: string[]) =>
    api
      .openConversation(ids.at(-1)!)
      .then(() => api.openMainWindow())
      .catch((e: unknown) => setNotice(failure(e)))
  const entry = (item: MemoryItem) => {
    const v = view(item)
    const ids =
      item.conversations ?? (item.conversation ? [item.conversation] : [])
    const apps = item.activity?.apps ?? []
    return (
      <li key={item.id}>
        <time>{v.time}</time>
        <div className="ch-entry">
          {v.title && <strong>{v.title}</strong>}
          <p>{v.body}</p>
          {(apps.length > 0 || ids.length > 0) && (
            <span className="ch-apps">
              {apps.map((a) =>
                icons[a.bundleId] ? (
                  <img
                    key={a.bundleId}
                    src={icons[a.bundleId]}
                    alt={a.name}
                    title={a.name}
                  />
                ) : (
                  <span key={a.bundleId} className="ch-app-name">
                    {a.name}
                  </span>
                ),
              )}
              {ids.length > 0 && (
                <button
                  type="button"
                  className="link"
                  title="打开产生这条记录的对话"
                  onClick={() => void openOrigin(ids)}
                >
                  {ids.length > 1
                    ? `打开最近的对话（共 ${ids.length} 个）`
                    : '打开对话'}
                </button>
              )}
            </span>
          )}
        </div>
        <button
          type="button"
          className="icon ch-delete"
          aria-label="删除这条"
          title="删除这条"
          onClick={() => remove(item)}
        >
          <svg
            width="13"
            height="13"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            aria-hidden="true"
          >
            <path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13" />
          </svg>
        </button>
      </li>
    )
  }

  return (
    <div className="memory-page">
      <div className="group">
        <div className="setting-row">
          <span>整理最近的对话和电脑活动</span>
          <button
            type="button"
            aria-disabled={busy}
            onClick={() => {
              if (busy) return
              setBusy(true)
              setNotice('正在整理…')
              api.reflectMemory()
              api.perceptionSummarize()
            }}
          >
            现在整理
          </button>
        </div>
        <div className="setting-row">
          <span>记忆文件</span>
          <button
            type="button"
            className="link"
            onClick={() => api.revealMemory()}
          >
            ~/.familiar/memory
          </button>
        </div>
      </div>
      <p role="status" className="caption">
        {notice ||
          '对话安静 30 分钟或换到别的对话后，会自动整理一次。推测出的判断先放在「它对我的判断」，你点「对」才记下；同一判断在 3 个不同对话里出现，也会自动记下。'}
      </p>
      {leftovers.length > 0 && (
        <div className="group memory-leftovers" role="alert">
          <p>
            时间线里还有 {leftovers.length} 条提到它，不删的话它仍可能想起来：
          </p>
          <ul>
            {leftovers.map((i) => (
              <li key={i.id}>
                {i.key} {i.text}
              </li>
            ))}
          </ul>
          <span className="row-actions">
            <button
              type="button"
              onClick={() =>
                // One at a time: each delete commits a workspace snapshot.
                act(
                  leftovers.reduce<Promise<unknown>>(
                    (done, i) => done.then(() => api.deleteMemory(i.id)),
                    Promise.resolve(),
                  ),
                )
              }
            >
              一并删除
            </button>
            <button type="button" onClick={() => setLeftovers([])}>
              保留
            </button>
          </span>
        </div>
      )}
      {group('它对我的判断', pending, 'pending', '暂时没有待确认的判断。')}
      {group('画像', kept('profile'), 'kept', '还没有。可以对它说「记住……」。')}
      {group('习惯', kept('habits'), 'kept')}
      {topics.map((t) => group(`主题：${t}`, kept('topic', t), 'kept'))}
      {periods.length > 0 && <h3 className="memory-heading">时间线</h3>}
      {periods.length > 0 && (
        <div className="group">
          {periods.map((p) => (
            <details
              key={p}
              className="rules memory-period"
              open={p === periods[0]}
            >
              <summary>
                {periodLabel(p)}
                <span className="muted">{kept('timeline', p).length} 条</span>
              </summary>
              <div className="ch-history">
                <ol>{ordered(p, kept('timeline', p)).map(entry)}</ol>
              </div>
            </details>
          ))}
        </div>
      )}
    </div>
  )
}
