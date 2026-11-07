import { useCallback, useEffect, useRef, useState } from 'react'
import type { ProactiveStatus, Settings } from '../../shared'
import { api } from '../api'
import { observeSnapshot } from '../shared-ui/synchronization'
import { Switch } from './Switch'
import { Icon } from '../shared-ui/Icon'

type Proactive = Settings['proactive']
const triggers: [keyof Proactive['triggers'], string, string][] = [
  ['firstToday', '每天第一次打开电脑', '打个招呼'],
  ['back', '离开半小时后回来', ''],
  ['longWork', '连续工作 90 分钟', '提醒歇一下'],
  ['activity', '看到你在做的事，能帮上忙时', '结合电脑活动、记忆和聊过的事'],
  ['lateNight', '深夜还在用电脑', '催你睡觉'],
  ['followUp', '跟进你之前说过的事', '比如面试之后问问怎么样'],
]
const levels: [Proactive['level'], string][] = [
  ['auto', '自动'],
  ['quiet', '安静'],
  ['normal', '适中'],
  ['chatty', '话多'],
]
const responses = {
  ok: '回应了',
  later: '稍后',
  quiet: '今天别打扰',
  ignored: '没理',
  missed: '没看到',
} as const
const held = { silent: '没开口', failed: '出错', expired: '没说出口' } as const
/** What set it thinking, for a held-back row. */
const moments: Record<string, string> = {
  firstToday: '今天第一次打开电脑',
  back: '你回来了',
  longWork: '你连续工作了很久',
  activity: '看了你在做的事',
  lateNight: '深夜还在用电脑',
  'follow-up': '到了跟进的时候',
}
const when = (at: number) => {
  const d = new Date(at)
  const today = new Date()
  const clock = d.toTimeString().slice(0, 5)
  return d.toDateString() === today.toDateString()
    ? clock
    : `${d.getMonth() + 1}月${d.getDate()}日 ${clock}`
}

/**
 * Settings › 主动: when the pet may speak up on its own, the reminders it holds and what it
 * said lately. The settings themselves come from the settings form, so they save like the rest.
 */
