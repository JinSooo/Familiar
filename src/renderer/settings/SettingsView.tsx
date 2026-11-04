import { useEffect, useRef, useState } from 'react'
import type {
  ChatGptStatus,
  ModelDraft,
  PetSkin,
  PublicSettings,
} from '../../shared'
import { api } from '../api'
import {
  petRatePresets,
  petRateRange,
  petScalePresets,
  petScaleRange,
} from '../../shared'
import { openUrl } from '@tauri-apps/plugin-opener'
import { invoke } from '@tauri-apps/api/core'
import { MemoryPage } from './MemoryPage'
import { ExtensionsPage } from './ExtensionsPage'
import { PerceptionPage } from './PerceptionPage'
import { TimelinePage } from './TimelinePage'
import { ProactivePage } from './ProactivePage'
import { ShortcutsSection } from './Shortcuts'
import { Switch } from './Switch'
import { presetOf, providerPresets } from '../../shared/presets'

type Page =
  | 'general'
  | 'pet'
  | 'shortcuts'
  | 'model'
  | 'permissions'
  | 'proactive'
  | 'memory'
  | 'topics'
  | 'pending'
  | 'timeline'
  | 'capture'
  | 'raw'
  | 'mcp'
  | 'skills'
  | 'privacy'
interface NavItem {
  page: Page
  name: string
  icon?: string
}
interface NavGroup {
  name: string
  icon: string
  children: NavItem[]
}
/** Single-color line icons on a 24px grid, drawn at 16px. */
const icons = {
  general: 'M4 7h10M18 7h2M4 17h2M10 17h10M14 4v6M6 14v6',
  pet: 'M5 9V4l4 3h6l4-3v5c0 6-3 10-7 10S5 15 5 9zM9.5 12h.01M14.5 12h.01M11 15h2',
  keyboard: 'M3 6h18v12H3zM7 10h.01M11 10h.01M15 10h.01M8 14h8',
  model: 'M12 3l8 4.5v9L12 21l-8-4.5v-9zM12 12l8-4.5M12 12v9M12 12L4 7.5',
  shield: 'M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z',
  memory:
    'M9 4a3 3 0 0 0-3 3 3 3 0 0 0-2 5 3 3 0 0 0 2 5 3 3 0 0 0 6 1V5a2 2 0 0 0-3-1zM15 4a3 3 0 0 1 3 3 3 3 0 0 1 2 5 3 3 0 0 1-2 5 3 3 0 0 1-6 1',
  perception:
    'M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12zM12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z',
  puzzle:
    'M14 4a2 2 0 1 1 4 0v2h2v4h-2a2 2 0 1 0 0 4h2v4h-4v-2a2 2 0 1 0-4 0v2H6v-4H4a2 2 0 1 1 0-4h2V6h4V4z',
  lock: 'M5 11h14v10H5zM8 11V7a4 4 0 0 1 8 0v4',
  bell: 'M6 16V11a6 6 0 0 1 12 0v5l2 2H4zM10 20a2 2 0 0 0 4 0',
  chevron: 'M9 6l6 6-6 6',
}
const nav: (NavItem | NavGroup)[] = [
  { page: 'general', name: '通用', icon: icons.general },
  { page: 'pet', name: '宠物', icon: icons.pet },
  { page: 'shortcuts', name: '快捷键', icon: icons.keyboard },
  { page: 'model', name: '模型', icon: icons.model },
  { page: 'permissions', name: '权限', icon: icons.shield },
  { page: 'proactive', name: '主动', icon: icons.bell },
  {
    name: '记忆',
    icon: icons.memory,
    children: [
      { page: 'memory', name: '画像与习惯' },
      { page: 'topics', name: '主题' },
      { page: 'pending', name: '待确认' },
    ],
  },
  {
    name: '感知',
    icon: icons.perception,
    children: [
      { page: 'timeline', name: '时间线' },
      { page: 'capture', name: '采集设置' },
      { page: 'raw', name: '原始记录' },
    ],
  },
  {
    name: '扩展',
    icon: icons.puzzle,
    children: [
      { page: 'mcp', name: 'MCP 服务器' },
      { page: 'skills', name: '技能' },
    ],
  },
  { page: 'privacy', name: '对话与隐私', icon: icons.lock },
]
const groupOf = (page: Page) =>
  nav.find((n) => 'children' in n && n.children.some((c) => c.page === page))
    ?.name
