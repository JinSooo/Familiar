import { useEffect, useState, type FormEvent } from 'react'
import type {
  ModelDraft,
  PetSkin,
  PublicSettings,
  SettingsUpdate,
} from '../../shared'
import { api } from '../api'
import { MemoryPage } from './MemoryPage'
import { ExtensionsPage } from './ExtensionsPage'
import { ShortcutsSection } from './Shortcuts'

// Icon tiles mirror the System Settings sidebar.
const tabs = [
  {
    name: '模型',
    tile: '#0A84FF',
    icon: 'M12 2l3 7h7l-5.5 4.5L18 21l-6-4-6 4 1.5-7.5L2 9h7z',
  },
  {
    name: '权限',
    tile: '#8E8E93',
    icon: 'M5 11h14v10H5zM8 11V7a4 4 0 0 1 8 0v4',
  },
  {
    name: '宠物',
    tile: '#34A853',
    icon: 'M12 21c-4 0-7-2-7-5s3-6 7-6 7 3 7 6-3 5-7 5zM7 4v3M17 4v3',
  },
  {
    name: '快捷键',
    tile: '#636366',
    icon: 'M3 7h18v10H3zM7 11h.01M11 11h.01M15 11h.01M8 14h8',
  },
  {
    name: '扩展',
    tile: '#AF52DE',
    icon: 'M14 4a2 2 0 1 1 4 0v2h2v4h-2a2 2 0 1 0 0 4h2v4h-4v-2a2 2 0 1 0-4 0v2H6v-4H4a2 2 0 1 1 0-4h2V6h4V4z',
  },
  {
    name: '记忆',
    tile: '#FF9F0A',
    icon: 'M4 5a2 2 0 0 1 2-2h12v18H6a2 2 0 0 1-2-2zM4 17a2 2 0 0 1 2-2h12M8 7h6',
  },
  {
    name: '隐私',
    tile: '#5E5CE6',
    icon: 'M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z',
  },
]

const accessLabel = { allow: '允许', ask: '询问', deny: '禁止' } as const

