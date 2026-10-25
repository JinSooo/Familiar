import { useEffect, useState, type FormEvent } from 'react'
import type { PetSkin, PublicSettings, SettingsUpdate } from '../../shared'
import { api } from '../api'

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
    name: '隐私',
    tile: '#5E5CE6',
    icon: 'M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z',
  },
]

export function SettingsView() {
  const [tab, setTab] = useState('模型')
  const [pets, setPets] = useState<PetSkin[]>([])
  const [settings, setSettings] = useState<PublicSettings>()
  const [key, setKey] = useState('')
  const [extraBody, setExtraBody] = useState('{}')
  const [notice, setNotice] = useState('')
  useEffect(() => {
    void api.listPets().then(setPets).catch(console.error)
    api
      .getSettings()
      .then((loaded) => {
        setSettings(loaded)
        setExtraBody(JSON.stringify(loaded.model.extraBody, null, 2))
      })
      .catch(() => setNotice('无法读取设置'))
  }, [])
  if (!settings) return <p role="status">{notice || '读取设置…'}</p>
  const model = <K extends keyof PublicSettings['model']>(
    field: K,
    value: PublicSettings['model'][K],
  ) =>
    setSettings({ ...settings, model: { ...settings.model, [field]: value } })
  async function save(event: FormEvent) {
    event.preventDefault()
    if (!settings) return
    let parsedExtraBody: Record<string, unknown>
    try {
      const parsed: unknown = JSON.parse(extraBody)
      if (
        parsed === null ||
        typeof parsed !== 'object' ||
        Array.isArray(parsed)
      )
        throw new Error('Expected object')
      parsedExtraBody = parsed as Record<string, unknown>
    } catch {
      setNotice('额外请求参数必须是有效的 JSON 对象。')
      return
    }
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { apiKeySet, ...publicModel } = settings.model
    const update: SettingsUpdate = {
      ...settings,
      model: {
        ...publicModel,
        extraBody: parsedExtraBody,
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
      <aside>
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
      <form className="settings" onSubmit={save}>
        <h2>{tab}</h2>
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
              value={settings.model.model}
              onChange={(e) => model('model', e.target.value)}
            />
          </label>
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
        </section>
        <h3 hidden={tab !== '模型'}>中转高级参数</h3>
        <section hidden={tab !== '模型'} className="group">
          <fieldset>
            <legend>自定义请求头</legend>
            {settings.model.headers.map((header, index) => (
              <div key={index}>
                <label>
                  <span className="visually-hidden">名称</span>
                  <input
                    placeholder="名称"
                    value={header.name}
                    onChange={(e) =>
                      model(
                        'headers',
                        settings.model.headers.map((row, i) =>
                          i === index ? { ...row, name: e.target.value } : row,
                        ),
                      )
                    }
                  />
                </label>
                <label>
                  <span className="visually-hidden">值</span>
                  <input
                    placeholder="值"
                    value={header.value}
                    onChange={(e) =>
                      model(
                        'headers',
                        settings.model.headers.map((row, i) =>
                          i === index ? { ...row, value: e.target.value } : row,
                        ),
                      )
                    }
                  />
                </label>
                <button
                  type="button"
                  className="icon"
                  aria-label="移除请求头"
                  onClick={() =>
                    model(
                      'headers',
                      settings.model.headers.filter((_, i) => i !== index),
                    )
                  }
                >
                  −
                </button>
              </div>
            ))}
            <button
              type="button"
              className="link"
              onClick={() =>
                model('headers', [
                  ...settings.model.headers,
                  { name: '', value: '' },
                ])
              }
            >
              ＋ 添加请求头
            </button>
          </fieldset>
          <label className="stacked">
            额外请求参数（JSON，合并进请求体）
            <textarea
              rows={3}
              value={extraBody}
              onChange={(e) => setExtraBody(e.target.value)}
              spellCheck={false}
            />
          </label>
        </section>
        <p hidden={tab !== '模型'} className="caption">
          请求头和参数会附加到每一次模型请求。认证方式只对 Anthropic 协议生效。
        </p>
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
          <details>
            <summary>目录规则 · {settings.dirRules.length}</summary>
            {settings.dirRules.length ? (
              settings.dirRules.map((rule, i) => (
                <p key={i}>
                  {rule.path} · {rule.access}
                </p>
              ))
            ) : (
              <p className="muted">暂无目录规则</p>
            )}
          </details>
        </section>
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
            className="link"
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
          </div>
          <p className="muted">
            跟随系统的「减少动态效果」，开启后宠物保持静止，气泡和胶囊不播放动效。
          </p>
        </section>
        <section hidden={tab !== '隐私'}>
          <p className="muted">即将到来</p>
        </section>
        <div className="form-actions" hidden={tab === '隐私'}>
          <p role="status">{notice}</p>
          <button className="primary" type="submit">
            保存
          </button>
        </div>
      </form>
    </div>
  )
}
