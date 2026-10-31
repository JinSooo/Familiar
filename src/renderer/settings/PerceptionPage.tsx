import { useCallback, useEffect, useState } from 'react'
import type {
  PerceptionApp,
  PerceptionEvent,
  PerceptionStatus,
  Settings,
} from '../../shared'
import { api } from '../api'

type Perception = Settings['perception']
const failure = (e: unknown) =>
  typeof e === 'string' ? e : e instanceof Error ? e.message : '操作失败'
const kindLabel = {
  browser: '浏览器',
  editor: '编辑器',
  terminal: '终端',
  recent: '最近用过',
} as const
const clearOptions = [
  [10, '最近 10 分钟'],
  [60, '最近 1 小时'],
  [1440, '最近 1 天'],
  ['all', '全部'],
] as const
const time = (at: number) => new Date(at).toTimeString().slice(0, 5)

function Switch(props: {
  on: boolean
  label: string
  onChange: (on: boolean) => void
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={props.on}
      aria-label={props.label}
      className="switch"
      onClick={() => props.onChange(!props.on)}
    />
  )
}

/** The settings window's 感知 tab: Computer History's switch, permissions and history. */
export function PerceptionPage() {
  const [perception, setPerception] = useState<Perception>()
  const [status, setStatus] = useState<PerceptionStatus>()
  const [view, setView] = useState<'main' | 'choose' | 'raw'>('main')
  const [clearing, setClearing] = useState<(typeof clearOptions)[number]>()
  const [notice, setNotice] = useState('')

  const refresh = useCallback(() => {
    void api
      .getSettings()
      .then((s) => setPerception(s.perception))
      .catch((e: unknown) => setNotice(failure(e)))
    void api.perceptionStatus().then(setStatus).catch(console.error)
  }, [])
  useEffect(() => {
    refresh()
    const off = api.onPerceptionChanged((next) => {
      setStatus(next)
      setPerception((p) => p && { ...p, paused: next.paused })
    })
    window.addEventListener('focus', refresh)
    return () => {
      off()
      window.removeEventListener('focus', refresh)
    }
  }, [refresh])
  if (!perception || !status) return <p role="status">{notice || '读取…'}</p>

  const save = (next: Perception) => {
    setPerception(next)
    api
      .savePerception(next)
      .then(setPerception)
      .catch((e: unknown) => setNotice(failure(e)))
  }

  if (view === 'choose')
    return (
      <Choose
        perception={perception}
        save={save}
        back={() => setView('main')}
      />
    )
  if (view === 'raw') return <Raw back={() => setView('main')} />

  const state = !perception.enabled
    ? ''
    : perception.paused
      ? '已暂停'
      : status.trusted === false
        ? '需要辅助功能权限才能读取窗口和文字'
        : (status.error ??
          (status.running
            ? `正在记录${status.lastEventAt ? ` · 最近一次 ${time(status.lastEventAt)}` : ''}`
            : '启动中…'))

  return (
    <>
      <div className="group">
        <div className="setting-row">
          <div className="ch-label">
            <span>Computer History</span>
            <span className="muted">
              记下你在电脑上做的事，让它知道你在忙什么、接着帮你。不截图，不碰摄像头和麦克风。
            </span>
            {state && (
              <span className={status.trusted === false ? 'warn' : 'muted'}>
                {state}
              </span>
            )}
          </div>
          <span className="row-actions">
            {perception.enabled && status.trusted === false && (
              <button type="button" onClick={() => api.perceptionGrant()}>
                去授权…
              </button>
            )}
            {perception.enabled && (
              <button
                type="button"
                onClick={() =>
                  api
                    .perceptionPause(!perception.paused)
                    .catch((e: unknown) => setNotice(failure(e)))
                }
              >
                {perception.paused ? '继续' : '暂停'}
              </button>
            )}
            <Switch
              on={perception.enabled}
              label="Computer History"
              onChange={(on) => save({ ...perception, enabled: on })}
            />
          </span>
        </div>
        <div className="setting-row">
          <div className="ch-label">
            <span>应用和网站</span>
            <span className="muted">
              {perception.excludedApps.length
                ? `排除 ${perception.excludedApps.length} 个应用`
                : '默认记录所有应用'}
              {perception.excludedSites.length
                ? `，排除 ${perception.excludedSites.length} 个网站`
                : ''}
            </span>
          </div>
          <button type="button" onClick={() => setView('choose')}>
            选择…
          </button>
        </div>
      </div>

      <div className="ch-head">
        <h3 className="memory-heading">数据</h3>
        <span className="row-actions">
          <button type="button" onClick={() => setView('raw')}>
            原始记录
          </button>
          <select
            aria-label="清除记录"
            value=""
            onChange={(e) => setClearing(clearOptions[Number(e.target.value)])}
          >
            <option value="" disabled>
              清除记录
            </option>
            {clearOptions.map(([, label], i) => (
              <option key={label} value={i}>
                {label}
              </option>
            ))}
          </select>
        </span>
      </div>
      {clearing && (
        <div className="group">
          <div className="setting-row">
            <span>
              清除{clearing[1]}的原始记录？跨进这段时间的历史条目整条删除。
            </span>
            <span className="row-actions">
              <button
                type="button"
                className="danger"
                onClick={() => {
                  const [minutes, label] = clearing
                  setClearing(undefined)
                  api
                    .perceptionClear(minutes)
                    .then(() => setNotice(`已清除${label}的记录`))
                    .catch((e: unknown) => setNotice(failure(e)))
                }}
              >
                清除
              </button>
              <button type="button" onClick={() => setClearing(undefined)}>
                取消
              </button>
            </span>
          </div>
        </div>
      )}
      <p className="caption">
        原始记录加密存在本机，48
        小时后自动删除；整理时会把过滤后的活动发给你在「模型」页选的模型，结果写进「记忆」的时间线，推测出的长期信息只进待确认。
      </p>
      <p role="status" className="caption">
        {notice}
      </p>
    </>
  )
}

