import { Fragment, useCallback, useEffect, useState } from 'react'
import type { MemoryItem } from '../../shared'
import { api } from '../api'
import { inputKey } from '../shared-ui/input'

const targetLabel = {
  profile: '画像',
  habits: '习惯',
  lessons: '经验',
  topic: '主题',
} as const
const failure = (e: unknown) =>
  typeof e === 'string' ? e : e instanceof Error ? e.message : '操作失败'
/** Characters past which a memory shows three lines until opened. */
const long = 160

export type MemorySection = 'kept' | 'topics' | 'pending'

/** Settings › 记忆: what Familiar has drawn out about the user, editable in place. */
export function MemoryPage({ section }: { section: MemorySection }) {
  const [items, setItems] = useState<MemoryItem[]>()
  const [notice, setNotice] = useState('')
  const [busy, setBusy] = useState(false)
  /** Long memories show three lines until opened. */
  const [opened, setOpened] = useState<Set<string>>(new Set())
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
      if ('error' in r) setNotice(`没整理成：${r.error}`)
      else if (!r.conversations) setNotice('没有新对话要整理')
      else
        setNotice(
          `整理了 ${r.conversations} 个对话，${r.pending ? `${r.pending} 条新判断等你确认` : '没有新判断'}${r.promoted ? `，${r.promoted} 条反复出现，已记下` : ''}${r.failed ? `，${r.failed} 个没整理成` : ''}`,
        )
    })
    window.addEventListener('focus', load)
    return () => {
      off()
      window.removeEventListener('focus', load)
    }
  }, [load])
  if (!items) return <p role="status">{notice || '正在读取…'}</p>
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

  const row = (item: MemoryItem, actions: 'kept' | 'pending') => {
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
                if (e.key === 'Enter' && inputKey(e.nativeEvent) !== 'send')
                  e.preventDefault()
                if (inputKey(e.nativeEvent) === 'close') {
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
          <span
            className={
              item.text.length > long && !opened.has(item.id)
                ? 'clamped'
                : undefined
            }
          >
            {item.text}
          </span>
          {item.text.length > long && (
            <button
              type="button"
              className="link more"
              onClick={() =>
                setOpened((o) => {
                  const next = new Set(o)
                  if (next.has(item.id)) next.delete(item.id)
                  else next.add(item.id)
                  return next
                })
              }
            >
              {opened.has(item.id) ? '收起' : '展开'}
            </button>
          )}
          {actions === 'pending' ? (
            <span className="muted">
              {item.target === 'topic' && item.targetTopic
                ? `记到主题「${item.targetTopic}」`
                : `记到${targetLabel[item.target ?? 'profile']}`}
              {item.evidence ? `，依据「${item.evidence}」` : ''}
              {item.seen && item.seen > 1
                ? `，在 ${item.seen} 个对话里出现过`
                : ''}
            </span>
          ) : (
            item.at && (
              <span className="muted">
                {item.at}
                {item.source === 'reflection' ? '，从对话里整理' : ''}
              </span>
            )
          )}
        </div>
        <span className="row-actions">
          {actions === 'pending' && (
            <button
              type="button"
              title="这条判断没错，记下来"
              onClick={() => act(api.confirmMemory(item.id))}
            >
              记下
            </button>
          )}
          <button
            type="button"
            onClick={() => setEditing({ id: item.id, text: item.text })}
          >
            改
          </button>
          <button
            type="button"
            title={actions === 'pending' ? '这条判断不对，丢掉' : '删除这条'}
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
    actions: 'kept' | 'pending',
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
        <button type="button" onClick={() => api.revealMemory()}>
          打开文件夹
        </button>
      </div>
      {leftovers.length > 0 && (
        <div className="group memory-leftovers" role="alert">
          <p>
            时间线里还有 {leftovers.length}{' '}
            条提到这件事，不删的话它还可能想起来：
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
      {section === 'pending' &&
        group(
          '从对话和电脑活动里猜的，点「记下」它才会记住',
          pending,
          'pending',
          '没有等你确认的判断',
        )}
      {section === 'kept' && (
        <>
          {group(
            '画像',
            kept('profile'),
            'kept',
            '还没有。可以对它说「记住……」',
          )}
          {group('习惯', kept('habits'), 'kept', '还没有')}
          {group('经验', kept('lessons'), 'kept', '还没有')}
        </>
      )}
      {section === 'topics' &&
        (topics.length
          ? topics.map((t) => group(t, kept('topic', t), 'kept'))
          : group('主题', [], 'kept', '还没有'))}
    </div>
  )
}