export function ProactivePage({
  value,
  onChange,
}: {
  value: Proactive
  onChange: (next: Proactive) => void
}) {
  const [status, setStatus] = useState<ProactiveStatus>()
  const [checking, setChecking] = useState(false)
  const refreshStatus = useRef(() => {})
  const refresh = useCallback(() => refreshStatus.current(), [])
  useEffect(() => {
    const off = observeSnapshot(
      api.proactiveStatus,
      api.onProactiveChanged,
      setStatus,
    )
    refreshStatus.current = off.refresh
    window.addEventListener('focus', refresh)
    return () => {
      off()
      window.removeEventListener('focus', refresh)
    }
  }, [refresh])
  const pending = status?.reminders.filter((r) => !r.done) ?? []
  // What it said and the times it thought about it and kept quiet, in one timeline.
  const recent = [...(status?.history ?? []), ...(status?.held ?? [])]
    .sort((a, b) => b.at - a.at)
    .slice(0, 20)
  return (
    <>
      <div className="group">
        <div className="setting-row">
          <div className="ch-label">
            <span>主动找你说话</span>
            {status && value.enabled && (
              <span className="muted">
                {status.quietUntil
                  ? '今天不再主动找你，明天恢复'
                  : status.usedToday
                    ? `今天说了 ${status.usedToday} 次`
                    : '今天还没说过'}
              </span>
            )}
          </div>
          <span className="row-actions">
            {status?.quietUntil && (
              <button
                type="button"
                className="link"
                onClick={() => void api.resumeProactive().then(refresh)}
              >
                现在恢复
              </button>
            )}
            <Switch
              on={value.enabled}
              label="主动找你说话"
              onChange={(enabled) => onChange({ ...value, enabled })}
            />
          </span>
        </div>
        <div className="setting-row">
          <div className="ch-label">
            <span title="自动：看你多常找它聊、对它的话回不回应来调整；点过「今天别打扰」会让之后几天少说一些">
              说话频率
            </span>
            {status && value.enabled && (
              <span className="muted">
                现在每天最多 {status.limit} 次，至少隔 {status.gapMinutes} 分钟
              </span>
            )}
          </div>
          <div className="segmented">
            {levels.map(([level, name]) => (
              <button
                type="button"
                key={level}
                className={value.level === level ? 'selected' : ''}
                onClick={() => onChange({ ...value, level })}
              >
                {name}
              </button>
            ))}
          </div>
        </div>
        <div className="setting-row">
          <div className="ch-label">
            <span>免打扰时段</span>
            <span className="muted">
              这段时间不主动说话，到点的提醒等结束再说
            </span>
          </div>
          <span className="row-actions">
            {value.quiet.enabled && (
              <>
                <input
                  type="time"
                  aria-label="免打扰开始"
                  value={value.quiet.from}
                  onChange={(e) =>
                    e.target.value &&
                    onChange({
                      ...value,
                      quiet: { ...value.quiet, from: e.target.value },
                    })
                  }
                />
                <span className="muted">到</span>
                <input
                  type="time"
                  aria-label="免打扰结束"
                  value={value.quiet.to}
                  onChange={(e) =>
                    e.target.value &&
                    onChange({
                      ...value,
                      quiet: { ...value.quiet, to: e.target.value },
                    })
                  }
                />
              </>
            )}
            <Switch
              on={value.quiet.enabled}
              label="免打扰时段"
              onChange={(enabled) =>
                onChange({ ...value, quiet: { ...value.quiet, enabled } })
              }
            />
          </span>
        </div>
      </div>

      <h3 className="memory-heading">什么时候会说</h3>
      <div className="group">
        {triggers.map(([key, name, hint]) => (
          <div className="setting-row" key={key}>
            <div className="ch-label">
              <span>{name}</span>
              {hint && <span className="muted">{hint}</span>}
            </div>
            <Switch
              on={value.triggers[key]}
              label={name}
              onChange={(on) =>
                onChange({
                  ...value,
                  triggers: { ...value.triggers, [key]: on },
                })
              }
            />
          </div>
        ))}
      </div>

      <div className="section-head">
        <h3 className="memory-heading">提醒</h3>
        <span className="row-actions">
          <button
            type="button"
            aria-disabled={checking}
            title="不等下一分钟，现在就看一下有没有要说的"
            onClick={() => {
              if (checking) return
              setChecking(true)
              void api
                .checkProactive()
                .catch(console.error)
                .finally(() => {
                  setChecking(false)
                  refresh()
                })
            }}
          >
            {checking ? '正在检查…' : '现在检查'}
          </button>
        </span>
      </div>
      <div className="group">
        {pending.length ? (
          pending.map((r) => (
            <div className="setting-row" key={r.id}>
              <div className="ch-label">
                <span>{r.text}</span>
                {r.at !== undefined && (
                  <span className="muted">
                    {when(r.at)}
                    {r.kind === 'follow-up' ? '，到时问问你' : ''}
                  </span>
                )}
              </div>
              <button
                type="button"
                className="icon rule-remove"
                aria-label={`取消提醒 ${r.text}`}
                title="取消这个提醒"
                onClick={() => void api.cancelReminder(r.id).then(refresh)}
              >
                <Icon name="close" size={14} />
              </button>
            </div>
          ))
        ) : (
          <p className="muted empty-row">
            对它说「明天十点提醒我交周报」就会出现在这里
          </p>
        )}
      </div>

      <h3 className="memory-heading">最近说过的</h3>
      <div className="group">
        {recent.length ? (
          recent.map((r) =>
            'id' in r ? (
              <div className="setting-row" key={r.id}>
                <div className="ch-label">
                  <span>{r.text}</span>
                  <span className="muted">
                    {when(r.at)}，{r.reason}
                  </span>
                </div>
                <span className="muted">
                  {r.response ? responses[r.response] : '在显示'}
                </span>
              </div>
            ) : (
              <div className="setting-row held" key={`${r.at}-${r.kind}`}>
                <div className="ch-label">
                  <span className="muted">
                    {r.text ?? moments[r.trigger] ?? r.trigger}
                  </span>
                  <span className="muted">
                    {when(r.at)}，{r.reason}
                  </span>
                </div>
                <span className={r.kind === 'failed' ? 'warn' : 'muted'}>
                  {held[r.kind]}
                </span>
              </div>
            ),
          )
        ) : (
          <p className="muted empty-row">还没有主动说过话</p>
        )}
      </div>
    </>
  )
}
