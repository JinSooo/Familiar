import {
  app,
  shell,
  BrowserWindow,
  ipcMain,
  Menu,
  nativeImage,
  screen,
  Tray,
  protocol,
  powerMonitor,
  systemPreferences,
} from 'electron'
import { readFileSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { z } from 'zod'
import { IPC, type AgentEvent, type PetState } from '../shared'
import {
  loadSettings,
  publicSettings,
  saveSettings,
  getSettings,
} from './settings'
import {
  emptySession,
  beginTurn,
  reduceSession,
  shouldExpand,
  bubbleTimeout,
} from './session'
import { runAgent, resolveApproval } from './agent'
import { listPets, currentSkin, importCodexPets, servePets } from './pets'
import {
  petDimensions,
  scales,
  resolveState,
  clickSequence,
} from '../renderer/pet/logic'
protocol.registerSchemesAsPrivileged([
  {
    scheme: 'familiar-pet',
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      corsEnabled: true,
    },
  },
])
const here = dirname(fileURLToPath(import.meta.url))
app.setName('Familiar')
app.setAppUserModelId('com.allinpet.familiar')
// Allows smoke runs to stay entirely inside the repository.
if (process.env.FAMILIAR_USER_DATA)
  app.setPath('userData', process.env.FAMILIAR_USER_DATA)
let pet: BrowserWindow
let chat: BrowserWindow
let settingsWindow: BrowserWindow
let session = emptySession()
let capsuleOpen = false
let expandedTurn = false
let resetRequested = false
let bubbleTimer: ReturnType<typeof setTimeout> | undefined
function broadcast(channel: string, value: unknown) {
  for (const win of [pet, chat, settingsWindow])
    if (win && !win.isDestroyed()) win.webContents.send(channel, value)
}
function publishSession() {
  broadcast(IPC.session, session)
}
function setCapsule(open: boolean) {
  capsuleOpen = open
  pet.webContents.send(IPC.capsule, open)
  if (open) {
    pet.setIgnoreMouseEvents(false)
    pet.show()
    pet.focus()
  } else {
    typingAt = 0
    activity.listening = false
    pet.setIgnoreMouseEvents(true, { forward: true })
    pet.blur()
    refreshState()
  }
}
function accent() {
  try {
    return `#${systemPreferences.getAccentColor().slice(0, 6)}`
  } catch {
    return '#0A66D8'
  }
}
let tray: Tray
let quitting = false
let controller: AbortController | undefined
let state: PetState = 'idle'
const activity: Partial<Record<PetState, boolean>> = {}
let typingAt = 0
let clicks: number[] = []
let clickTimer: ReturnType<typeof setTimeout> | undefined
let greetedDay = ''
let petReady = false
function refreshState() {
  setState(resolveState(activity) as PetState)
}
function greet() {
  if (!petReady) return
  const day = new Date().toLocaleDateString('en-CA')
  if (greetedDay !== day) {
    greetedDay = day
    pet.webContents.send(IPC.petGesture, 'wave')
    writeFileSync(join(app.getPath('userData'), 'pet-greeting.txt'), day)
  }
}
let drag:
  | { cursor: Electron.Point; position: Electron.Point; moved: boolean }
  | undefined
const pendingApprovals = new Set<string>()
function clamp(
  x: number,
  y: number,
  width: number,
  height: number,
): Electron.Point {
  const area = screen.getDisplayNearestPoint({ x, y }).workArea
  return {
    x: Math.max(
      area.x,
      Math.min(Math.round(x), area.x + Math.max(0, area.width - width)),
    ),
    y: Math.max(
      area.y,
      Math.min(Math.round(y), area.y + Math.max(0, area.height - height)),
    ),
  }
}
function setState(next: PetState): void {
  if (state === next) return
  state = next
  broadcast(IPC.petState, next)
}
function showChat(next: 'chat' | 'settings' = 'chat'): void {
  if (next === 'settings') {
    settingsWindow.show()
    settingsWindow.focus()
    return
  }
  activity.done = false
  refreshState()
  expandedTurn = true
  session = { ...session, origin: 'chat' }
  publishSession()
  setCapsule(false)
  const p = pet.getBounds(),
    c = chat.getBounds()
  // The pet sits in the overlay's bottom-right corner; open the panel just left of it.
  const petWidth = Math.ceil(192 * scales[getSettings().pet.size])
  const near = clamp(
    p.x + p.width - petWidth - c.width - 8,
    p.y + p.height - c.height,
    c.width,
    c.height,
  )
  chat.setPosition(near.x, near.y)
  chat.show()
  chat.focus()
}