const titleOf = (page: Page): string[] => {
  for (const n of nav)
    if ('children' in n) {
      const c = n.children.find((c) => c.page === page)
      if (c) return [n.name, c.name]
    } else if (n.page === page) return [n.name]
  return []
}
/** Pages that edit the settings form; every change there saves on its own. */
const formPages: Page[] = [
  'general',
  'pet',
  'shortcuts',
  'model',
  'permissions',
  'proactive',
  'privacy',
]
/** How long typing pauses before a text field saves. */
const typingDelay = 600

function Glyph({ d, size = 16 }: { d: string; size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d={d} />
    </svg>
  )
}

const size = (bytes: number) =>
  bytes < 1024 * 1024
    ? `${Math.max(1, Math.round(bytes / 1024))} KB`
    : bytes < 1024 ** 3
      ? `${(bytes / 1024 / 1024).toFixed(1)} MB`
      : `${(bytes / 1024 ** 3).toFixed(2)} GB`

const accessLabel = { allow: '允许', ask: '询问', deny: '禁止' } as const

export function SettingsView() {
  const [tab, setTab] = useState<Page>('general')
  /** Expanded sidebar groups; the one holding the open page always shows. */
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [pets, setPets] = useState<PetSkin[]>([])
  const [settings, setSettings] = useState<PublicSettings>()
  const [key, setKey] = useState('')
  const [imageKey, setImageKey] = useState('')
  const [notice, setNotice] = useState('')
  const [promptCopied, setPromptCopied] = useState(false)
  const [importNote, setImportNote] = useState('')
  const [confirming, setConfirming] = useState('')
  const [clearing, setClearing] = useState(false)
  const [models, setModels] = useState<string[]>()
  const [chatgpt, setChatgpt] = useState<ChatGptStatus>()
  const [loginItem, setLoginItem] = useState<'on' | 'off' | 'approval'>('off')
  const [dataInfo, setDataInfo] = useState<{ path: string; bytes: number }>()
  /** The relay last saved, so picking 自定义中转 again brings its address back. */
  const [savedRelay, setSavedRelay] =
    useState<Pick<PublicSettings['model'], 'protocol' | 'baseURL'>>()
  const [signingIn, setSigningIn] = useState(false)
  const [probe, setProbe] = useState<{
    kind: 'busy' | 'ok' | 'error'
    text: string
  }>()
  useEffect(() => {
    void api.listPets().then(setPets).catch(console.error)
    api
      .getSettings()
      .then((loaded) => {
        setSettings(loaded)
        if (loaded.model.protocol !== 'chatgpt' && !presetOf(loaded.model))
          setSavedRelay(loaded.model)
      })
      .catch(() => setNotice('无法读取设置'))
  }, [])
  // The ChatGPT account is read when the form first needs it and after sign-in or sign-out.
  useEffect(() => {
    if (settings?.model.protocol === 'chatgpt')
      api.chatgptStatus().then(setChatgpt).catch(console.error)
  }, [settings?.model.protocol])
  // Login item and data size belong to the 通用 page; read them when it opens.
  useEffect(() => {
    if (tab !== 'general') return
    void invoke<'on' | 'off' | 'approval'>('login_item')
      .then(setLoginItem)
      .catch(console.error)
    void api.dataInfo().then(setDataInfo).catch(console.error)
  }, [tab])
  // The menu bar panel can ask for a page.
  useEffect(() => api.onSettingsPage((page) => setTab(page)), [])
  // Rules are added from approval cards, so pick them up whenever the window comes back.
  useEffect(() => {
    const refresh = () => {
      // A pet made in Codex or Claude Code shows up when the user comes back.
      void api.listPets().then(setPets).catch(console.error)
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
    if (notice !== '对话已移到废纸篓') return
    const timer = setTimeout(() => setNotice(''), 2000)
    return () => clearTimeout(timer)
  }, [notice])
  /** A text field's save waiting for typing to pause; leaving the window saves it at once. */
  const typing = useRef<{
    timer: ReturnType<typeof setTimeout>
    run: () => void
  }>(undefined)
  const flush = () => {
    const pending = typing.current
    typing.current = undefined
    if (!pending) return
    clearTimeout(pending.timer)
    pending.run()
  }
  useEffect(() => {
    window.addEventListener('blur', flush)
    return () => window.removeEventListener('blur', flush)
  }, [])
  if (!settings) return <p role="status">{notice || '读取设置…'}</p>
  /** Saves what is on screen; keys only when given, so a half-typed one never reaches the keychain. */
  async function persist(
    next: PublicSettings,
    keys: { apiKey?: string; imageKey?: string } = {},
  ) {
    // Required fields wait until they are filled in again.
    if (!next.pet.name.trim() || !next.workspacePath.trim()) return
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { apiKeySet, ...publicModel } = next.model
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { apiKeySet: imageKeySet, ...publicImage } = next.imageModel
    try {
      const saved = await api.saveSettings({
        ...next,
        model: {
          ...publicModel,
          ...(keys.apiKey ? { apiKey: keys.apiKey } : {}),
        },
        imageModel: {
          ...publicImage,
          ...(keys.imageKey ? { apiKey: keys.imageKey } : {}),
        },
      })
      // Only the key flags come back: anything typed while saving stays on screen.
      setSettings(
        (s) =>
          s && {
            ...s,
            model: { ...s.model, apiKeySet: saved.model.apiKeySet },
            imageModel: {
              ...s.imageModel,
              apiKeySet: saved.imageModel.apiKeySet,
            },
          },
      )
      if (saved.model.protocol !== 'chatgpt' && !presetOf(saved.model))
        setSavedRelay(saved.model)
      if (keys.apiKey) setKey('')
      if (keys.imageKey) setImageKey('')
      setNotice('')
    } catch {
      setNotice('保存失败，请检查设置或钥匙串是否可用。')
    }
  }
  /** Shows a change and saves it: right away for a pick, after a pause for typing. */
  const change = (next: PublicSettings, wait = 0) => {
    setSettings(next)
    clearTimeout(typing.current?.timer)
    typing.current = undefined
    const run = () => void persist(next)
    if (!wait) return run()
    typing.current = { timer: setTimeout(flush, wait), run }
  }
  const saveKeys = () => {
    if (key || imageKey) void persist(settings, { apiKey: key, imageKey })
  }
  const model = <K extends keyof PublicSettings['model']>(
    field: K,
    value: PublicSettings['model'][K],
  ) => {
    change(
      { ...settings, model: { ...settings.model, [field]: value } },
      field === 'baseURL' || field === 'model' || field === 'smallModel'
        ? typingDelay
        : 0,
    )
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
  /** The service the form is on: a preset when protocol and address match one, else a relay. */
  const viaChatGpt = settings.model.protocol === 'chatgpt'
  const preset = viaChatGpt ? undefined : presetOf(settings.model)
  const pickProvider = (id: string) => {
    if (id === 'chatgpt') {
      change({
        ...settings,
        model: { ...settings.model, protocol: 'chatgpt', baseURL: '' },
      })
      setProbe(undefined)
      setModels(undefined)
      return
    }
    const next = providerPresets.find((p) => p.id === id)
    change({
      ...settings,
      model: {
        ...settings.model,
        // A custom relay gets back the one last saved; the ChatGPT route has no relay protocol.
        protocol:
          next?.protocol ??
          savedRelay?.protocol ??
          (settings.model.protocol === 'chatgpt'
            ? 'openai-compatible'
            : settings.model.protocol),
        baseURL: next?.baseURL ?? savedRelay?.baseURL ?? '',
        ...(next ? { authStyle: 'x-api-key' as const } : {}),
      },
    })
    setProbe(undefined)
    setModels(undefined)
  }
  const chatGptSignIn = () => {
    setSigningIn(true)
    api
      .chatgptSignIn()
      .then(setChatgpt)
      .catch((e: unknown) => {
        // Cancelling is the user's choice, not a failure.
        if (failure(e) !== '登录已取消')
          setProbe({ kind: 'error', text: failure(e) })
      })
      .finally(() => setSigningIn(false))
  }
  const chatGptSignOut = () => {
    api
      .chatgptSignOut()
      .then(() => setChatgpt({ signedIn: false }))
      .catch((e: unknown) => setProbe({ kind: 'error', text: failure(e) }))
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
  return (
    <div className="settings-shell">
      <aside data-tauri-drag-region="deep">
        <nav aria-label="设置">
          {nav.map((n) => {
            if (!('children' in n))
              return (
                <button
                  key={n.page}
                  className={`nav-item ${tab === n.page ? 'selected' : ''}`}
                  aria-current={tab === n.page ? 'page' : undefined}
                  onClick={() => setTab(n.page)}
                >
                  <Glyph d={n.icon!} />
                  {n.name}
                </button>
              )
            const open = expanded.has(n.name) || groupOf(tab) === n.name
            return (
              <div key={n.name} className="nav-group">
                <button
                  className="nav-item"
                  aria-expanded={open}
                  onClick={() => {
                    // Opening a group also opens its first page; closing just folds it.
                    const next = new Set(expanded)
                    if (open && groupOf(tab) !== n.name) next.delete(n.name)
                    else if (!open) {
                      next.add(n.name)
                      setTab(n.children[0]!.page)
                    } else next.delete(n.name)
                    setExpanded(next)
                  }}
                >
                  <Glyph d={n.icon} />
                  {n.name}
                  <span className={`nav-chevron ${open ? 'open' : ''}`}>
                    <Glyph d={icons.chevron} size={12} />
                  </span>
                </button>
                {open && (
                  <div className="nav-children">
                    {n.children.map((c) => (
                      <button
                        key={c.page}
                        className={`nav-item child ${tab === c.page ? 'selected' : ''}`}
                        aria-current={tab === c.page ? 'page' : undefined}
                        onClick={() => setTab(c.page)}
                      >
                        {c.name}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            )
          })}
        </nav>
      </aside>
      <div className="settings-main">
        <header className="settings-title" data-tauri-drag-region="deep">
          {titleOf(tab).length > 1 && (
            <span className="crumb">{titleOf(tab)[0]}</span>
          )}
          <h2>{titleOf(tab).at(-1)}</h2>
        </header>
        {(tab === 'memory' || tab === 'topics' || tab === 'pending') && (
          <div className="settings">
            <MemoryPage
              section={
                tab === 'memory'
                  ? 'kept'
                  : tab === 'topics'
                    ? 'topics'
                    : 'pending'
              }
            />
          </div>
        )}
        {tab === 'timeline' && (
          <div className="settings">
            <TimelinePage />
          </div>
        )}
        {(tab === 'capture' || tab === 'raw') && (
          <div className="settings">
            <PerceptionPage section={tab} />
          </div>
        )}
        {(tab === 'mcp' || tab === 'skills') && (
          <div className="settings">
            <ExtensionsPage section={tab} />
          </div>
        )}
        <form
          className="settings"
          hidden={!formPages.includes(tab)}
          onSubmit={(e) => {
            // Return in a field saves it now instead of after the pause.
            e.preventDefault()
            clearTimeout(typing.current?.timer)
            typing.current = undefined
            void persist(settings, { apiKey: key, imageKey })
          }}
        >
          <section hidden={tab !== 'general'}>
            <div className="group">
              <div className="setting-row">
                <div className="ch-label">
                  <span>开机时打开 Familiar</span>
                  {loginItem === 'approval' && (
                    <span className="warn">
                      需要在系统设置 › 通用 › 登录项里允许
                    </span>
                  )}
                </div>
                <Switch
                  on={loginItem !== 'off'}
                  label="开机时打开 Familiar"
                  onChange={(on) =>
                    void invoke<'on' | 'off' | 'approval'>('set_login_item', {
                      on,
                    })
                      .then(setLoginItem)
                      .catch((e: unknown) => setNotice(failure(e)))
                  }
                />
              </div>
              <div className="setting-row">
                <span title="关掉后启动时只有菜单栏图标，用快捷键或菜单叫出宠物">
                  启动时显示宠物
                </span>
                <Switch
                  on={settings.showPetOnLaunch}
                  label="启动时显示宠物"
                  onChange={(on) =>
                    change({ ...settings, showPetOnLaunch: on })
                  }
                />
              </div>
              <div className="setting-row">
                <span title="等你允许或输入框里有草稿时不收；面板里按 Esc 也能收起">
                  点击别处时
                </span>
                <div className="segmented">
                  {([true, false] as const).map((hide) => (
                    <button
                      type="button"
                      key={String(hide)}
                      className={
                        settings.chatAutoHide === hide ? 'selected' : ''
                      }
                      onClick={() =>
                        change({ ...settings, chatAutoHide: hide })
                      }
                    >
                      {hide ? '自动收起' : '保持显示'}
                    </button>
                  ))}
                </div>
              </div>
              <div className="setting-row">
                <span title="从 Finder 拖文件进来要先离开它，所以默认保持；有草稿或正在回复时不收，按 Esc 也能收起">
                  快捷问答条点击别处时
                </span>
                <div className="segmented">
                  {([true, false] as const).map((hide) => (
                    <button
                      type="button"
                      key={String(hide)}
                      className={
                        settings.quickAutoHide === hide ? 'selected' : ''
                      }
                      onClick={() =>
                        change({ ...settings, quickAutoHide: hide })
                      }
                    >
                      {hide ? '自动收起' : '保持显示'}
                    </button>
                  ))}
                </div>
              </div>
            </div>
            <h3 className="memory-heading">透明度</h3>
            <div className="group">
              <div className="setting-row">
                <span>聊天面板和菜单栏</span>
                <input
                  type="range"
                  min={50}
                  max={100}
                  step={5}
                  aria-label="聊天面板和菜单栏"
                  value={Math.round(settings.panelOpacity * 100)}
                  onChange={(e) =>
                    change({
                      ...settings,
                      panelOpacity: Number(e.target.value) / 100,
                    })
                  }
                />
              </div>
              <div className="setting-row">
                <span>设置和大窗口</span>
                <input
                  type="range"
                  min={50}
                  max={100}
                  step={5}
                  aria-label="设置和大窗口"
                  value={Math.round(settings.windowOpacity * 100)}
                  onChange={(e) =>
                    change({
                      ...settings,
                      windowOpacity: Number(e.target.value) / 100,
                    })
                  }
                />
              </div>
            </div>
            <h3 className="memory-heading">数据</h3>
            <div className="group">
              <div className="setting-row">
                <div className="ch-label">
                  <span>数据目录</span>
                  <span className="muted">
                    {dataInfo
                      ? `${dataInfo.path.replace(/^\/Users\/[^/]+/, '~')} · ${size(dataInfo.bytes)}`
                      : '读取中…'}
                  </span>
                </div>
                <button type="button" onClick={() => api.revealData()}>
                  在 Finder 中打开
                </button>
              </div>
            </div>
          </section>
          <section hidden={tab !== 'proactive'}>
            <ProactivePage
              value={settings.proactive}
              onChange={(proactive) => change({ ...settings, proactive })}
            />
          </section>
          <section hidden={tab !== 'shortcuts'}>
            <ShortcutsSection
              value={settings.shortcuts}
              onChange={(shortcuts) => change({ ...settings, shortcuts })}
            />
          </section>
          <section hidden={tab !== 'model'} className="group">
            <label>
              服务商
              <select
                value={viaChatGpt ? 'chatgpt' : (preset?.id ?? 'custom')}
                onChange={(e) => pickProvider(e.target.value)}
              >
                {providerPresets.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
                <option value="chatgpt">ChatGPT 登录</option>
                <option value="custom">自定义中转</option>
              </select>
            </label>
            {!preset && !viaChatGpt && (
              <>
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
              </>
            )}
            {viaChatGpt && (
              <div className="setting-row">
                <div className="ch-label">
                  <span>使用你的 ChatGPT 套餐</span>
                  <span
                    className={
                      chatgpt?.signedIn && chatgpt.planUsage === false
                        ? 'warn'
                        : 'muted'
                    }
                  >
                    {signingIn
                      ? '在浏览器里完成登录…'
                      : chatgpt?.signedIn
                        ? `${chatgpt.email || '已登录'}${chatgpt.planUsage === false ? ' · 没有授权使用套餐额度，请重新登录并同意' : ''}`
                        : '未登录'}
                  </span>
                </div>
                <span className="row-actions">
                  {chatgpt?.signedIn && !signingIn && (
                    <button
                      type="button"
                      className="link"
                      onClick={() =>
                        void openUrl('https://chatgpt.com/settings/usage')
                      }
                    >
                      管理用量
                    </button>
                  )}
                  {signingIn ? (
                    <button type="button" onClick={() => api.chatgptCancel()}>
                      取消
                    </button>
                  ) : (
                    <button type="button" onClick={chatGptSignIn}>
                      {chatgpt?.signedIn ? '重新登录' : '使用 ChatGPT 登录'}
                    </button>
                  )}
                  {chatgpt?.signedIn && !signingIn && (
                    <button type="button" onClick={chatGptSignOut}>
                      退出
                    </button>
                  )}
                </span>
              </div>
            )}
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
                placeholder="留空则用对话模型，可以填更便宜的"
                onChange={(e) => model('smallModel', e.target.value)}
              />
            </label>
            <datalist id="model-options">
              {models?.map((id) => (
                <option key={id} value={id} />
              ))}
            </datalist>
            {!viaChatGpt && (
              <label>
                <span>
                  API Key
                  {preset && (
                    <button
                      type="button"
                      className="link key-link"
                      onClick={() => void openUrl(preset.keyURL)}
                    >
                      获取 Key
                    </button>
                  )}
                </span>
                <input
                  type="password"
                  autoComplete="new-password"
                  placeholder={
                    settings.model.apiKeySet ? '已保存在钥匙串' : '尚未设置'
                  }
                  value={key}
                  onChange={(e) => setKey(e.target.value)}
                  onBlur={saveKeys}
                />
              </label>
            )}
            {!preset &&
              !viaChatGpt &&
              settings.model.protocol === 'anthropic' && (
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
                {!viaChatGpt && (
                  <button
                    type="button"
                    aria-disabled={probe?.kind === 'busy'}
                    onClick={fetchModels}
                  >
                    获取模型列表
                  </button>
                )}
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
          <section hidden={tab !== 'model'}>
            <h3 className="memory-heading">生图</h3>
            <div className="group">
              <label>
                生图模型
                <input
                  value={settings.imageModel.model}
                  placeholder="留空则不生图，例如 gpt-image-2"
                  onChange={(e) =>
                    change(
                      {
                        ...settings,
                        imageModel: {
                          ...settings.imageModel,
                          model: e.target.value,
                        },
                      },
                      typingDelay,
                    )
                  }
                />
              </label>
              <label>
                Base URL
                <input
                  value={settings.imageModel.baseURL}
                  placeholder="https://api.openai.com/v1"
                  onChange={(e) =>
                    change(
                      {
                        ...settings,
                        imageModel: {
                          ...settings.imageModel,
                          baseURL: e.target.value,
                        },
                      },
                      typingDelay,
                    )
                  }
                />
              </label>
              <label>
                API Key
                <input
                  type="password"
                  autoComplete="new-password"
                  placeholder={
                    settings.imageModel.apiKeySet
                      ? '已保存在钥匙串'
                      : '尚未设置'
                  }
                  value={imageKey}
                  onChange={(e) => setImageKey(e.target.value)}
                  onBlur={saveKeys}
                />
              </label>
            </div>
          </section>
          {tab === 'model' && missingModel && (
            <p className="caption probe warn">
              模型列表里没有「{settings.model.model.trim()}
              」，你的账号可能用不了它。
            </p>
          )}
          {tab === 'model' && probe && (
            <p
              className={`caption probe ${probe.kind === 'error' ? 'failed' : probe.kind === 'ok' ? 'passed' : ''}`}
              role="status"
            >
              {probe.text}
            </p>
          )}
          <section hidden={tab !== 'permissions'} className="group">
            <label>
              权限模式
              <select
                value={settings.permissionMode}
                onChange={(e) =>
                  change({
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
                  change(
                    { ...settings, workspacePath: e.target.value },
                    typingDelay,
                  )
                }
              />
            </label>
            <div className="setting-row">
              <span title="改动 ~/.familiar 里的工作目录、记忆、对话后用 git 记一次，改错删错能回滚">
                自动快照
              </span>
              <div className="segmented">
                {([true, false] as const).map((on) => (
                  <button
                    type="button"
                    key={String(on)}
                    className={
                      settings.workspaceSnapshots === on ? 'selected' : ''
                    }
                    onClick={() =>
                      change({ ...settings, workspaceSnapshots: on })
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
                <p className="muted">审批时选「总是允许这个目录」会记在这里</p>
              )}
            </details>
          </section>
          <section hidden={tab !== 'pet'}>
            <div className="pet-grid">
              {pets.map((p) => (
                <div className="pet-item" key={p.id}>
                  <button
                    type="button"
                    className={`pet-card ${p.id === settings.pet.id ? 'selected' : ''}`}
                    onClick={() =>
                      change({
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
                  {p.removable && (
                    <button
                      type="button"
                      className={`pet-delete ${confirming === p.id ? 'confirming' : ''}`}
                      title="移到废纸篓"
                      onClick={() => {
                        if (confirming !== p.id) {
                          setConfirming(p.id)
                          setTimeout(
                            () => setConfirming((c) => (c === p.id ? '' : c)),
                            3000,
                          )
                          return
                        }
                        setConfirming('')
                        void api
                          .deletePet(p.id)
                          .then(async (list) => {
                            setPets(list)
                            const loaded = await api.getSettings()
                            setSettings((s) => s && { ...s, pet: loaded.pet })
                          })
                          .catch(() => setNotice('删除失败'))
                      }}
                    >
                      {confirming === p.id ? '删除？' : '×'}
                    </button>
                  )}
                </div>
              ))}
            </div>
            <div className="pet-links">
              <button
                type="button"
                className="link"
                onClick={() => {
                  void api
                    .importCodexPets()
                    .then((list) => {
                      const added = list.length - pets.length
                      setImportNote(
                        added > 0 ? `导入了 ${added} 个` : '没有新的可导入',
                      )
                      setTimeout(() => setImportNote(''), 3000)
                      setPets(list)
                    })
                    .catch(() => setNotice('导入失败'))
                }}
              >
                {importNote || '从 ChatGPT 导入…'}
              </button>
              <button
                type="button"
                className="link"
                title="复制一段提示词，粘贴到 Codex 或 Claude Code，写上它的样子"
                onClick={() => {
                  void api
                    .petCreatePrompt()
                    .then((prompt) => navigator.clipboard.writeText(prompt))
                    .then(() => {
                      setPromptCopied(true)
                      setTimeout(() => setPromptCopied(false), 3000)
                    })
                    .catch(() => setNotice('复制失败'))
                }}
              >
                {promptCopied
                  ? '已复制，粘贴到 Codex 或 Claude Code'
                  : '自己做一只…'}
              </button>
            </div>
            <div className="group">
              <label>
                名字
                <input
                  required
                  maxLength={40}
                  value={settings.pet.name}
                  onChange={(e) =>
                    change(
                      {
                        ...settings,
                        pet: { ...settings.pet, name: e.target.value },
                      },
                      typingDelay,
                    )
                  }
                />
              </label>
              <Tuning
                label="大小"
                value={settings.pet.scale}
                presets={[
                  [petScalePresets.small, '小'],
                  [petScalePresets.medium, '中'],
                  [petScalePresets.large, '大'],
                ]}
                range={petScaleRange}
                show={(v) =>
                  `${Math.round((v / petScalePresets.medium) * 100)}%`
                }
                onChange={(scale, dragging) =>
                  change(
                    { ...settings, pet: { ...settings.pet, scale } },
                    dragging ? typingDelay : undefined,
                  )
                }
              />
              <Tuning
                label="动作快慢"
                value={settings.pet.rate}
                presets={[
                  [petRatePresets.slow, '慢'],
                  [petRatePresets.normal, '正常'],
                  [petRatePresets.fast, '快'],
                ]}
                range={petRateRange}
                show={(v) => `${Number(v.toFixed(2))}×`}
                onChange={(rate, dragging) =>
                  change(
                    { ...settings, pet: { ...settings.pet, rate } },
                    dragging ? typingDelay : undefined,
                  )
                }
              />
            </div>
          </section>
          <section hidden={tab !== 'privacy'}>
            <div className="group">
              <div className="setting-row">
                <span>对话记录</span>
                <button
                  type="button"
                  className="link"
                  onClick={() => api.revealConversations()}
                >
                  ~/.familiar/conversations
                </button>
              </div>
              <div className="setting-row">
                <span title="移到废纸篓，可以恢复">清空全部对话</span>
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
          </section>
          {notice && (
            <p role="status" className="caption">
              {notice}
            </p>
          )}
        </form>
      </div>
    </div>
  )
}

/** Three presets as buttons and a slider for anything between; the buttons light only on an exact match. */
function Tuning({
  label,
  value,
  presets,
  range,
  show,
  onChange,
}: {
  label: string
  value: number
  presets: [number, string][]
  range: { min: number; max: number }
  show: (value: number) => string
  onChange: (value: number, dragging: boolean) => void
}) {
  return (
    <div className="setting-row">
      <span>{label}</span>
      <div className="tuning">
        <div className="segmented">
          {presets.map(([v, text]) => (
            <button
              type="button"
              key={text}
              className={Math.abs(value - v) < 0.001 ? 'selected' : ''}
              onClick={() => onChange(v, false)}
            >
              {text}
            </button>
          ))}
        </div>
        <input
          type="range"
          aria-label={label}
          min={range.min}
          max={range.max}
          step={0.01}
          value={value}
          onChange={(e) => onChange(Number(e.target.value), true)}
        />
        <output>{show(value)}</output>
      </div>
    </div>
  )
}
