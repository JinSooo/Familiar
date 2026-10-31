import { useCallback, useEffect, useState } from 'react'
import type { MemoryItem, PerceptionStatus, PetState } from '../../shared'
import { api } from '../api'
import { PetAvatar } from '../pet/PetAvatar'

const stateLabel: Record<PetState, string> = {
  idle: '空闲',
  listening: '在听你说',
  thinking: '在想',
  talking: '在回复',
  'needs-you': '等你回应',
  done: '有新回复',
  failed: '刚才出错了',
  sleeping: '在睡觉',
}
const pad = (n: number) => String(n).padStart(2, '0')
const today = () => {
  const d = new Date()
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}
/** Rows the panel shows before pointing to the timeline page. */
const shownCount = 6
const clock = (at: number) => new Date(at).toTimeString().slice(0, 5)
/** A timeline line's time and title: activity lines carry them, conversation lines start with the time. */
function view(item: MemoryItem): { time: string; title: string } {
  if (item.activity)
    return { time: clock(item.activity.start), title: item.activity.title }
  const m = /^(\d{2}:\d{2}) ([\s\S]*)$/.exec(item.text)
  return m ? { time: m[1]!, title: m[2]! } : { time: '', title: item.text }
}

/** The menu bar panel: how the pet is doing and what today looked like. */
export function TrayPanel() {
  const [name, setName] = useState('')
  const [state, setState] = useState<PetState>('idle')
  const [perception, setPerception] = useState<PerceptionStatus>()
  const [enabled, setEnabled] = useState(false)
  const [items, setItems] = useState<MemoryItem[]>()
  const [icons, setIcons] = useState<Record<string, string>>({})
  /** Bumped on every open: the window loads at launch, possibly before the pet skin is known. */
  const [opened, setOpened] = useState(0)

  // Everything is read again each time the panel opens (the window takes focus).
  const load = useCallback(() => {
    void api
      .getSettings()
      .then((s) => {
        setName(s.pet.name)
        setEnabled(s.perception.enabled)
      })
      .catch(console.error)
    void api.perceptionStatus().then(setPerception).catch(console.error)
    void api
      .listMemory()
      .then((all) =>
        setItems(
          all
            .filter(
              (i) =>
                i.category === 'timeline' &&
                i.status === 'confirmed' &&
                i.key === today(),
            )
            .sort((a, b) => view(b).time.localeCompare(view(a).time)),
        ),
      )
      .catch(console.error)
  }, [])
  useEffect(() => {
    load()
    const offState = api.onState(setState)
    const offPerception = api.onPerceptionChanged(setPerception)
    const offMemory = api.onMemoryChanged(load)
    const open = () => {
      load()
      setOpened((n) => n + 1)
      // Opening is not a keyboard visit; no focus ring on the first button.
      ;(document.activeElement as HTMLElement | null)?.blur()
    }
    window.addEventListener('focus', open)
    return () => {
      offState()
      offPerception()
      offMemory()
      window.removeEventListener('focus', open)
    }
  }, [load])
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
          ...Object.fromEntries(missing.map((id) => [id, ''])),
          ...found,
        })),
      )
      .catch(console.error)
  }, [items, icons])

  const watching = !enabled
    ? { tone: 'off', text: '感知未开启' }
    : perception?.paused
      ? { tone: 'paused', text: '感知已暂停' }
      : perception?.trusted === false
        ? { tone: 'warn', text: '需要辅助功能权限' }
        : {
            tone: 'on',
            text: `正在记录${perception?.lastEventAt ? ` · ${clock(perception.lastEventAt)}` : ''}`,
          }

  return (
    <main className="tray-panel">
      <header className="tray-head">
        <PetAvatar key={opened} size={44} />
        <div className="tray-who">
          <strong>{name}</strong>
          <span className="muted">{stateLabel[state]}</span>
        </div>
      </header>
      <div className="tray-watch">
        <i className={`dot ${watching.tone}`} aria-hidden="true" />
        <span>{watching.text}</span>
        {enabled && perception && perception.trusted !== false && (
          <button
            type="button"
            className="link"
            onClick={() =>
              void api.perceptionPause(!perception.paused).catch(console.error)
            }
          >
            {perception.paused ? '继续' : '暂停'}
          </button>
        )}
      </div>
      <h3 className="tray-heading">今天</h3>
      <ol className="tray-list">
        {items?.slice(0, shownCount).map((item) => {
          const v = view(item)
          return (
            <li key={item.id}>
              <time>{v.time}</time>
              <span className="tray-title" title={item.text}>
                {v.title}
              </span>
              <span className="tray-apps">
                {item.activity?.apps
                  .slice(0, 3)
                  .map((a) =>
                    icons[a.bundleId] ? (
                      <img
                        key={a.bundleId}
                        src={icons[a.bundleId]}
                        alt={a.name}
                        title={a.name}
                      />
                    ) : null,
                  )}
              </span>
            </li>
          )
        })}
        {items && !items.length && (
          <li className="tray-empty muted">还没有整理出的活动</li>
        )}
      </ol>
      {items && items.length > shownCount && (
        <button
          type="button"
          className="link tray-more"
          onClick={() => api.openSettings('timeline')}
        >
          还有 {items.length - shownCount} 条 · 在设置里查看
        </button>
      )}
    </main>
  )
}
