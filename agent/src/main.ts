import { createInterface } from 'node:readline'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import { IPC, type AgentEvent, type PetState } from '../../src/shared'
import type {
  AgentToShell,
  ShellToAgent,
  WindowLabel,
  UiAction,
} from '../../src/shared/protocol'
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
import { listPets, currentSkin, importCodexPets } from './pets'
import { petDimensions, resolveState } from './pet-logic'
import { dataDir, refreshProxy, accent, idleSeconds } from './system'

// Keep stdout exclusively for the wire protocol, including dependency diagnostics.
console.log =
  console.info =
  console.warn =
    (...args: unknown[]) => console.error(...args)
function send(message: AgentToShell) {
  process.stdout.write(JSON.stringify(message) + '\n')
}
function emit(
  channel: string,
  payload: unknown,
  target: WindowLabel | 'all' = 'all',
) {
  send({ kind: 'emit', channel, payload, target })
}
function broadcast(channel: string, payload: unknown) {
  emit(channel, payload)
}
function ui(action: UiAction) {
  send({ kind: 'ui', action })
}
let session = emptySession()
let capsuleOpen = false
let expandedTurn = false
let resetRequested = false
let bubbleTimer: ReturnType<typeof setTimeout> | undefined
let controller: AbortController | undefined
let state: PetState = 'idle'
const activity: Partial<Record<PetState, boolean>> = {}
let typingAt = 0
let greetedDay = ''
let petReady = false
let chatVisible = false
let chatFocused = false
let closing = false
const pendingApprovals = new Set<string>()
function publishSession() {
  broadcast(IPC.session, session)
}
function refreshState() {
  const next = resolveState(activity) as PetState
  if (next !== state) {
    state = next
    emit(IPC.petState, state, 'pet')
  }
}
function setCapsule(open: boolean) {
  capsuleOpen = open
  emit(IPC.capsule, open, 'pet')
  if (!open) {
    typingAt = 0
    activity.listening = false
    refreshState()
  }
}
function showChat() {
  activity.done = false
  refreshState()
  expandedTurn = true
  session = { ...session, origin: 'chat' }
  publishSession()
  setCapsule(false)
  emit(IPC.view, 'chat', 'chat')
  ui({ type: 'show-chat' })
}
async function greet() {
  if (!petReady) return
  const day = new Date().toLocaleDateString('en-CA')
  if (greetedDay === day) return
  greetedDay = day
  emit(IPC.petGesture, 'wave', 'pet')
  await writeFile(join(dataDir, 'pet-greeting.txt'), day, { mode: 0o600 })
}
let skins: Awaited<ReturnType<typeof listPets>> = []
function rebuildTray() {
  const settings = getSettings()
  ui({
    type: 'tray',
    pets: skins.map((skin) => ({ id: skin.id, name: skin.displayName })),
    currentPet: currentSkin(settings.pet.id).id,
    size: settings.pet.size,
  })
}
function updatePet() {
  const settings = getSettings()
  ui({ type: 'pet-size', ...petDimensions(settings.pet.size) })
  // Every window shows the pet (the chat header avatar too), so skin changes go to all.
  emit(IPC.petSkin, currentSkin(settings.pet.id), 'all')
  emit(IPC.petSize, settings.pet.size, 'pet')
}
async function run(window: WindowLabel | 'tray', input: unknown) {
  if (controller) throw new Error('已有对话正在运行')
  const text = z.string().trim().min(1).max(100000).parse(input)
  if (session.messages.length >= 498) throw new Error('请开启新对话')
  clearTimeout(bubbleTimer)
  expandedTurn = window === 'chat'
  session = beginTurn(session, text, window === 'pet' ? 'capsule' : 'chat')
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
      (item.type === 'tool-approval-request' && !chatVisible) ||
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
      activity.done = !item.stopped && (!chatVisible || !chatFocused)
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
}
function requireSender(window: string, allowed: string[]) {
  if (!allowed.includes(window)) throw new Error('Unauthorized IPC sender')
}
async function request(
  message: Extract<ShellToAgent, { kind: 'request' }>,
): Promise<unknown> {
  const { channel, args, window } = message
  const [input] = args
  switch (channel) {
    case IPC.settingsGet:
      return publicSettings()
    case IPC.settingsSave: {
      requireSender(window, ['settings'])
      // The window only lists directory rules; approvals may have added one since it loaded.
      const saved = await saveSettings({
        ...(input as Parameters<typeof saveSettings>[0]),
        dirRules: getSettings().dirRules,
      })
      updatePet()
      publishSession()
      rebuildTray()
      return saved
    }
    case IPC.sessionGet:
      return session
    case IPC.sessionNew:
      requireSender(window, ['chat', 'pet'])
      resetRequested = Boolean(controller)
      controller?.abort()
      pendingApprovals.clear()
      clearTimeout(bubbleTimer)
      session = emptySession()
      Object.assign(activity, {
        done: false,
        failed: false,
        thinking: false,
        talking: false,
        'needs-you': false,
      })
      refreshState()
      publishSession()
      return
    case IPC.agentRun:
      requireSender(window, ['chat', 'pet'])
      return run(window, input)
    case IPC.agentStop:
      requireSender(window, ['chat', 'pet'])
      controller?.abort()
      return
    case IPC.approval: {
      requireSender(window, ['chat'])
      const id = z.string().parse(input)
      const choice = z.enum(['approve', 'deny', 'always']).parse(args[1])
      if (!pendingApprovals.has(id)) throw new Error('Unknown approval')
      const dir = session.approvals.find((a) => a.id === id)?.dir
      if (choice === 'always') {
        if (!dir) throw new Error('这个请求不能记成目录规则')
        const settings = publicSettings()
        await saveSettings({
          ...settings,
          model: { ...settings.model, apiKey: undefined },
          dirRules: [
            ...settings.dirRules.filter((r) => r.path !== dir),
            { path: dir, access: 'allow' },
          ],
        })
      }
      const decision = choice === 'deny' ? 'deny' : 'approve'
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
      return
    }
    case IPC.toggleChat:
      if (window === 'pet') showChat()
      else if (window === 'chat') {
        ui({ type: 'hide-chat' })
        setCapsule(true)
      } else {
        requireSender(window, ['tray'])
        if (chatVisible) ui({ type: 'hide-chat' })
        else showChat()
      }
      return
    case IPC.settingsOpen:
      ui({ type: 'show-settings' })
      return
    case IPC.capsule:
      requireSender(window, ['pet'])
      setCapsule(z.boolean().parse(input))
      return
    case IPC.petSkin:
      return currentSkin(getSettings().pet.id)
    case IPC.petsList:
      skins = await listPets()
      rebuildTray()
      return skins
    case IPC.petsImport:
      skins = await importCodexPets()
      updatePet()
      rebuildTray()
      return skins
    case IPC.petsSelect:
    case IPC.petSizeSet: {
      requireSender(window, ['tray'])
      const settings = publicSettings()
      const pet = { ...settings.pet }
      if (channel === IPC.petsSelect) {
        const id = z.string().parse(input)
        if (!skins.some((s) => s.id === id)) throw new Error('Unknown pet')
        pet.id = id
      } else pet.size = z.enum(['small', 'medium', 'large']).parse(input)
      await saveSettings({
        ...settings,
        model: { ...settings.model, apiKey: undefined },
        pet,
      })
      updatePet()
      rebuildTray()
      return
    }
    case IPC.petFinished:
      requireSender(window, ['pet'])
      activity.failed = false
      refreshState()
      return
    case IPC.typing:
      requireSender(window, ['pet', 'chat'])
      activity.listening = z.boolean().parse(input)
      typingAt = activity.listening ? Date.now() : 0
      refreshState()
      return
    case IPC.ready:
      requireSender(window, ['pet', 'chat', 'settings'])
      emit(IPC.appearance, await accent(), window as WindowLabel)
      emit(IPC.session, session, window as WindowLabel)
      if (window === 'pet') {
        emit(IPC.petState, state, 'pet')
        emit(IPC.capsule, capsuleOpen, 'pet')
        emit(IPC.petSkin, currentSkin(getSettings().pet.id), 'pet')
        emit(IPC.petSize, getSettings().pet.size, 'pet')
        petReady = true
        await greet()
      }
      if (window === 'chat') {
        emit(IPC.view, 'chat', 'chat')
        // The chat may have asked for the skin before the shell finished spawning us.
        emit(IPC.petSkin, currentSkin(getSettings().pet.id), 'chat')
      }
      return
    case IPC.appQuit:
      requireSender(window, ['tray'])
      ui({ type: 'quit' })
      return
    default:
      throw new Error('Unknown channel: ' + channel)
  }
}
const requestSchema = z.object({
  kind: z.literal('request'),
  id: z.number().int(),
  window: z.enum(['pet', 'chat', 'settings', 'tray']),
  channel: z.string(),
  args: z.array(z.unknown()),
})
const signalSchema = z.object({
  kind: z.literal('signal'),
  signal: z.discriminatedUnion('name', [
    z.object({
      name: z.literal('chat-window'),
      visible: z.boolean(),
      focused: z.boolean(),
    }),
    z.object({ name: z.literal('app-activated') }),
    z.object({
      name: z.literal('pet-drag'),
      phase: z.enum(['move', 'end']),
      dx: z.number().finite(),
    }),
  ]),
})
async function handle(line: string) {
  try {
    const message = z
      .union([requestSchema, signalSchema])
      .parse(JSON.parse(line))
    if (message.kind === 'request') {
      try {
        const value = await request(message)
        if (!closing)
          send({ kind: 'response', id: message.id, ok: true, value })
      } catch (error) {
        if (!closing)
          send({
            kind: 'response',
            id: message.id,
            ok: false,
            error: error instanceof Error ? error.message : 'Request failed',
          })
      }
    } else {
      const signal = message.signal
      if (signal.name === 'chat-window') {
        chatVisible = signal.visible
        chatFocused = signal.focused
        if (chatVisible || chatFocused) {
          activity.done = false
          refreshState()
        }
      } else if (signal.name === 'app-activated')
        broadcast(IPC.appearance, await accent())
      else
        emit(
          IPC.petDrag,
          signal.phase === 'end' ? 'none' : signal.dx >= 0 ? 'right' : 'left',
          'pet',
        )
    }
  } catch {
    console.error('Invalid sidecar message')
  }
}
async function start() {
  await mkdir(dataDir, { recursive: true })
  await loadSettings()
  skins = await listPets()
  await refreshProxy()
  try {
    greetedDay = await readFile(join(dataDir, 'pet-greeting.txt'), 'utf8')
  } catch {
    /* First launch. */
  }
  updatePet()
  rebuildTray()
  const proxyTimer = setInterval(() => {
    void refreshProxy()
  }, 60000)
  const idleTimer = setInterval(() => {
    void idleSeconds()
      .then((seconds) => {
        activity.sleeping = seconds >= 600
        refreshState()
      })
      .catch(console.error)
  }, 30000)
  const stateTimer = setInterval(() => {
    activity.listening = typingAt > 0 && Date.now() - typingAt < 2000
    refreshState()
    void greet().catch(console.error)
  }, 500)
  const input = createInterface({ input: process.stdin, crlfDelay: Infinity })
  input.on('line', (line) => {
    void handle(line)
  })
  const cleanup = () => {
    if (closing) return
    closing = true
    controller?.abort()
    clearTimeout(bubbleTimer)
    for (const timer of [proxyTimer, idleTimer, stateTimer])
      clearInterval(timer)
    input.close()
    process.exit(0)
  }
  input.on('close', cleanup)
  process.once('SIGTERM', cleanup)
  process.once('SIGINT', cleanup)
}
void start().catch((error) => {
  console.error('Familiar startup failed', error)
  process.exit(1)
})
