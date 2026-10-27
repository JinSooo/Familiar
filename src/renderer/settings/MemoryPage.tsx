import { Fragment, useCallback, useEffect, useState } from 'react'
import type { MemoryItem } from '../../shared'
import { api } from '../api'

const targetLabel = { profile: '画像', habits: '习惯', topic: '主题' } as const
const failure = (e: unknown) =>
  typeof e === 'string' ? e : e instanceof Error ? e.message : '操作失败'

/** The settings window's 记忆 tab: what Familiar believes about the user, editable in place. */
export function MemoryPage() {
  const [items, setItems] = useState<MemoryItem[]>()
  const [notice, setNotice] = useState('')
  const [busy, setBusy] = useState(false)
  const [editing, setEditing] = useState<{ id: string; text: string }>()
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
  if (!items) return <p role="status">{notice || '读取记忆…'}</p>
  const act = (work: Promise<void>) => {
    setEditing(undefined)
    work.catch((e: unknown) => setNotice(failure(e)))
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
            onClick={() => act(api.deleteMemory(item.id))}
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

  return (
    <div className="memory-page">
      <div className="group">
        <div className="setting-row">
          <span>从最近的对话里整理</span>
          <button
            type="button"
            aria-disabled={busy}
            onClick={() => {
              if (busy) return
              setBusy(true)
              setNotice('正在整理…')
              api.reflectMemory()
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
            ~/Familiar/memory
          </button>
        </div>
      </div>
      <p role="status" className="caption">
        {notice ||
          '对话安静 30 分钟或换到别的对话后，会自动整理一次。推测出的判断先放在「它对我的判断」，你点「对」才记下；同一判断在 3 个不同对话里出现，也会自动记下。'}
      </p>
      {group('它对我的判断', pending, 'pending', '暂时没有待确认的判断。')}
      {group('画像', kept('profile'), 'kept', '还没有。可以对它说「记住……」。')}
      {group('习惯', kept('habits'), 'kept')}
      {topics.map((t) => group(`主题：${t}`, kept('topic', t), 'kept'))}
      {periods.length > 0 && <h3 className="memory-heading">时间线</h3>}
      {periods.map((p) => (
        <details key={p} className="group rules memory-period">
          <summary>
            {p}
            <span className="muted">{kept('timeline', p).length} 条</span>
          </summary>
          <ul className="memory-list">
            {kept('timeline', p).map((i) => row(i, 'timeline'))}
          </ul>
        </details>
      ))}
    </div>
  )
}
