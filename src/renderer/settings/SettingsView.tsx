import { useEffect, useRef, useState } from 'react'
import type {
  ChatGptStatus,
  ModelDraft,
  PetSkin,
  PublicSettings,
} from '../../shared'
import { api } from '../api'
import { recoverSettings } from '../shared-ui/synchronization'
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
import { KnowledgePage } from './KnowledgePage'
import { LocalModel } from './LocalModel'
import { ShortcutsSection } from './Shortcuts'
import { Switch } from './Switch'
import { UpdateRow } from './UpdateRow'
import { Icon } from '../shared-ui/Icon'
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
  | 'knowledge'
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
  book: 'M4 5a2 2 0 0 1 2-2h13v15H6a2 2 0 0 0-2 2zM4 20a2 2 0 0 0 2 1h13v-3M8 7h7',
  chevron: 'M9 6l6 6-6 6',
}
const nav: (NavItem | NavGroup)[] = [
  { page: 'general', name: '通用', icon: icons.general },
  { page: 'pet', name: '宠物', icon: icons.pet },
  { page: 'shortcuts', name: '快捷键', icon: icons.keyboard },
  { page: 'model', name: '模型', icon: icons.model },
  { page: 'permissions', name: '权限', icon: icons.shield },
  { page: 'proactive', name: '主动说话', icon: icons.bell },
  {
    name: '记忆',
    icon: icons.memory,
    children: [
      { page: 'memory', name: '关于你' },
      { page: 'topics', name: '主题' },
      { page: 'pending', name: '待确认' },
    ],
  },
  { page: 'knowledge', name: '知识库', icon: icons.book },
  {
    name: '电脑活动',
    icon: icons.perception,
    children: [
      { page: 'timeline', name: '时间线' },
      { page: 'capture', name: '记录设置' },
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
/** ~/.familiar/persona.md: who the pet is. Saved as you type, like the rest of the page. */
function PersonaField() {
  const [text, setText] = useState<string>()
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined)
  useEffect(() => {
    void api
      .getPersona()
      .then((p) => setText(p.text))
      .catch(console.error)
    return () => clearTimeout(timer.current)
  }, [])
  if (text === undefined) return null
  return (
    <label className="stacked">
      人设
      <textarea
        rows={4}
        maxLength={2000}
        value={text}
        placeholder="它是什么样的性格、怎么说话、怎么称呼你"
        onChange={(e) => {
          const next = e.target.value
          setText(next)
          clearTimeout(timer.current)
          timer.current = setTimeout(
            () => void api.savePersona(next).catch(console.error),
            typingDelay,
          )
        }}
      />
    </label>
  )
}

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
/** A saved custom relay: an address of its own (an empty form is not one). */
const isRelay = (
  model: Pick<PublicSettings['model'], 'protocol' | 'baseURL'>,
) =>
  model.protocol !== 'chatgpt' &&
  Boolean(model.baseURL.trim()) &&
  !presetOf(model)
const modeHint = {
  ask: '改文件、运行命令、联网之前都先问你',
  auto: '工作目录里的事直接做，动其他文件夹前先问你',
  full: '什么都不问，命令也不加沙箱；只在你完全信任时用',
} as const
/** 15 → 15 分钟, 120 → 2 小时, 90 → 1 小时 30 分钟, 1440 → 1 天. */
const minutesText = (m: number) =>
  m === 1440
    ? '1 天'
    : m < 60
      ? `${m} 分钟`
      : `${Math.floor(m / 60)} 小时${m % 60 ? ` ${m % 60} 分钟` : ''}`

export function SettingsView() {
  const [tab, setTab] = useState<Page>('general')
  /** Expanded sidebar groups; the one holding the open page always shows. */
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [pets, setPets] = useState<PetSkin[]>([])
  const [settings, setSettings] = useState<PublicSettings>()
  const [key, setKey] = useState('')
  const [imageKey, setImageKey] = useState('')
  const [embeddingKey, setEmbeddingKey] = useState('')
  const [notice, setNotice] = useState('')
  const [promptCopied, setPromptCopied] = useState(false)
  const [importNote, setImportNote] = useState('')
  const [models, setModels] = useState<string[]>()
  const [chatgpt, setChatgpt] = useState<ChatGptStatus>()
  const [loginItem, setLoginItem] = useState<'on' | 'off' | 'approval'>('off')
  const [dataInfo, setDataInfo] = useState<{ path: string; bytes: number }>()
  /** The relay last saved, so picking 自定义中转 again brings its address back. */
  const [savedRelay, setSavedRelay] =
    useState<Pick<PublicSettings['model'], 'protocol' | 'baseURL'>>()
  const [signingIn, setSigningIn] = useState(false)
  /** 其他 was picked on a form with nothing filled in yet, so it stays picked while empty. */
  const [customPicked, setCustomPicked] = useState(false)
  const [probe, setProbe] = useState<{
    kind: 'busy' | 'ok' | 'error'
    text: string
  }>()
  useEffect(() => {
    void api.listPets().then(setPets).catch(console.error)
    api
      .getSettings()
      .then((loaded) => {
        setSettings((current) => current ?? loaded)
        if (isRelay(loaded.model)) setSavedRelay(loaded.model)
      })
      .catch(() => setNotice('读不到设置，请重新打开 Familiar'))
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
  // Approvals add rules while this window is open.
  useEffect(
    () =>
      api.onDirRulesChanged((dirRules) =>
        setSettings((s) => s && { ...s, dirRules }),
      ),
    [],
  )
  // Rules are added from approval cards, so pick them up whenever the window comes back.
  useEffect(() => {
    const refresh = () => {
      // A pet made in Codex or Claude Code shows up when the user comes back.
      void api.listPets().then(setPets).catch(console.error)
      void api
        .getSettings()
        .then((loaded) => setSettings((s) => recoverSettings(s, loaded)))
        .catch(console.error)
    }
    const off = api.onSkin(refresh)
    window.addEventListener('focus', refresh)
    return () => {
      off()
      window.removeEventListener('focus', refresh)
    }
  }, [])
  useEffect(() => {
    if (!notice.endsWith('废纸篓')) return
    const timer = setTimeout(() => setNotice(''), 4000)
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
  if (!settings) return <p role="status">{notice || '正在读取设置…'}</p>
  /** Saves what is on screen; keys only when given, so a half-typed one never reaches the keychain. */
  async function persist(
    next: PublicSettings,
    keys: { apiKey?: string; imageKey?: string; embeddingKey?: string } = {},
  ) {
    // Required fields wait until they are filled in again.
    if (!next.pet.name.trim() || !next.workspacePath.trim()) return
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { apiKeySet, ...publicModel } = next.model
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { apiKeySet: imageKeySet, ...publicImage } = next.imageModel
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { apiKeySet: embeddingKeySet, ...publicEmbedding } =
      next.embeddingModel
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
        embeddingModel: {
          ...publicEmbedding,
          ...(keys.embeddingKey ? { apiKey: keys.embeddingKey } : {}),
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
            embeddingModel: {
              ...s.embeddingModel,
              apiKeySet: saved.embeddingModel.apiKeySet,
            },
          },
      )
      if (isRelay(saved.model)) setSavedRelay(saved.model)
      if (keys.apiKey) setKey('')
      if (keys.imageKey) setImageKey('')
      if (keys.embeddingKey) setEmbeddingKey('')
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
    if (!key && !imageKey && !embeddingKey) return
    const typedChatKey = Boolean(key)
    void persist(settings, { apiKey: key, imageKey, embeddingKey }).then(() => {
      // With a new key the list of models is the next thing needed.
      if (typedChatKey && (preset || settings.model.baseURL.trim()))
        fetchModels()
    })
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
  /** A first run: no service picked, so the page asks for that before anything else. */
  const unchosen =
    !viaChatGpt &&
    !preset &&
    !customPicked &&
    !savedRelay &&
    !settings.model.baseURL.trim() &&
    !settings.model.model.trim() &&
    !settings.model.apiKeySet
  const pickProvider = (id: string) => {
    setCustomPicked(id === 'custom')
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
            ? `找到 ${ids.length} 个模型，在「模型」里选一个，也可以输入筛选。`
            : '这个服务没有返回可用的模型，可以直接填模型名称。',
        })
      })
      .catch((e: unknown) => setProbe({ kind: 'error', text: failure(e) }))
  }
  const testConnection = () => {
    if (probe?.kind === 'busy') return
    setProbe({
      kind: 'busy',
      text: `正在用 ${settings.model.model.trim()} 发一条测试消息…`,
    })
    api
      .testModel(draft())
      .then(({ ms, reply }) =>
        setProbe({
          kind: 'ok',
          text: `连上了，${(ms / 1000).toFixed(1)} 秒收到回复${reply ? `「${reply}」` : ''}。`,
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
        {tab === 'knowledge' && (
          <div className="settings">
            <KnowledgePage />
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
            void persist(settings, { apiKey: key, imageKey, embeddingKey })
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
                <div className="ch-label">
                  <span>启动时显示宠物</span>
                  {!settings.showPetOnLaunch && (
                    <span className="muted">
                      启动后只在菜单栏显示图标，用快捷键或菜单叫出宠物
                    </span>
                  )}
                </div>
                <Switch
                  on={settings.showPetOnLaunch}
                  label="启动时显示宠物"
                  onChange={(on) =>
                    change({ ...settings, showPetOnLaunch: on })
                  }
                />
              </div>
              <div className="setting-row">
                <span title="等你允许或输入框里有草稿时不收起；按 Esc 也能收起">
                  点别处时收起聊天面板
                </span>
                <Switch
                  on={settings.chatAutoHide}
                  label="点别处时收起聊天面板"
                  onChange={(on) => change({ ...settings, chatAutoHide: on })}
                />
              </div>
              <div className="setting-row">
                <div className="ch-label">
                  <span>点别处时收起快捷问答条</span>
                  {!settings.quickAutoHide && (
                    <span className="muted">
                      关着方便从 Finder 拖文件进来；按 Esc 收起
                    </span>
                  )}
                </div>
                <Switch
                  on={settings.quickAutoHide}
                  label="点别处时收起快捷问答条"
                  onChange={(on) => change({ ...settings, quickAutoHide: on })}
                />
              </div>
              <div className="setting-row">
                <span>打开快捷问答条时</span>
                <div className="segmented">
                  {(
                    [
                      ['continue', '接着上次聊'],
                      ['new', '开新对话'],
                    ] as const
                  ).map(([mode, text]) => (
                    <button
                      type="button"
                      key={mode}
                      className={settings.quickOpen === mode ? 'selected' : ''}
                      onClick={() => change({ ...settings, quickOpen: mode })}
                    >
                      {text}
                    </button>
                  ))}
                </div>
              </div>
              {settings.quickOpen === 'continue' && (
                <div className="setting-row">
                  <span>超过多久没聊就开新对话</span>
                  <select
                    aria-label="超过多久没聊就开新对话"
                    value={settings.quickIdleMinutes}
                    onChange={(e) =>
                      change({
                        ...settings,
                        quickIdleMinutes: Number(e.target.value),
                      })
                    }
                  >
                    {[
                      ...new Set([
                        15,
                        30,
                        60,
                        120,
                        240,
                        480,
                        1440,
                        settings.quickIdleMinutes,
                      ]),
                    ]
                      .sort((a, b) => a - b)
                      .map((m) => (
                        <option key={m} value={m}>
                          {minutesText(m)}
                        </option>
                      ))}
                  </select>
                </div>
              )}
              <div className="setting-row">
                <span title="选哪一种，点开一步都能看到完整的指令和结果">
                  回复里的操作步骤
                </span>
                <div className="segmented">
                  {(
                    [
                      ['brief', '合并'],
                      ['full', '逐条'],
                      ['hidden', '不显示'],
                    ] as const
                  ).map(([view, text]) => (
                    <button
                      type="button"
                      key={view}
                      className={settings.toolView === view ? 'selected' : ''}
                      onClick={() => change({ ...settings, toolView: view })}
                    >
                      {text}
                    </button>
                  ))}
                </div>
              </div>
            </div>
            <h3 className="memory-heading">不透明度</h3>
            <div className="group">
              <div className="setting-row">
                <span>聊天面板和菜单栏</span>
                <span className="tuning">
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
                  <output>
                    {settings.panelOpacity === 1
                      ? '不透明'
                      : `${Math.round(settings.panelOpacity * 100)}%`}
                  </output>
                </span>
              </div>
              <div className="setting-row">
                <span>设置和大窗口</span>
                <span className="tuning">
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
                  <output>
                    {settings.windowOpacity === 1
                      ? '不透明'
                      : `${Math.round(settings.windowOpacity * 100)}%`}
                  </output>
                </span>
              </div>
            </div>
            <h3 className="memory-heading">数据</h3>
            <div className="group">
              <div className="setting-row">
                <div className="ch-label">
                  <span>数据目录</span>
                  <span className="muted">
                    {dataInfo
                      ? `${dataInfo.path.replace(/^\/Users\/[^/]+/, '~')}，占用 ${size(dataInfo.bytes)}`
                      : '读取中…'}
                  </span>
                </div>
                <button type="button" onClick={() => api.revealData()}>
                  在 Finder 中打开
                </button>
              </div>
            </div>
            <h3 className="memory-heading">版本</h3>
            <div className="group">
              <UpdateRow />
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
                value={
                  unchosen
                    ? ''
                    : viaChatGpt
                      ? 'chatgpt'
                      : (preset?.id ?? 'custom')
                }
                onChange={(e) => pickProvider(e.target.value)}
              >
                {unchosen && (
                  <option value="" disabled>
                    选择…
                  </option>
                )}
                {providerPresets.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
                <option value="chatgpt">ChatGPT 账号登录</option>
                <option value="custom">其他（自填接口地址）</option>
              </select>
            </label>
            {!unchosen && !preset && !viaChatGpt && (
              <>
                <label>
                  接口格式
                  <select
                    value={settings.model.protocol}
                    onChange={(e) =>
                      model(
                        'protocol',
                        e.target.value as PublicSettings['model']['protocol'],
                      )
                    }
                  >
                    <option value="openai-compatible">OpenAI 兼容</option>
                    <option value="openai-responses">OpenAI Responses</option>
                    <option value="anthropic">Anthropic</option>
                  </select>
                </label>
                <label>
                  接口地址
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
                        ? chatgpt.planUsage === false
                          ? `${chatgpt.email || '已登录'}，但没有授权使用套餐额度，请重新登录并同意`
                          : chatgpt.email || '已登录'
                        : '还没登录'}
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
                      查看用量
                    </button>
                  )}
                  {signingIn ? (
                    <button type="button" onClick={() => api.chatgptCancel()}>
                      取消
                    </button>
                  ) : (
                    <button type="button" onClick={chatGptSignIn}>
                      {chatgpt?.signedIn ? '重新登录' : '登录'}
                    </button>
                  )}
                  {chatgpt?.signedIn && !signingIn && (
                    <button type="button" onClick={chatGptSignOut}>
                      退出登录
                    </button>
                  )}
                </span>
              </div>
            )}
            {!unchosen && !viaChatGpt && (
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
                    settings.model.apiKeySet ? '已保存' : '粘贴你的 API Key'
                  }
                  value={key}
                  onChange={(e) => setKey(e.target.value)}
                  onBlur={saveKeys}
                />
              </label>
            )}
            {!unchosen && (
              <>
                <label>
                  模型
                  <input
                    list="model-options"
                    value={settings.model.model}
                    placeholder={
                      models?.length
                        ? '从列表里选，也可以输入'
                        : viaChatGpt || settings.model.apiKeySet || key
                          ? '例如 gpt-6.1-sol'
                          : '填好 Key 后可以从列表里选'
                    }
                    onChange={(e) => model('model', e.target.value)}
                  />
                </label>
                <label>
                  后台模型
                  <input
                    list="model-options"
                    value={settings.model.smallModel}
                    placeholder="可选，留空就用上面的模型"
                    title="整理记忆、判断要不要主动说话时用；可以填个便宜些的"
                    onChange={(e) => model('smallModel', e.target.value)}
                  />
                </label>
                <datalist id="model-options">
                  {models?.map((id) => (
                    <option key={id} value={id} />
                  ))}
                </datalist>
              </>
            )}
            {!unchosen &&
              !preset &&
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
            {!unchosen && (
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
            )}
          </section>
          <section hidden={tab !== 'model'}>
            <h3 className="memory-heading">生图（可选）</h3>
            <div className="group">
              <label>
                生图模型
                <input
                  value={settings.imageModel.model}
                  placeholder="例如 gpt-image-2"
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
                接口地址
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
                    settings.imageModel.apiKeySet ? '已保存' : '粘贴 API Key'
                  }
                  value={imageKey}
                  onChange={(e) => setImageKey(e.target.value)}
                  onBlur={saveKeys}
                />
              </label>
            </div>
          </section>
          <section hidden={tab !== 'model'}>
            <h3 className="memory-heading">按意思检索（可选）</h3>
            <div className="group">
              <label>
                来源
                <select
                  value={settings.embeddingModel.source}
                  onChange={(e) =>
                    change({
                      ...settings,
                      embeddingModel: {
                        ...settings.embeddingModel,
                        source: e.target.value as 'remote' | 'local',
                      },
                    })
                  }
                >
                  <option value="local">本机</option>
                  <option value="remote">在线服务</option>
                </select>
              </label>
              {settings.embeddingModel.source === 'local' && <LocalModel />}
            </div>
            <div
              className="group"
              hidden={settings.embeddingModel.source === 'local'}
            >
              <label>
                向量模型
                <input
                  value={settings.embeddingModel.model}
                  placeholder="例如 text-embedding-3-small"
                  onChange={(e) =>
                    change(
                      {
                        ...settings,
                        embeddingModel: {
                          ...settings.embeddingModel,
                          model: e.target.value,
                        },
                      },
                      typingDelay,
                    )
                  }
                />
              </label>
              <label>
                接口地址
                <input
                  value={settings.embeddingModel.baseURL}
                  placeholder="https://api.openai.com/v1"
                  onChange={(e) =>
                    change(
                      {
                        ...settings,
                        embeddingModel: {
                          ...settings.embeddingModel,
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
                    settings.embeddingModel.apiKeySet
                      ? '已保存'
                      : '粘贴 API Key'
                  }
                  value={embeddingKey}
                  onChange={(e) => setEmbeddingKey(e.target.value)}
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
            <div className="setting-row">
              <div className="ch-label">
                <span>权限模式</span>
                <span className="muted">
                  {modeHint[settings.permissionMode]}
                </span>
              </div>
              <select
                aria-label="权限模式"
                value={settings.permissionMode}
                onChange={(e) =>
                  change({
                    ...settings,
                    permissionMode: e.target
                      .value as PublicSettings['permissionMode'],
                  })
                }
              >
                <option value="ask">每步都问</option>
                <option value="auto">自动</option>
                <option value="full">完全访问</option>
              </select>
            </div>
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
              <div className="ch-label">
                <span>自动快照</span>
                <span className="muted">
                  {settings.workspaceSnapshots
                    ? '改了文件、记忆或对话后自动存一个版本，改错删错能找回'
                    : '关着时改错删错的内容找不回来'}
                </span>
              </div>
              <Switch
                on={settings.workspaceSnapshots}
                label="自动快照"
                onChange={(on) =>
                  change({ ...settings, workspaceSnapshots: on })
                }
              />
            </div>
            <div className="setting-row">
              <div className="ch-label">
                <span>命令沙箱</span>
                <span className="muted">
                  {settings.permissionMode === 'full'
                    ? '完全访问模式下命令不加沙箱'
                    : settings.shellSandbox
                      ? '命令只能改工作目录，碰不到 ~/.familiar 和密钥'
                      : '命令像在终端里一样运行，要碰登录凭据和密钥时先问你'}
                </span>
              </div>
              <Switch
                on={settings.shellSandbox}
                label="命令沙箱"
                onChange={(on) => change({ ...settings, shellSandbox: on })}
              />
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
                      <span className="muted">
                        {accessLabel[rule.access]}
                        {rule.network && '，可联网'}
                      </span>
                      <button
                        type="button"
                        className="icon rule-remove"
                        aria-label={`删除规则 ${rule.path}`}
                        title="删除这条规则"
                        onClick={() => {
                          api
                            .removeDirRule(rule.path)
                            .then((dirRules) =>
                              setSettings((s) => s && { ...s, dirRules }),
                            )
                            .catch(() => setNotice('没删掉这条规则，再试一次'))
                        }}
                      >
                        <Icon name="close" size={14} />
                      </button>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="muted">
                  在对话里点过「始终允许」的文件夹会列在这里
                </p>
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
                      className="pet-delete"
                      aria-label={`把 ${p.displayName} 移到废纸篓`}
                      title="移到废纸篓"
                      onClick={() =>
                        void api
                          .deletePet(p.id)
                          .then(async (list) => {
                            setPets(list)
                            const loaded = await api.getSettings()
                            setSettings((s) => s && { ...s, pet: loaded.pet })
                            setNotice(`${p.displayName} 已移到废纸篓`)
                          })
                          .catch(() => setNotice('没删掉，再试一次'))
                      }
                    >
                      <Icon name="close" size={12} />
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
                        added > 0 ? `导入了 ${added} 只` : '没有新的可以导入',
                      )
                      setTimeout(() => setImportNote(''), 3000)
                      setPets(list)
                    })
                    .catch(() => setNotice('没导入成功，再试一次'))
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
                    .catch(() => setNotice('没复制上，再试一次'))
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
              <PersonaField />
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
              <div className="setting-row">
                <div className="ch-label">
                  <span>自己走动</span>
                  <span className="muted">空闲时走一小段再回来，深夜不走</span>
                </div>
                <Switch
                  on={settings.pet.wander}
                  label="自己走动"
                  onChange={(wander) =>
                    change({ ...settings, pet: { ...settings.pet, wander } })
                  }
                />
              </div>
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
                <div className="ch-label">
                  <span>清空全部对话</span>
                  <span className="muted">移到废纸篓，需要时可以放回原处</span>
                </div>
                <button
                  type="button"
                  onClick={() =>
                    api
                      .clearConversations()
                      .then(() => setNotice('全部对话已移到废纸篓'))
                      .catch((e: unknown) =>
                        setNotice(
                          typeof e === 'string' ? e : '没清空，再试一次',
                        ),
                      )
                  }
                >
                  清空
                </button>
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