function toggleChat(): void {
  if (chat.isVisible()) chat.hide()
  else showChat()
}
function persistPosition(): void {
  try {
    const { x, y } = pet.getBounds()
    writeFileSync(
      join(app.getPath('userData'), 'window-state.json'),
      JSON.stringify({ x, y }),
      { mode: 0o600 },
    )
  } catch (error) {
    console.error('Window position could not be saved', error)
  }
}
async function loadWindow(win: BrowserWindow, kind: string): Promise<void> {
  const openExternal = (url: string) => {
    if (kind !== 'chat' && kind !== 'settings') return
    try {
      if (['http:', 'https:', 'mailto:'].includes(new URL(url).protocol))
        void shell.openExternal(url).catch(console.error)
    } catch {
      /* Invalid URLs are denied. */
    }
  }
  win.webContents.setWindowOpenHandler(({ url }) => {
    openExternal(url)
    return { action: 'deny' }
  })
  win.webContents.on('will-navigate', (event, url) => {
    event.preventDefault()
    openExternal(url)
  })
  win.webContents.on('render-process-gone', (_event, details) =>
    console.error('Renderer exited', details.reason),
  )
  win.webContents.on('console-message', (details) => {
    if (details.level === 'error') console.error('Renderer:', details.message)
  })
  if (process.env.ELECTRON_RENDERER_URL)
    await win.loadURL(`${process.env.ELECTRON_RENDERER_URL}/?window=${kind}`)
  else
    await win.loadFile(join(here, '../renderer/index.html'), {
      query: { window: kind },
    })
}
async function start(): Promise<void> {
  await loadSettings()
  await listPets()
  servePets()
  try {
    greetedDay = readFileSync(
      join(app.getPath('userData'), 'pet-greeting.txt'),
      'utf8',
    )
  } catch {
    /* first day */
  }
  const initialSize = petDimensions(getSettings().pet.size)
  // FAMILIAR_SHOW_DOCK keeps the app visible to UI automation tools during development.
  if (!process.env.FAMILIAR_SHOW_DOCK) app.dock?.hide()
  const area = screen.getPrimaryDisplay().workArea
  let position = { x: area.x + area.width - 240, y: area.y + area.height - 240 }
  try {
    position = z
      .object({ x: z.number().finite(), y: z.number().finite() })
      .parse(
        JSON.parse(
          readFileSync(
            join(app.getPath('userData'), 'window-state.json'),
            'utf8',
          ),
        ),
      )
  } catch {
    /* First launch or invalid window state: use default. */
  }
  position = clamp(
    position.x,
    position.y,
    initialSize.width,
    initialSize.height,
  )
  const webPreferences = {
    preload: join(here, '../preload/index.cjs'),
    contextIsolation: true,
    sandbox: true,
    nodeIntegration: false,
  }
  pet = new BrowserWindow({
    ...position,
    ...initialSize,
    type: 'panel',
    focusable: true,
    transparent: true,
    frame: false,
    hasShadow: false,
    resizable: false,
    skipTaskbar: true,
    show: false,
    webPreferences,
  })
  pet.setAlwaysOnTop(true, 'screen-saver')
  pet.setVisibleOnAllWorkspaces(true, {
    visibleOnFullScreen: true,
    skipTransformProcessType: true,
  })
  pet.setIgnoreMouseEvents(true, { forward: true })
  const near = clamp(position.x - 440, position.y - 400, 440, 620)
  chat = new BrowserWindow({
    ...near,
    width: 380,
    height: 620,
    minWidth: 360,
    minHeight: 420,
    title: 'Familiar',
    show: false,
    frame: false,
    transparent: true,
    vibrancy: 'popover',
    // Approve/deny must work on the first click even when the panel is not key yet.
    acceptFirstMouse: true,
    visualEffectState: 'active',
    backgroundColor: '#00000000',
    webPreferences,
  })
  settingsWindow = new BrowserWindow({
    width: 760,
    height: 600,
    minWidth: 680,
    minHeight: 500,
    title: '设置',
    titleBarStyle: 'hiddenInset',
    vibrancy: 'sidebar',
    visualEffectState: 'active',
    show: false,
    webPreferences,
  })
  settingsWindow.on('close', (event) => {
    if (!quitting) {
      event.preventDefault()
      settingsWindow.hide()
    }
  })
  chat.on('show', () => {
    activity.done = false
    refreshState()
  })
  chat.on('focus', () => {
    activity.done = false
    refreshState()
  })
  chat.on('close', (event) => {
    if (!quitting) {
      event.preventDefault()
      chat.hide()
    }
  })
  pet.on('close', () => {
    if (!quitting) app.quit()
  })
  const petSender = (event: Electron.IpcMainEvent) =>
    event.sender === pet.webContents
  ipcMain.on(IPC.petHit, (event, inside: unknown) => {
    if (petSender(event) && typeof inside === 'boolean' && !drag)
      pet.setIgnoreMouseEvents(!inside, { forward: true })
  })
  ipcMain.on(IPC.toggleChat, (event) => {
    if (petSender(event)) showChat()
    else if (event.sender === chat.webContents) {
      chat.hide()
      setCapsule(true)
    }
  })
  ipcMain.on(IPC.drag, (event, action: unknown) => {
    if (!petSender(event)) return
    const cursor = screen.getCursorScreenPoint()
    if (action === 'start') {
      const { x, y } = pet.getBounds()
      drag = { cursor, position: { x, y }, moved: false }
      pet.setIgnoreMouseEvents(false)
    } else if (drag && (action === 'move' || action === 'end')) {
      const dx = cursor.x - drag.cursor.x,
        dy = cursor.y - drag.cursor.y
      if (Math.hypot(dx, dy) > 4) drag.moved = true
      if (drag.moved) {
        const { width, height } = pet.getBounds()
        const p = clamp(
          drag.position.x + dx,
          drag.position.y + dy,
          width,
          height,
        )
        pet.setPosition(p.x, p.y)
      }
      if (action === 'end') {
        const moved = drag.moved
        drag = undefined
        persistPosition()
        pet.setIgnoreMouseEvents(true, { forward: true })
        if (!moved) {
          const result = clickSequence(clicks, Date.now())
          clicks = result.times
          clearTimeout(clickTimer)
          if (result.poked) pet.webContents.send(IPC.petGesture, 'poked')
          else
            clickTimer = setTimeout(() => {
              clicks = []
              pet.webContents.send(IPC.petGesture, 'wave')
              setCapsule(!capsuleOpen)
            }, 220)
        }
      }
    }
  })
  const requireSettings = (event: Electron.IpcMainInvokeEvent): void => {
    if (event.sender !== settingsWindow.webContents)
      throw new Error('Unauthorized IPC sender')
  }
  ipcMain.handle(IPC.settingsGet, (event) => {
    if (event.sender !== pet.webContents && event.sender !== chat.webContents)
      requireSettings(event)
    return publicSettings()
  })
  ipcMain.handle(IPC.settingsSave, async (event, input) => {
    requireSettings(event)
    const saved = await saveSettings(input)
    updatePet()
    publishSession()
    rebuildTray()
    return saved
  })
  ipcMain.handle(IPC.agentRun, async (event, input: unknown) => {
    if (event.sender !== pet.webContents && event.sender !== chat.webContents)
      throw new Error('Unauthorized IPC sender')
    if (controller) throw new Error('已有对话正在运行')
    const text = z.string().trim().min(1).max(100000).parse(input)
    if (session.messages.length >= 498) throw new Error('请开启新对话')
    clearTimeout(bubbleTimer)
    expandedTurn = event.sender === chat.webContents
    session = beginTurn(
      session,
      text,
      event.sender === pet.webContents ? 'capsule' : 'chat',
    )
    const messages = session.messages
      .filter((m) => m.content)
      .map(({ role, content }) => ({ role, content }))
    publishSession()
    resetRequested = false
    const run = new AbortController()
    controller = run
    Object.assign(activity, {
      thinking: true,
      talking: false,
      failed: false,
      done: false,
    })
    refreshState()
    const emit = (item: AgentEvent): void => {
      if (resetRequested) return
      session = reduceSession(session, item)
      publishSession()
      if (
        (item.type === 'tool-approval-request' && !chat.isVisible()) ||
        (shouldExpand(session) && !expandedTurn)
      )
        showChat()

      if (item.type === 'text-delta') {
        activity.thinking = false
        activity.talking = true
      }
      if (item.type === 'tool-call') {
        activity.thinking = true
        activity.talking = false
      }
      if (item.type === 'error') {
        activity.failed = true
        activity.done = false
      }
      if (item.type === 'finish')
        activity.done =
          !item.stopped && (!chat.isVisible() || !chat.isFocused())
      if (item.type === 'tool-approval-request') {
        pendingApprovals.add(item.id)
        activity['needs-you'] = true
      }
      refreshState()
      broadcast(IPC.agentEvent, item)
    }
    try {
      await runAgent(messages, emit, run.signal)
    } catch (error) {
      // runAgent already turns model, network and config failures into user-facing Chinese messages.
      console.error('Agent run failed', error)
      emit({
        type: 'error',
        message: error instanceof Error ? error.message : '运行失败，请重试。',
      })
    } finally {
      session = resetRequested
        ? emptySession()
        : { ...session, running: false, approvals: [] }
      publishSession()
      bubbleTimer = setTimeout(() => {
        session = { ...session, bubble: '' }
        activity.done = false
        refreshState()
        publishSession()
      }, bubbleTimeout(session.bubble))
      controller = undefined
      pendingApprovals.clear()
      activity.thinking = false
      activity.talking = false
      activity['needs-you'] = false
      refreshState()
    }
  })
  ipcMain.on(IPC.agentStop, (event) => {
    if (event.sender === chat.webContents || petSender(event))
      controller?.abort()
  })
  ipcMain.on(IPC.approval, (event, id: unknown, decision: unknown) => {
    if (
      event.sender !== chat.webContents ||
      typeof id !== 'string' ||
      !pendingApprovals.has(id) ||
      (decision !== 'approve' && decision !== 'deny')
    )
      return
    session = {
      ...session,
      approvals: session.approvals.filter((a) => a.id !== id),
    }
    publishSession()
    pendingApprovals.delete(id)
    resolveApproval(id, decision)
    activity['needs-you'] = pendingApprovals.size > 0
    activity.thinking = true
    activity.talking = false
    refreshState()
  })
  ipcMain.on(IPC.ready, (event) => {
    if (event.sender === pet.webContents) {
      pet.webContents.send(IPC.petState, state)
      petReady = true
      greet()
    }
    if (
      [pet.webContents, chat.webContents, settingsWindow.webContents].includes(
        event.sender,
      )
    ) {
      event.sender.send(IPC.appearance, accent())
      event.sender.send(IPC.session, session)
      event.sender.send(IPC.petState, state)
      if (petSender(event)) event.sender.send(IPC.capsule, capsuleOpen)
    }
  })
  // A small monochrome template image works in both light and dark menu bars.
  const pixels = Buffer.alloc(18 * 18 * 4)
  for (let y = 2; y < 16; y++)
    for (let x = 2; x < 16; x++)
      if ((x - 9) ** 2 + (y - 9) ** 2 < 45) {
        const i = (y * 18 + x) * 4
        pixels[i + 3] = 255
      }
  const icon = nativeImage.createFromBitmap(pixels, {
    width: 18,
    height: 18,
    scaleFactor: 1,
  })
  icon.setTemplateImage(true)
  tray = new Tray(icon)
  tray.setToolTip('Familiar')
  // The Dock icon is hidden, so this menu is never shown; it exists for ⌘, and the edit shortcuts.
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      {
        role: 'appMenu',
        submenu: [
          {
            label: '设置…',
            accelerator: 'CmdOrCtrl+,',
            click: () => showChat('settings'),
          },
          { type: 'separator' },
          { role: 'quit', label: '退出 Familiar' },
        ],
      },
      { role: 'editMenu' },
      { role: 'windowMenu' },
    ]),
  )
  function updatePet() {
    const settings = getSettings()
    const bounds = pet.getBounds()
    const size = petDimensions(settings.pet.size)
    pet.setBounds({
      ...clamp(
        bounds.x + bounds.width - size.width,
        bounds.y + bounds.height - size.height,
        size.width,
        size.height,
      ),
      ...size,
    })
    persistPosition()
    broadcast(IPC.petSkin, currentSkin(settings.pet.id))
    broadcast(IPC.petSize, settings.pet.size)
  }
  async function choosePet(id: string) {
    const settings = publicSettings()
    await saveSettings({
      ...settings,
      model: { ...settings.model, apiKey: undefined },
      pet: { ...settings.pet, id },
    })
    updatePet()
    rebuildTray()
  }
  function rebuildTray() {
    tray.setContextMenu(
      Menu.buildFromTemplate([
        { label: '显示 / 隐藏聊天', click: toggleChat },
        { label: '设置…', click: () => showChat('settings') },
        {
          label: 'Pet',
          submenu: skins.map((skin) => ({
            label: skin.displayName,
            type: 'radio' as const,
            checked: currentSkin(getSettings().pet.id).id === skin.id,
            click: () => {
              void choosePet(skin.id).catch(console.error)
            },
          })),
        },
        {
          label: 'Import pets from ChatGPT',
          click: () => {
            void importCodexPets()
              .then((result) => {
                skins = result
                updatePet()
                rebuildTray()
              })
              .catch(console.error)
          },
        },
        {
          label: 'Size',
          submenu: (['small', 'medium', 'large'] as const).map((size) => ({
            label: size,
            type: 'radio' as const,
            checked: getSettings().pet.size === size,
            click: () => {
              const settings = publicSettings()
              void saveSettings({
                ...settings,
                model: { ...settings.model, apiKey: undefined },
                pet: { ...settings.pet, size },
              })
                .then(() => {
                  updatePet()
                  rebuildTray()
                })
                .catch(console.error)
            },
          })),
        },
        { type: 'separator' },
        { label: '退出 Familiar', click: () => app.quit() },
      ]),
    )
  }
  let skins = await listPets()
  rebuildTray()
  const requireWindow = (event: Electron.IpcMainInvokeEvent) => {
    if (
      event.sender !== pet.webContents &&
      event.sender !== chat.webContents &&
      event.sender !== settingsWindow.webContents
    )
      throw new Error('Unauthorized IPC sender')
  }
  ipcMain.handle(IPC.sessionGet, (event) => {
    requireWindow(event)
    return session
  })
  ipcMain.on(IPC.settingsOpen, (event) => {
    if (event.sender === chat.webContents || petSender(event))
      showChat('settings')
  })
  ipcMain.on(IPC.sessionNew, (event) => {
    if (event.sender !== chat.webContents && !petSender(event)) return
    resetRequested = Boolean(controller)
    controller?.abort()
    pendingApprovals.clear()
    clearTimeout(bubbleTimer)
    session = emptySession()
    activity.done = false
    activity.failed = false
    activity.thinking = false
    activity.talking = false
    activity['needs-you'] = false
    refreshState()
    publishSession()
  })
  ipcMain.on(IPC.capsule, (event, open: unknown) => {
    if (petSender(event) && typeof open === 'boolean') setCapsule(open)
  })
  systemPreferences.on('accent-color-changed', () =>
    broadcast(IPC.appearance, accent()),
  )
  ipcMain.handle(IPC.petSkin, (event) => {
    requireWindow(event)
    return currentSkin(getSettings().pet.id)
  })
  ipcMain.handle(IPC.petsList, (event) => {
    requireWindow(event)
    return skins
  })
  ipcMain.handle(IPC.petsImport, async (event) => {
    requireWindow(event)
    skins = await importCodexPets()
    updatePet()
    rebuildTray()
    return skins
  })
  ipcMain.on(IPC.petFinished, (event) => {
    if (petSender(event)) {
      activity.failed = false
      refreshState()
    }
  })
  ipcMain.on(IPC.typing, (event, hasText: unknown) => {
    if (
      (event.sender !== chat.webContents && !petSender(event)) ||
      typeof hasText !== 'boolean'
    )
      return
    typingAt = hasText ? Date.now() : 0
    activity.listening = hasText
    refreshState()
  })
  const idleTimer = setInterval(() => {
    activity.sleeping = powerMonitor.getSystemIdleTime() >= 600
    activity.listening = Date.now() - typingAt < 2000
    refreshState()
    if (pet.isVisible()) greet()
  }, 500)
  app.once('before-quit', () => {
    clearInterval(idleTimer)
    clearTimeout(clickTimer)
    clearTimeout(bubbleTimer)
  })
  screen.on('display-metrics-changed', () => {
    const { x, y } = pet.getBounds()
    const { width, height } = pet.getBounds()
    const p = clamp(x, y, width, height)
    pet.setPosition(p.x, p.y)
    persistPosition()
  })
  await Promise.all([
    loadWindow(pet, 'pet'),
    loadWindow(chat, 'chat'),
    loadWindow(settingsWindow, 'settings'),
  ])
  pet.showInactive()
  console.info(
    `Familiar ready | Electron ${process.versions.electron} | userData ${app.getPath('userData')}`,
  )
}
app.on('before-quit', () => {
  quitting = true
  controller?.abort()
  if (pet && !pet.isDestroyed()) persistPosition()
})
app.on('window-all-closed', () => {
  if (quitting) app.quit()
})
if (!app.requestSingleInstanceLock()) app.quit()
else {
  app.on('second-instance', () => {
    if (chat && !chat.isDestroyed()) showChat()
  })
  app
    .whenReady()
    .then(start)
    .catch((error: unknown) => {
      console.error('Familiar startup failed', error)
      app.quit()
    })
}