/** 应用和网站: which apps are read, which only stay on this Mac, which sites are skipped. */
function Choose(props: {
  perception: Perception
  save: (next: Perception) => void
  back: () => void
}) {
  const { perception, save } = props
  const [candidates, setCandidates] = useState<PerceptionApp[]>([])
  const [site, setSite] = useState('')
  useEffect(() => {
    void api.perceptionApps().then(setCandidates).catch(console.error)
  }, [])
  const listed = [
    ...perception.excludedApps.map((a) => ({
      ...a,
      mode: 'excluded' as const,
    })),
    ...perception.localApps.map((a) => ({ ...a, mode: 'local' as const })),
  ]
  const added = new Set(listed.map((a) => a.bundleId))
  const addable = candidates.filter((c) => !added.has(c.bundleId))
  // Puts an app in one list (or neither when no mode is given).
  const move = (
    app: { bundleId: string; name: string },
    mode?: 'excluded' | 'local',
  ): Perception => {
    const item = { bundleId: app.bundleId, name: app.name }
    const others = (list: { bundleId: string; name: string }[]) =>
      list.filter((a) => a.bundleId !== app.bundleId)
    return {
      ...perception,
      excludedApps: [
        ...others(perception.excludedApps),
        ...(mode === 'excluded' ? [item] : []),
      ],
      localApps: [
        ...others(perception.localApps),
        ...(mode === 'local' ? [item] : []),
      ],
    }
  }
  return (
    <>
      <button type="button" className="link ch-back" onClick={props.back}>
        ‹ Computer History
      </button>
      <h3 className="memory-heading">应用</h3>
      <div className="group">
        <ul className="memory-list">
          {listed.map((app) => (
            <li key={app.bundleId} className="memory-item">
              <div className="memory-text">
                <span>{app.name}</span>
                <span className="muted">{app.bundleId}</span>
              </div>
              <span className="row-actions">
                <span className="segmented">
                  {(['excluded', 'local'] as const).map((mode) => (
                    <button
                      type="button"
                      key={mode}
                      className={app.mode === mode ? 'selected' : ''}
                      title={
                        mode === 'local'
                          ? '照常记录，但整理时不把它发给模型'
                          : undefined
                      }
                      onClick={() => save(move(app, mode))}
                    >
                      {mode === 'excluded' ? '不记录' : '只留本机'}
                    </button>
                  ))}
                </span>
                <button
                  type="button"
                  aria-label={`移除 ${app.name}`}
                  onClick={() => save(move(app))}
                >
                  移除
                </button>
              </span>
            </li>
          ))}
          {!listed.length && (
            <li className="memory-item muted">
              还没有排除的应用，所有应用都在记录。
            </li>
          )}
        </ul>
        {addable.length > 0 && (
          <details className="rules">
            <summary>
              添加应用<span className="muted">{addable.length} 个</span>
            </summary>
            <ul>
              {addable.map((app) => (
                <li key={app.bundleId}>
                  <span>{app.name}</span>
                  <span className="muted">{kindLabel[app.kind]}</span>
                  <button
                    type="button"
                    onClick={() => save(move(app, 'excluded'))}
                  >
                    添加
                  </button>
                </li>
              ))}
            </ul>
          </details>
        )}
      </div>
      <p className="caption">
        默认所有应用都会记录窗口和文字。「不记录」的应用什么都不留，连名字也不记；「只留本机」的应用照常记录，但整理时不发给模型。密码框、浏览器隐私窗口一律不读。
      </p>

      <h3 className="memory-heading">排除网站</h3>
      <div className="group">
        {perception.excludedSites.map((s) => (
          <div className="setting-row" key={s}>
            <span>{s}</span>
            <button
              type="button"
              className="icon"
              aria-label={`不再排除 ${s}`}
              onClick={() =>
                save({
                  ...perception,
                  excludedSites: perception.excludedSites.filter(
                    (x) => x !== s,
                  ),
                })
              }
            >
              ×
            </button>
          </div>
        ))}
        <form
          className="setting-row"
          onSubmit={(e) => {
            e.preventDefault()
            const domain = site.trim().toLowerCase()
            if (!domain || perception.excludedSites.includes(domain)) return
            save({
              ...perception,
              excludedSites: [...perception.excludedSites, domain],
            })
            setSite('')
          }}
        >
          <input
            placeholder="例如 bank.com，子域名一并排除"
            value={site}
            onChange={(e) => setSite(e.target.value)}
          />
          <button type="submit">添加</button>
        </form>
      </div>
    </>
  )
}

