import { useCallback, useEffect, useState } from 'react'
import type { Extensions, McpCandidate, SkillInfo } from '../../shared'
import { api } from '../api'
import { Switch } from './Switch'

const failure = (e: unknown) =>
  typeof e === 'string' ? e : e instanceof Error ? e.message : '操作失败'
const accessLabel = { allow: '允许', ask: '询问', off: '停用' } as const
const stateLabel = {
  connected: '已连接',
  error: '连接失败',
  idle: '未连接',
  off: '已停用',
} as const

export type ExtensionSection = 'mcp' | 'skills'

/** Chevron at the end of a row that opens its detail page. */
function Chevron() {
  return (
    <svg
      className="chevron"
      width="12"
      height="12"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M9 6l6 6-6 6" />
    </svg>
  )
}

/** A detail page's title row: back, then its own name. */
function DetailHeader(props: { title: string; back: () => void }) {
  return (
    <div className="subpage-head">
      <button
        type="button"
        className="icon"
        aria-label="返回"
        title="返回"
        onClick={props.back}
      >
        ‹
      </button>
      <h3>{props.title}</h3>
    </div>
  )
}

/** Settings › 扩展: MCP servers and skills, each a list that opens into its details. */
export function ExtensionsPage({ section }: { section: ExtensionSection }) {
  const [data, setData] = useState<Extensions>()
  const [disabled, setDisabled] = useState<string[]>([])
  const [notice, setNotice] = useState('')
  const [busy, setBusy] = useState(false)
  const [mcpOffer, setMcpOffer] = useState<McpCandidate[]>()
  const [skillOffer, setSkillOffer] =
    useState<(SkillInfo & { from: string; exists: boolean })[]>()
  /** The server name or skill path whose details are open. */
  const [open, setOpen] = useState<string>()
  const load = useCallback((connect = false) => {
    setBusy(connect)
    Promise.all([api.getExtensions(connect), api.getSettings()])
      .then(([ext, settings]) => {
        setData(ext)
        setDisabled(settings.disabledSkills)
      })
      .catch((e: unknown) => setNotice(failure(e)))
      .finally(() => setBusy(false))
  }, [])
  useEffect(() => load(true), [load])
  useEffect(() => setOpen(undefined), [section])
  const act = (work: Promise<unknown>, after?: () => void) =>
    work
      .then(() => {
        after?.()
        load(true)
      })
      .catch((e: unknown) => setNotice(failure(e)))
  const toggleSkill = async (name: string, on: boolean) => {
    const settings = await api.getSettings()
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { apiKeySet, ...model } = settings.model
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { apiKeySet: imageKeySet, ...imageModel } = settings.imageModel
    const next = on
      ? settings.disabledSkills.filter((n) => n !== name)
      : [...new Set([...settings.disabledSkills, name])]
    await api.saveSettings({
      ...settings,
      model,
      imageModel,
      disabledSkills: next,
    })
    setDisabled(next)
  }
  if (!data) return <p role="status">{notice || '读取扩展…'}</p>
  const status = notice && (
    <p role="status" className="caption">
      {notice}
    </p>
  )

  if (section === 'mcp') {
    const detail = data.mcp.find((s) => s.name === open)
    if (detail)
      return (
        <div className="ext-page">
          <DetailHeader title={detail.name} back={() => setOpen(undefined)} />
          <div className="group">
            <div className="setting-row">
              <span>状态</span>
              <span className="ext-state">
                <i className={`dot ${detail.state}`} aria-hidden="true" />
                {stateLabel[detail.state]}
                {detail.state === 'error' && detail.target && (
                  <button
                    type="button"
                    onClick={() => act(api.reconnectMcp(detail.name))}
                  >
                    重连
                  </button>
                )}
              </span>
            </div>
            {detail.error && (
              <div className="setting-row">
                <span className="error">{detail.error}</span>
              </div>
            )}
            {detail.target && (
              <div className="setting-row">
                <span>权限</span>
                <div className="segmented">
                  {(['allow', 'ask', 'off'] as const).map((a) => (
                    <button
                      type="button"
                      key={a}
                      className={detail.access === a ? 'selected' : ''}
                      title={
                        a === 'ask'
                          ? '每次用它的工具先问你'
                          : a === 'allow'
                            ? '直接用，工具在服务器那边执行，不受沙箱约束'
                            : undefined
                      }
                      onClick={() => act(api.setMcpAccess(detail.name, a))}
                    >
                      {accessLabel[a]}
                    </button>
                  ))}
                </div>
              </div>
            )}
            {detail.target && (
              <div className="setting-row">
                <span>启动方式</span>
                <code className="ext-target" title={detail.target}>
                  {detail.target}
                </code>
              </div>
            )}
          </div>
          <h3 className="memory-heading">
            工具{detail.tools.length ? ` · ${detail.tools.length}` : ''}
          </h3>
          <ul className="group memory-list">
            {detail.tools.length ? (
              detail.tools.map((t) => (
                <li key={t} className="ext-item">
                  <code>{t}</code>
                </li>
              ))
            ) : (
              <li className="memory-item muted">
                {detail.state === 'connected' ? '没有工具' : '连上后显示'}
              </li>
            )}
          </ul>
          <div className="page-actions">
            <button
              type="button"
              className="danger-quiet"
              onClick={() =>
                act(api.removeMcp(detail.name), () => setOpen(undefined))
              }
            >
              从配置里移除
            </button>
          </div>
          {status}
        </div>
      )
    return (
      <div className="ext-page">
        <div className="page-actions">
          <button
            type="button"
            onClick={() =>
              api
                .mcpCandidates()
                .then(setMcpOffer)
                .catch((e: unknown) => setNotice(failure(e)))
            }
          >
            导入…
          </button>
          <button
            type="button"
            title={data.mcpFile}
            onClick={() => api.revealMcp()}
          >
            编辑配置文件
          </button>
          <button
            type="button"
            aria-disabled={busy}
            onClick={() => !busy && load(true)}
          >
            {busy ? '连接中…' : '刷新'}
          </button>
        </div>
        {mcpOffer && (
          <Picker
            title="从其他工具导入"
            empty="没有在 Cursor、Codex、Claude Desktop、Claude Code 里找到可导入的服务器。"
            items={mcpOffer.map((c) => ({
              key: `${c.source}/${c.name}`,
              label: c.name,
              detail: `${c.source} · ${c.target}`,
              disabled: c.exists,
            }))}
            onCancel={() => setMcpOffer(undefined)}
            onImport={(keys) =>
              act(
                api.importMcp(
                  mcpOffer
                    .filter((c) => keys.includes(`${c.source}/${c.name}`))
                    .map(({ name, entry }) => ({ name, entry })),
                ),
                () => setMcpOffer(undefined),
              )
            }
          />
        )}
        <ul className="group memory-list">
          {data.mcp.length ? (
            data.mcp.map((s) => (
              <li key={s.name}>
                <button
                  type="button"
                  className="ext-row"
                  onClick={() => setOpen(s.name)}
                >
                  <i className={`dot ${s.state}`} aria-hidden="true" />
                  <span className="ext-main">
                    <span className="ext-title">{s.name}</span>
                    <span className="muted ext-sub">
                      {s.error ??
                        (s.state === 'connected'
                          ? `${s.tools.length} 个工具`
                          : stateLabel[s.state])}
                    </span>
                  </span>
                  <span className="muted ext-badge">
                    {accessLabel[s.access]}
                  </span>
                  <Chevron />
                </button>
              </li>
            ))
          ) : (
            <li className="memory-item muted">还没有服务器。</li>
          )}
        </ul>
        {status}
      </div>
    )
  }

  const skill = data.skills.find((s) => s.path === open)
  if (skill) {
    const on = !disabled.includes(skill.name)
    return (
      <div className="ext-page">
        <DetailHeader title={skill.name} back={() => setOpen(undefined)} />
        <div className="group">
          <div className="setting-row">
            <span>启用</span>
            <Switch
              on={on}
              label={`启用技能 ${skill.name}`}
              onChange={(v) =>
                toggleSkill(skill.name, v).catch((e: unknown) =>
                  setNotice(failure(e)),
                )
              }
            />
          </div>
          <div className="setting-row">
            <span>来源</span>
            <span className="muted">
              {skill.source === 'shared' ? '~/.agents 共享' : '已导入'}
            </span>
          </div>
          <div className="setting-row">
            <span>位置</span>
            <code className="ext-target" title={skill.path}>
              {skill.path}
            </code>
          </div>
        </div>
        <h3 className="memory-heading">描述</h3>
        <div className="group ext-description">
          {skill.description || <span className="muted">没有描述</span>}
        </div>
        {skill.source === 'imported' && (
          <div className="page-actions">
            <button
              type="button"
              className="danger-quiet"
              onClick={() =>
                act(api.removeSkill(skill.path), () => setOpen(undefined))
              }
            >
              删除
            </button>
          </div>
        )}
        {status}
      </div>
    )
  }
  return (
    <div className="ext-page">
      <div className="page-actions">
        <button
          type="button"
          onClick={() =>
            api
              .skillCandidates()
              .then(setSkillOffer)
              .catch((e: unknown) => setNotice(failure(e)))
          }
        >
          导入…
        </button>
      </div>
      {skillOffer && (
        <Picker
          title="从 Claude Code、Codex 导入"
          empty="~/.claude/skills 和 ~/.codex/skills 里没有找到技能。"
          items={skillOffer.map((s) => ({
            key: s.path,
            label: s.name,
            detail: `${s.from} · ${s.description}`,
            disabled: s.exists,
          }))}
          onCancel={() => setSkillOffer(undefined)}
          onImport={async (paths) => {
            for (const p of paths)
              await api
                .importSkill(p)
                .catch((e: unknown) => setNotice(failure(e)))
            setSkillOffer(undefined)
            load()
          }}
        />
      )}
      <ul className="group memory-list">
        {data.skills.length ? (
          data.skills.map((s) => (
            <li key={s.path}>
              <button
                type="button"
                className="ext-row"
                onClick={() => setOpen(s.path)}
              >
                <span className="ext-main">
                  <span className="ext-title">{s.name}</span>
                  <span className="muted ext-sub">
                    {s.description || '没有描述'}
                  </span>
                </span>
                <span className="muted ext-badge">
                  {disabled.includes(s.name) ? '已停用' : ''}
                </span>
                <Chevron />
              </button>
            </li>
          ))
        ) : (
          <li className="memory-item muted">还没有技能。</li>
        )}
      </ul>
      {status}
    </div>
  )
}

