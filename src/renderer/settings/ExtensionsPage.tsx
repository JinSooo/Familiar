import { useCallback, useEffect, useState } from 'react'
import type {
  Extensions,
  McpCandidate,
  McpServerStatus,
  SkillInfo,
} from '../../shared'
import { api } from '../api'

const failure = (e: unknown) =>
  typeof e === 'string' ? e : e instanceof Error ? e.message : '操作失败'
const accessLabel = { allow: '允许', ask: '询问', off: '停用' } as const
const stateLabel = {
  connected: '已连接',
  error: '连接失败',
  idle: '未连接',
  off: '已停用',
} as const

/** Settings › 扩展: MCP servers and skills. */
export function ExtensionsPage() {
  const [data, setData] = useState<Extensions>()
  const [disabled, setDisabled] = useState<string[]>([])
  const [notice, setNotice] = useState('')
  const [busy, setBusy] = useState(false)
  const [mcpOffer, setMcpOffer] = useState<McpCandidate[]>()
  const [skillOffer, setSkillOffer] =
    useState<(SkillInfo & { from: string; exists: boolean })[]>()
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
    const next = on
      ? settings.disabledSkills.filter((n) => n !== name)
      : [...new Set([...settings.disabledSkills, name])]
    await api.saveSettings({ ...settings, model, disabledSkills: next })
    setDisabled(next)
  }
  if (!data) return <p role="status">{notice || '读取扩展…'}</p>

  const server = (s: McpServerStatus) => (
    <li key={s.name} className="ext-item">
      <div className="ext-main">
        <span className="ext-title">
          <i className={`dot ${s.state}`} aria-hidden="true" />
          {s.name}
          <small className="muted">
            {stateLabel[s.state]}
            {s.state === 'connected' ? ` · ${s.tools.length} 个工具` : ''}
          </small>
        </span>
        <span className="muted ext-sub" title={s.target}>
          {s.error ? s.error : s.target}
        </span>
        {s.state === 'connected' && s.tools.length > 0 && (
          <span className="muted ext-sub" title={s.tools.join('、')}>
            {s.tools.join('、')}
          </span>
        )}
      </div>
      <span className="row-actions">
        {s.target && (
          <div className="segmented">
            {(['allow', 'ask', 'off'] as const).map((a) => (
              <button
                type="button"
                key={a}
                className={s.access === a ? 'selected' : ''}
                onClick={() => act(api.setMcpAccess(s.name, a))}
              >
                {accessLabel[a]}
              </button>
            ))}
          </div>
        )}
        {s.state === 'error' && s.target && (
          <button type="button" onClick={() => act(api.reconnectMcp(s.name))}>
            重连
          </button>
        )}
        <button
          type="button"
          title="从配置里移除"
          onClick={() => act(api.removeMcp(s.name))}
        >
          移除
        </button>
      </span>
    </li>
  )

  return (
    <div className="ext-page">
      <h3 className="memory-heading">MCP 服务器</h3>
      <ul className="group memory-list">
        {data.mcp.length ? (
          data.mcp.map(server)
        ) : (
          <li className="memory-item muted">
            还没有。可以从 Cursor、Codex 等导入，或直接编辑配置文件。
          </li>
        )}
      </ul>
      <div className="ext-actions">
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
        <button type="button" onClick={() => api.revealMcp()}>
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
          title="从其他工具导入 MCP 服务器"
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
      <p className="caption">
        配置在 {data.mcpFile}（和 Claude Desktop
        同格式，可直接改）。新加的服务器默认「询问」：每次用它的工具先问你，审批时可以选「总是允许这个服务器」；完全访问模式下直接放行。MCP
        工具由服务器自己执行，不受 Familiar 的沙箱约束。
      </p>

      <h3 className="memory-heading">技能</h3>
      <ul className="group memory-list">
        {data.skills.length ? (
          data.skills.map((s) => {
            const on = !disabled.includes(s.name)
            return (
              <li key={s.path} className="ext-item">
                <div className="ext-main">
                  <span className="ext-title">
                    {s.name}
                    <small className="muted">
                      {s.source === 'shared' ? '~/.agents 共享' : '已导入'}
                    </small>
                  </span>
                  <span className="muted ext-sub" title={s.description}>
                    {s.description || '（没有描述）'}
                  </span>
                </div>
                <span className="row-actions">
                  <div className="segmented">
                    {[true, false].map((v) => (
                      <button
                        type="button"
                        key={String(v)}
                        className={on === v ? 'selected' : ''}
                        onClick={() =>
                          toggleSkill(s.name, v).catch((e: unknown) =>
                            setNotice(failure(e)),
                          )
                        }
                      >
                        {v ? '启用' : '停用'}
                      </button>
                    ))}
                  </div>
                  {s.source === 'imported' && (
                    <button
                      type="button"
                      onClick={() => act(api.removeSkill(s.path))}
                    >
                      删除
                    </button>
                  )}
                </span>
              </li>
            )
          })
        ) : (
          <li className="memory-item muted">还没有技能。</li>
        )}
      </ul>
      <div className="ext-actions">
        <button
          type="button"
          onClick={() =>
            api
              .skillCandidates()
              .then(setSkillOffer)
              .catch((e: unknown) => setNotice(failure(e)))
          }
        >
          从 Claude Code / Codex 导入…
        </button>
      </div>
      {skillOffer && (
        <Picker
          title="导入技能"
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
      <p className="caption">
        ~/.agents/skills 里的技能直接可用；从 Claude Code、Codex 导入的会复制到
        ~/Familiar/skills。模型平时只看到名字和描述，用到时才读完整说明。
      </p>
      <p role="status" className="caption">
        {notice}
      </p>
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