export function SettingsView() {
  const [tab, setTab] = useState('模型')
  const [pets, setPets] = useState<PetSkin[]>([])
  const [settings, setSettings] = useState<PublicSettings>()
  const [key, setKey] = useState('')
  const [notice, setNotice] = useState('')
  const [clearing, setClearing] = useState(false)
  const [models, setModels] = useState<string[]>()
  const [probe, setProbe] = useState<{
    kind: 'busy' | 'ok' | 'error'
    text: string
  }>()
  useEffect(() => {
    void api.listPets().then(setPets).catch(console.error)
    api
      .getSettings()
      .then(setSettings)
      .catch(() => setNotice('无法读取设置'))
  }, [])
  // Rules are added from approval cards, so pick them up whenever the window comes back.
  useEffect(() => {
    const refresh = () => {
      void api
        .getSettings()
        .then((loaded) =>
          setSettings((s) => s && { ...s, dirRules: loaded.dirRules }),
        )
        .catch(console.error)
    }
    window.addEventListener('focus', refresh)
    return () => window.removeEventListener('focus', refresh)
  }, [])
  useEffect(() => {
    if (notice !== '已保存') return
    const timer = setTimeout(() => setNotice(''), 2000)
    return () => clearTimeout(timer)
  }, [notice])
  if (!settings) return <p role="status">{notice || '读取设置…'}</p>
  const model = <K extends keyof PublicSettings['model']>(
    field: K,
    value: PublicSettings['model'][K],
  ) => {
    setSettings({ ...settings, model: { ...settings.model, [field]: value } })
    // A result for different settings would mislead; the list stays useful while picking.
    setProbe(undefined)
    if (field !== 'model') setModels(undefined)
  }
  // What is on screen, unsaved; no key typed means the saved one.
  const draft = (): ModelDraft => {
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { apiKeySet, ...rest } = settings.model
    return { ...rest, ...(key ? { apiKey: key } : {}) }
  }
  const failure = (e: unknown) =>
    typeof e === 'string' ? e : e instanceof Error ? e.message : '请求失败'
  // Busy buttons stay focusable (aria-disabled) so keyboard focus is not dropped mid-request.
  const fetchModels = () => {
    if (probe?.kind === 'busy') return
    setProbe({ kind: 'busy', text: '正在获取模型列表…' })
    api
      .listModels(draft())
      .then((ids) => {
        setModels(ids)
        setProbe({
          kind: 'ok',
          text: ids.length
            ? `已获取 ${ids.length} 个模型，在「模型名称」里输入可以筛选。`
            : '中转站返回的模型列表是空的。',
        })
      })
      .catch((e: unknown) => setProbe({ kind: 'error', text: failure(e) }))
  }
  const testConnection = () => {
    if (probe?.kind === 'busy') return
    setProbe({
      kind: 'busy',
      text: `正在用 ${settings.model.model || '…'} 发一条测试消息…`,
    })
    api
      .testModel(draft())
      .then(({ ms, reply }) =>
        setProbe({
          kind: 'ok',
          text: `已连通：${(ms / 1000).toFixed(1)} 秒收到回复${reply ? `「${reply}」` : ''}。`,
        }),
      )
      .catch((e: unknown) => setProbe({ kind: 'error', text: failure(e) }))
  }
  const missingModel =
    models?.length && settings.model.model.trim()
      ? !models.includes(settings.model.model.trim())
      : false
  async function save(event: FormEvent) {
    event.preventDefault()
    if (!settings) return
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { apiKeySet, ...publicModel } = settings.model
    const update: SettingsUpdate = {
      ...settings,
      model: {
        ...publicModel,
        ...(key ? { apiKey: key } : {}),
      },
    }
    try {
      setSettings(await api.saveSettings(update))
      setKey('')
      setNotice('已保存')
    } catch {
      setNotice('保存失败，请检查设置或钥匙串是否可用。')
    }
  }
  return (
    <div className="settings-shell">
      <aside data-tauri-drag-region="deep">
        {tabs.map(({ name, tile, icon }) => (
          <button
            key={name}
            className={tab === name ? 'selected' : ''}
            onClick={() => setTab(name)}
          >
            <span className="tile" style={{ background: tile }}>
              <svg
                width="12"
                height="12"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2.4"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
              >
                <path d={icon} />
              </svg>
            </span>
            {name}
          </button>
        ))}
      </aside>
      <div className="settings-main">
        <header className="settings-title" data-tauri-drag-region="deep">
          <h2>{tab}</h2>
        </header>
        {tab === '记忆' && (
          <div className="settings">
            <MemoryPage />
          </div>
        )}
        {tab === '扩展' && (
          <div className="settings">
            <ExtensionsPage />
          </div>
        )}
        <form
          className="settings"
          hidden={tab === '记忆' || tab === '扩展'}
          onSubmit={save}
        >
          <section hidden={tab !== '快捷键'}>
            <ShortcutsSection
              value={settings.shortcuts}
              onChange={(shortcuts) => setSettings({ ...settings, shortcuts })}
            />
          </section>
          <section hidden={tab !== '模型'} className="group">
            <label>
              模型协议
              <select
                value={settings.model.protocol}
                onChange={(e) =>
                  model(
                    'protocol',
                    e.target.value as PublicSettings['model']['protocol'],
                  )
                }
              >
                <option value="openai-compatible">OpenAI Compatible</option>
                <option value="openai-responses">OpenAI Responses</option>
                <option value="anthropic">Anthropic Messages</option>
              </select>
            </label>
            <label>
              Base URL
              <input
                value={settings.model.baseURL}
                placeholder="https://api.example.com/v1"
                onChange={(e) => model('baseURL', e.target.value)}
              />
            </label>
            <label>
              模型名称
              <input
                list="model-options"
                value={settings.model.model}
                placeholder={models ? '输入筛选或选择' : '例如 gpt-6.1-sol'}
                onChange={(e) => model('model', e.target.value)}
              />
            </label>
            <label>
              后台小模型
              <input
                list="model-options"
                value={settings.model.smallModel}
                placeholder="留空则用上面的模型"
                onChange={(e) => model('smallModel', e.target.value)}
              />
            </label>
            <datalist id="model-options">
              {models?.map((id) => (
                <option key={id} value={id} />
              ))}
            </datalist>
            <label>
              API Key
              <input
                type="password"
                autoComplete="new-password"
                placeholder={
                  settings.model.apiKeySet ? '已保存在钥匙串' : '尚未设置'
                }
                value={key}
                onChange={(e) => setKey(e.target.value)}
              />
            </label>
            {settings.model.protocol === 'anthropic' && (
              <label>
                认证方式
                <select
                  value={settings.model.authStyle}
                  onChange={(e) =>
                    model(
                      'authStyle',
                      e.target.value as PublicSettings['model']['authStyle'],
                    )
                  }
                >
                  <option value="x-api-key">x-api-key</option>
                  <option value="bearer">Bearer</option>
                </select>
              </label>
            )}
            <div className="setting-row">
              <span>连接</span>
              <span className="row-actions">
                <button
                  type="button"
                  aria-disabled={probe?.kind === 'busy'}
                  onClick={fetchModels}
                >
                  获取模型列表
                </button>
                <button
                  type="button"
                  aria-disabled={probe?.kind === 'busy'}
                  disabled={!settings.model.model.trim()}
                  onClick={testConnection}
                >
                  测试连接
                </button>
              </span>
            </div>
          </section>
          {tab === '模型' && missingModel && (
            <p className="caption probe warn">
              模型列表里没有「{settings.model.model.trim()}
              」，你的账号可能用不了它。
            </p>
          )}
          {tab === '模型' && (
            <p className="caption">
              「后台小模型」用来整理记忆，走同一个地址和
              Key；可以填更便宜的模型。
            </p>
          )}
          {tab === '模型' && probe && (
            <p
              className={`caption probe ${probe.kind === 'error' ? 'failed' : probe.kind === 'ok' ? 'passed' : ''}`}
              role="status"
            >
              {probe.text}
            </p>
          )}
          <section hidden={tab !== '权限'} className="group">
            <label>
              权限模式
              <select
                value={settings.permissionMode}
                onChange={(e) =>
                  setSettings({
                    ...settings,
                    permissionMode: e.target
                      .value as PublicSettings['permissionMode'],
                  })
                }
              >
                <option value="ask">询问</option>
                <option value="auto">自动</option>
                <option value="full">完全访问</option>
              </select>
            </label>
            <label>
              工作目录
              <input
                required
                value={settings.workspacePath}
                onChange={(e) =>
                  setSettings({ ...settings, workspacePath: e.target.value })
                }
              />
            </label>
            <div className="setting-row">
              <span>自动快照</span>
              <div className="segmented">
                {([true, false] as const).map((on) => (
                  <button
                    type="button"
                    key={String(on)}
                    className={
                      settings.workspaceSnapshots === on ? 'selected' : ''
                    }
                    onClick={() =>
                      setSettings({ ...settings, workspaceSnapshots: on })
                    }
                  >
                    {on ? '开' : '关'}
                  </button>
                ))}
              </div>
            </div>
            <details className="rules">
              <summary>
                目录规则
                <span className="muted">
                  {settings.dirRules.length
                    ? `${settings.dirRules.length} 条`
                    : '无'}
                </span>
              </summary>
              {settings.dirRules.length ? (
                <ul>
                  {settings.dirRules.map((rule, i) => (
                    <li key={i}>
                      <span>{rule.path}</span>
                      <span className="muted">{accessLabel[rule.access]}</span>
                      <button
                        type="button"
                        className="icon rule-remove"
                        aria-label={`删除规则 ${rule.path}`}
                        title="删除这条规则（立即生效）"
                        onClick={() => {
                          api
                            .removeDirRule(rule.path)
                            .then((dirRules) =>
                              setSettings((s) => s && { ...s, dirRules }),
                            )
                            .catch(() => setNotice('删除规则失败'))
                        }}
                      >
                        ×
                      </button>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="muted">
                  还没有目录规则。对话中批准访问某个目录时选「总是允许这个目录」，会记在这里。
                </p>
              )}
            </details>
          </section>
          {tab === '权限' && (
            <p className="caption">
              自动快照：Familiar 每次改动工作目录后用 git
              提交一次，改错、删错能回滚。关掉后不再提交，已有的 .git
              原样保留。配置在 ~/.familiar，不在工作目录里，不受快照影响。
            </p>
          )}
          <section hidden={tab !== '宠物'}>
            <div className="pet-grid">
              {pets.map((p) => (
                <button
                  type="button"
                  className={`pet-card ${p.id === settings.pet.id ? 'selected' : ''}`}
                  key={p.id}
                  onClick={() =>
                    setSettings({
                      ...settings,
                      pet: { ...settings.pet, id: p.id },
                    })
                  }
                >
                  <span
                    className="skin-preview"
                    style={{
                      backgroundImage: `url("${p.spritesheetUrl}")`,
                      backgroundSize: `768px ${p.version === 1 ? 936 : 1144}px`,
                    }}
                  />
                  <span>{p.displayName}</span>
                </button>
              ))}
            </div>
            <button
              type="button"
              className="link import"
              onClick={() => {
                void api
                  .importCodexPets()
                  .then(setPets)
                  .catch(() => setNotice('导入失败'))
              }}
            >
              从 ChatGPT 导入…
            </button>
            <div className="group">
              <label>
                名字
                <input
                  required
                  maxLength={40}
                  value={settings.pet.name}
                  onChange={(e) =>
                    setSettings({
                      ...settings,
                      pet: { ...settings.pet, name: e.target.value },
                    })
                  }
                />
              </label>
              <div className="setting-row">
                <span>大小</span>
                <div className="segmented">
                  {(['small', 'medium', 'large'] as const).map((size, i) => (
                    <button
                      type="button"
                      key={size}
                      className={settings.pet.size === size ? 'selected' : ''}
                      onClick={() =>
                        setSettings({
                          ...settings,
                          pet: { ...settings.pet, size },
                        })
                      }
                    >
                      {['小', '中', '大'][i]}
                    </button>
                  ))}
                </div>
              </div>
              <div className="setting-row">
                <span>动作快慢</span>
                <div className="segmented">
                  {(['slow', 'normal', 'fast'] as const).map((speed, i) => (
                    <button
                      type="button"
                      key={speed}
                      className={settings.pet.speed === speed ? 'selected' : ''}
                      onClick={() =>
                        setSettings({
                          ...settings,
                          pet: { ...settings.pet, speed },
                        })
                      }
                    >
                      {['慢', '正常', '快'][i]}
                    </button>
                  ))}
                </div>
              </div>
              <div className="setting-row">
                <span>点击别处时</span>
                <div className="segmented">
                  {([true, false] as const).map((hide) => (
                    <button
                      type="button"
                      key={String(hide)}
                      className={
                        settings.chatAutoHide === hide ? 'selected' : ''
                      }
                      onClick={() =>
                        setSettings({ ...settings, chatAutoHide: hide })
                      }
                    >
                      {hide ? '自动收起' : '保持显示'}
                    </button>
                  ))}
                </div>
              </div>
            </div>
            <p className="caption">
              「自动收起」：点到其他应用后，聊天面板和胶囊一起收起，只留宠物；等你允许或输入框里有没发出的字时不收。聊天面板里按
              Esc 也能一步收起。
              <br />
              跟随系统的「减少动态效果」，开启后宠物保持静止，气泡和胶囊不播放动效。
            </p>
          </section>
          <section hidden={tab !== '隐私'}>
            <div className="group">
              <div className="setting-row">
                <span>对话记录</span>
                <button
                  type="button"
                  className="link"
                  onClick={() => api.revealConversations()}
                >
                  ~/Familiar/conversations
                </button>
              </div>
              <div className="setting-row">
                <span>清空全部对话</span>
                {clearing ? (
                  <span className="row-actions">
                    <button
                      type="button"
                      className="danger"
                      onClick={() => {
                        setClearing(false)
                        api
                          .clearConversations()
                          .then(() => setNotice('对话已移到废纸篓'))
                          .catch((e: unknown) =>
                            setNotice(
                              typeof e === 'string' ? e : '清空失败，请重试',
                            ),
                          )
                      }}
                    >
                      移到废纸篓
                    </button>
                    <button type="button" onClick={() => setClearing(false)}>
                      取消
                    </button>
                  </span>
                ) : (
                  <button type="button" onClick={() => setClearing(true)}>
                    清空…
                  </button>
                )}
              </div>
            </div>
            <p className="caption">
              每个对话是一个 Markdown
              文件，可以直接打开阅读。删除和清空都会移到废纸篓，可以恢复。
            </p>
            <p role="status" className="caption">
              {notice}
            </p>
          </section>
          <div className="form-actions" hidden={tab === '隐私'}>
            <p role="status">{notice}</p>
            <button className="primary" type="submit">
              保存
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}