function Picker({
  title,
  empty,
  items,
  onImport,
  onCancel,
}: {
  title: string
  empty: string
  items: { key: string; label: string; detail: string; disabled: boolean }[]
  onImport: (keys: string[]) => void
  onCancel: () => void
}) {
  const [picked, setPicked] = useState<string[]>([])
  return (
    <div className="group picker">
      <strong>{title}</strong>
      {items.length ? (
        <ul>
          {items.map((i) => (
            <li key={i.key}>
              <label className={i.disabled ? 'muted' : ''}>
                <input
                  type="checkbox"
                  disabled={i.disabled}
                  checked={picked.includes(i.key)}
                  onChange={(e) =>
                    setPicked((p) =>
                      e.target.checked
                        ? [...p, i.key]
                        : p.filter((k) => k !== i.key),
                    )
                  }
                />
                <span>
                  {i.label}
                  {i.disabled ? '（已有）' : ''}
                  <small className="muted">{i.detail}</small>
                </span>
              </label>
            </li>
          ))}
        </ul>
      ) : (
        <p className="muted">{empty}</p>
      )}
      <span className="row-actions">
        <button
          type="button"
          className="primary"
          disabled={!picked.length}
          onClick={() => onImport(picked)}
        >
          导入 {picked.length || ''}
        </button>
        <button type="button" onClick={onCancel}>
          取消
        </button>
      </span>
    </div>
  )
}
