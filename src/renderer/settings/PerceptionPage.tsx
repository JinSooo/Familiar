import { useCallback, useEffect, useState } from 'react'
import type {
  PerceptionApp,
  PerceptionEvent,
  PerceptionStatus,
  Settings,
} from '../../shared'
import { api } from '../api'
import { Switch } from './Switch'
import { Icon } from '../shared-ui/Icon'

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

export type PerceptionSection = 'capture' | 'raw'

/** Settings › 感知: Computer History's switch, apps and sites, and the raw record. */
export function PerceptionPage({ section }: { section: PerceptionSection }) {
  const [perception, setPerception] = useState<Perception>()
  const [status, setStatus] = useState<PerceptionStatus>()
  const [choosing, setChoosing] = useState(false)
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
  if (!perception || !status)
    return <p role="status">{notice || '正在读取…'}</p>

  const save = (next: Perception) => {
    setPerception(next)
    api
      .savePerception(next)
      .then(setPerception)
      .catch((e: unknown) => setNotice(failure(e)))
  }

  if (section === 'capture' && choosing)
    return (
      <Choose
        perception={perception}
        save={save}
        back={() => setChoosing(false)}
      />
    )

  const state = !perception.enabled
    ? ''
    : perception.paused
      ? '已暂停'
      : status.trusted === false
        ? '需要辅助功能权限才能读取窗口和文字'
        : (status.error ??
          (status.running
            ? `正在记录${status.lastEventAt ? `，最近一次 ${time(status.lastEventAt)}` : ''}`
            : '正在启动…'))

  if (section === 'raw')
    return (
      <>
        <div className="group">
          <div className="setting-row">
            <div className="ch-label">
              <span>清除原始记录</span>
              <span className="muted">
                加密存在这台 Mac 上，48 小时后自动删除
              </span>
            </div>
            <select
              aria-label="清除记录"
              value=""
              onChange={(e) =>
                setClearing(clearOptions[Number(e.target.value)])
              }
            >
              <option value="" disabled>
                选择范围
              </option>
              {clearOptions.map(([, label], i) => (
                <option key={label} value={i}>
                  {label}
                </option>
              ))}
            </select>
          </div>
          {clearing && (
            <div className="setting-row">
              <span>
                清除{clearing[1]}
                的原始记录？时间线里和这段时间重叠的条目也会删掉，删了找不回来。
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
          )}
        </div>
        {notice && (
          <p role="status" className="caption">
            {notice}
          </p>
        )}
        <Raw />
      </>
    )
  return (
    <>
      <div className="group">
        <div className="setting-row">
          <div className="ch-label">
            <span>记录电脑活动</span>
            {!perception.enabled && (
              <span className="muted">
                不截图；整理时，过滤掉敏感内容的文字会发给模型
              </span>
            )}
            {state && (
              <span className={status.trusted === false ? 'warn' : 'muted'}>
                {state}
                {perception.enabled && status.trusted !== false && (
                  <>
                    <button
                      type="button"
                      className="link inline-action"
                      onClick={() =>
                        api
                          .perceptionPause(!perception.paused)
                          .catch((e: unknown) => setNotice(failure(e)))
                      }
                    >
                      {perception.paused ? '继续' : '暂停'}
                    </button>
                  </>
                )}
              </span>
            )}
          </div>
          <span className="row-actions">
            {perception.enabled && status.trusted === false && (
              <button type="button" onClick={() => api.perceptionGrant()}>
                去授权
              </button>
            )}
            <Switch
              on={perception.enabled}
              label="记录电脑活动"
              onChange={(on) => save({ ...perception, enabled: on })}
            />
          </span>
        </div>
        <div className="setting-row">
          <div className="ch-label">
            <span>应用和网站</span>
            <span className="muted">
              {perception.excludedApps.length
                ? `不记录 ${perception.excludedApps.length} 个应用`
                : '记录所有应用'}
              {perception.excludedSites.length
                ? `，不记录 ${perception.excludedSites.length} 个网站`
                : ''}
            </span>
          </div>
          <button type="button" onClick={() => setChoosing(true)}>
            选择…
          </button>
        </div>
      </div>

      {notice && (
        <p role="status" className="caption">
          {notice}
        </p>
      )}
    </>
  )
}

/** A subpage's own title, with the way back to the main page. */
function SubpageHeader(props: { title: string; back: () => void }) {
  return (
    <div className="subpage-head">
      <button
        type="button"
        className="icon"
        aria-label="返回"
        title="返回"
        onClick={props.back}
      >
        <Icon name="back" />
      </button>
      <h3>{props.title}</h3>
    </div>
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
      <SubpageHeader title="应用和网站" back={props.back} />
      <h3 className="memory-heading">不记录或只留本机的应用</h3>
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
            <li className="memory-item muted">所有应用都在记录</li>
          )}
        </ul>
        {addable.length > 0 && (
          <details className="rules">
            <summary>
              加入列表<span className="muted">{addable.length} 个可选</span>
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
                    不记录
                  </button>
                </li>
              ))}
            </ul>
          </details>
        )}
      </div>

      <h3 className="memory-heading">不记录的网站</h3>
      <div className="group">
        {perception.excludedSites.map((s) => (
          <div className="setting-row" key={s}>
            <span>{s}</span>
            <button
              type="button"
              className="icon"
              aria-label={`不再排除 ${s}`}
              title="移除"
              onClick={() =>
                save({
                  ...perception,
                  excludedSites: perception.excludedSites.filter(
                    (x) => x !== s,
                  ),
                })
              }
            >
              <Icon name="close" size={14} />
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
            placeholder="例如 bank.com，子域名也一起排除"
            value={site}
            onChange={(e) => setSite(e.target.value)}
          />
          <button type="submit">添加</button>
        </form>
      </div>
    </>
  )
}

/** File and web addresses as people read them: percent-encoding decoded. */
function readable(url: string): string {
  try {
    return decodeURI(url)
  } catch {
    return url
  }
}

/** Runs of the same app, window and page become one row (events are newest first). */
function collapse(events: PerceptionEvent[]) {
  const rows: { event: PerceptionEvent; count: number; until: number }[] = []
  const key = (e: PerceptionEvent) =>
    [e.kind, e.bundleId, e.title, e.url, e.text].join('\u0000')
  for (const e of events) {
    const last = rows.at(-1)
    if (last && key(last.event) === key(e)) {
      last.count++
      last.until = e.at
    } else rows.push({ event: e, count: 1, until: e.at })
  }
  return rows
}

/** The raw events of the last hour, as stored (decrypted for display only). */
function Raw() {
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
      <h3 className="memory-heading">最近一小时</h3>
      {!events ? (
        <p role="status">{error || '正在读取…'}</p>
      ) : (
        <ul className="memory-list group">
          {collapse(events).map(({ event: e, count, until }, i) => (
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
                {e.url && <span className="muted">{readable(e.url)}</span>}
                {e.text && (
                  <span className="muted">{e.text.slice(0, 160)}</span>
                )}
                <span className="muted">
                  {count > 1
                    ? `${time(until)}–${time(e.at)}，${count} 次`
                    : time(e.at)}
                  {e.private ? '，隐私窗口只记应用' : ''}
                  {e.secure ? '，密码框没读内容' : ''}
                  {e.dropped?.length ? `，过滤掉了${e.dropped.join('、')}` : ''}
                </span>
              </div>
            </li>
          ))}
          {!events.length && (
            <li className="memory-item muted">这一小时没有记录</li>
          )}
        </ul>
      )}
    </>
  )
}