/** The raw events of the last hour, as stored (decrypted for display only). */
function Raw(props: { back: () => void }) {
  const [events, setEvents] = useState<PerceptionEvent[]>()
  const [error, setError] = useState('')
  useEffect(() => {
    void api
      .perceptionRecent()
      .then(setEvents)
      .catch((e: unknown) => setError(failure(e)))
  }, [])
  return (
    <>
      <button type="button" className="link ch-back" onClick={props.back}>
        ‹ Computer History
      </button>
      <h3 className="memory-heading">最近一小时的原始记录</h3>
      {!events ? (
        <p role="status">{error || '读取…'}</p>
      ) : (
        <ul className="memory-list group">
          {events.map((e, i) => (
            <li key={i} className="memory-item">
              <div className="memory-text">
                <span>
                  {e.kind === 'idle'
                    ? '离开'
                    : e.kind === 'active'
                      ? '回来'
                      : e.app || e.bundleId
                        ? `${e.app ?? e.bundleId}${e.title ? `「${e.title}」` : ''}`
                        : '不记录的应用'}
                </span>
                {e.url && <span className="muted">{e.url}</span>}
                {e.text && (
                  <span className="muted">{e.text.slice(0, 160)}</span>
                )}
                <span className="muted">
                  {time(e.at)}
                  {e.private ? ' · 隐私窗口，只记应用' : ''}
                  {e.secure ? ' · 密码框，没读内容' : ''}
                  {e.dropped?.length
                    ? ` · 过滤掉了 ${e.dropped.join('、')}`
                    : ''}
                </span>
              </div>
            </li>
          ))}
          {!events.length && <li className="memory-item muted">没有记录。</li>}
        </ul>
      )}
    </>
  )
}
