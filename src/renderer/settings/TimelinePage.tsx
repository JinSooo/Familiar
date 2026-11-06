import { useCallback, useEffect, useState } from 'react'
import type { MemoryItem } from '../../shared'
import { api } from '../api'

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

/** Settings › 感知 › 时间线: what happened each day, from activity and conversations. */
export function TimelinePage() {
  const [items, setItems] = useState<MemoryItem[]>()
  const [notice, setNotice] = useState('')
  const [busy, setBusy] = useState(false)
  const [icons, setIcons] = useState<Record<string, string>>({})
  const load = useCallback(() => {
    api
      .listMemory()
      .then((all) =>
        setItems(
          all.filter(
            (i) => i.category === 'timeline' && i.status === 'confirmed',
          ),
        ),
      )
      .catch((e: unknown) => setNotice(failure(e)))
  }, [])
  useEffect(() => {
    load()
    const off = api.onMemoryChanged((change) => {
      load()
      const r = change.reflect
      if (!r) return
      setBusy(false)
      setNotice('error' in r ? `没整理成：${r.error}` : '')
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
  if (!items) return <p role="status">{notice || '正在读取…'}</p>

  const periods = [...new Set(items.map((i) => i.key!))].sort().reverse()
  const of = (key: string) => {
    const list = items.filter((i) => i.key === key)
    // Day lines run newest first; week and month lines keep the order they were written in.
    return isDay(key)
      ? list.sort((a, b) => view(b).time.localeCompare(view(a).time))
      : list
  }
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
                  title={
                    ids.length > 1
                      ? `合并自 ${ids.length} 个对话，打开最近的一个`
                      : undefined
                  }
                  onClick={() => void openOrigin(ids)}
                >
                  打开对话
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
          onClick={() =>
            void api
              .deleteMemory(item.id)
              .catch((e: unknown) => setNotice(failure(e)))
          }
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
    <>
      <div className="page-actions">
        {notice && (
          <span role="status" className="muted">
            {notice}
          </span>
        )}
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
      {periods.length ? (
        periods.map((p) => (
          <section key={p} className="timeline-day">
            <h3 className="memory-heading">{periodLabel(p)}</h3>
            <div className="ch-history">
              <ol>{of(p).map(entry)}</ol>
            </div>
          </section>
        ))
      ) : (
        <p className="empty-note muted">还没有整理出的活动</p>
      )}
    </>
  )
}
