import { useCallback, useEffect, useRef, useState } from 'react'
import { getCurrentWindow } from '@tauri-apps/api/window'
import { LogicalSize } from '@tauri-apps/api/dpi'
import type {
  ConversationSummary,
  MemoryItem,
  PerceptionStatus,
  PetState,
  UsageToday,
} from '../../shared'
import { api } from '../api'
import { PetAvatar } from '../pet/PetAvatar'
import { Icon } from '../shared-ui/Icon'
import { prettyShortcut } from '../settings/Shortcuts'

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
const shownCount = 4
/** Window width, and the tallest the window grows before the page scrolls. */
const panelWidth = 320
const maxHeight = 600
const clock = (at: number) => new Date(at).toTimeString().slice(0, 5)
const duration = (minutes: number) =>
  minutes < 60
    ? `${minutes} 分钟`
    : `${Math.floor(minutes / 60)} 小时${minutes % 60 ? ` ${minutes % 60} 分` : ''}`
/** A timeline line's time and title: activity lines carry them, conversation lines start with the time. */
function view(item: MemoryItem): { time: string; title: string } {
  if (item.activity)
    return { time: clock(item.activity.start), title: item.activity.title }
  const m = /^(\d{2}:\d{2}) ([\s\S]*)$/.exec(item.text)
  return m ? { time: m[1]!, title: m[2]! } : { time: '', title: item.text }
}

/** The menu bar panel: how the pet is doing, what today looked like, and the way back in. */
export function TrayPanel() {
  const [name, setName] = useState('')
  const [summon, setSummon] = useState('')
  const [state, setState] = useState<PetState>('idle')
  const [perception, setPerception] = useState<PerceptionStatus>()
  const [enabled, setEnabled] = useState(false)
  const [items, setItems] = useState<MemoryItem[]>()
  const [pending, setPending] = useState(0)
  const [usage, setUsage] = useState<UsageToday>()
  const [last, setLast] = useState<ConversationSummary>()
  const [icons, setIcons] = useState<Record<string, string>>({})
  /** Bumped on every open: the window loads at launch, possibly before the pet skin is known. */
  const [opened, setOpened] = useState(0)

  // Everything is read again each time the panel opens (the window takes focus).
  const load = useCallback(() => {
    void api
      .getSettings()
      .then((s) => {
        setName(s.pet.name)
        setSummon(s.shortcuts.summon)
        setEnabled(s.perception.enabled)
        if (s.perception.enabled)
          void api.usageToday().then(setUsage).catch(console.error)
        else setUsage(undefined)
      })
      .catch(console.error)
    void api.perceptionStatus().then(setPerception).catch(console.error)
    void api
      .listConversations()
      .then((list) => setLast(list.find((c) => c.messages > 0)))
      .catch(console.error)
    void api
      .listMemory()
      .then((all) => {
        setPending(all.filter((i) => i.status === 'pending').length)
        setItems(
          all
            .filter(
              (i) =>
                i.category === 'timeline' &&
                i.status === 'confirmed' &&
                i.key === today(),
            )
            .sort((a, b) => view(b).time.localeCompare(view(a).time)),
        )
      })
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
      ...new Set([
        ...(usage?.apps.map((a) => a.bundleId) ?? []),
        ...(items ?? []).flatMap(
          (i) => i.activity?.apps.map((a) => a.bundleId) ?? [],
        ),
      ]),
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
  }, [items, usage, icons])

  // The window takes the height of what it shows, so there is no empty space under it.
  const body = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const el = body.current
    if (!el) return
    let last = 0
    const fit = () => {
      const height = Math.min(Math.ceil(el.scrollHeight), maxHeight)
      if (height === last) return
      last = height
      void getCurrentWindow()
        .setSize(new LogicalSize(panelWidth, height))
        .catch(console.error)
    }
    const observer = new ResizeObserver(fit)
    observer.observe(el)
    return () => observer.disconnect()
  }, [])

  const watching = !enabled
    ? { tone: 'off', text: '感知未开启' }
    : perception?.paused
      ? { tone: 'paused', text: '感知已暂停，点一下继续' }
      : perception?.trusted === false
        ? { tone: 'warn', text: '需要辅助功能权限' }
        : {
            tone: 'on',
            text: `正在记录${perception?.lastEventAt ? `，最近一次 ${clock(perception.lastEventAt)}` : ''}，点一下暂停`,
          }
  const canPause = enabled && perception && perception.trusted !== false
  const top = usage?.apps[0]?.minutes ?? 0

  return (
    <main className="tray-panel">
      <div className="tray-body" ref={body}>
        <header className="tray-head">
          <PetAvatar key={opened} size={44} />
          <div className="tray-who">
            <strong>
              {name}
              <button
                type="button"
                className={`tray-watch-dot ${watching.tone}`}
                title={watching.text}
                aria-label={watching.text}
                disabled={!canPause}
                onClick={() =>
                  canPause &&
                  void api
                    .perceptionPause(!perception.paused)
                    .catch(console.error)
                }
              >
                <i className={`dot ${watching.tone}`} aria-hidden="true" />
              </button>
            </strong>
            <span className="muted">{stateLabel[state]}</span>
          </div>
          <button
            type="button"
            className="icon"
            title="在大窗口打开"
            aria-label="在大窗口打开"
            onClick={() => api.openMainWindow()}
          >
            <Icon name="window" />
          </button>
          <button
            type="button"
            className="icon"
            title="设置"
            aria-label="设置"
            onClick={() => api.openSettings()}
          >
            <Icon name="settings" />
          </button>
        </header>

        <button
          type="button"
          className="tray-ask"
          onClick={() => api.newSession()}
        >
          <Icon name="new" />
          <span>和{name}说点什么…</span>
          {summon && <kbd>{prettyShortcut(summon)}</kbd>}
        </button>

        {last && (
          <button
            type="button"
            className="tray-card tray-resume"
            onClick={() =>
              void api
                .openConversation(last.id)
                .then(() => api.openMainWindow())
                .catch(console.error)
            }
          >
            <span className="muted">继续上次</span>
            <strong>{last.title}</strong>
            {last.preview && (
              <span className="tray-preview">{last.preview}</span>
            )}
          </button>
        )}

        {pending > 0 && (
          <button
            type="button"
            className="tray-card tray-pending"
            onClick={() => api.openSettings('pending')}
          >
            <span>
              有 <strong>{pending}</strong> 条判断等你确认
            </span>
            <span className="muted">去看看 ›</span>
          </button>
        )}

        {usage && usage.activeMinutes > 0 && (
          <section>
            <h3 className="tray-heading">
              今天活跃 <span>{duration(usage.activeMinutes)}</span>
            </h3>
            <ul className="tray-usage">
              {usage.apps.slice(0, 3).map((a) => (
                <li key={a.bundleId}>
                  {icons[a.bundleId] ? (
                    <img src={icons[a.bundleId]} alt="" />
                  ) : (
                    <span className="tray-usage-blank" />
                  )}
                  <span className="tray-usage-name">{a.name}</span>
                  <span className="tray-usage-bar">
                    <i style={{ width: `${(a.minutes / top) * 100}%` }} />
                  </span>
                  <span className="muted">{duration(a.minutes)}</span>
                </li>
              ))}
            </ul>
          </section>
        )}

        <section className="tray-today">
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
        </section>
      </div>
    </main>
  )
}
