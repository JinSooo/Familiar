import { createInterface } from 'node:readline'
import { homedir } from 'node:os'
import { migrateLegacyWorkspace } from './migrate'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import { optionalArg } from './ipc-args'
import { startLog } from './log'
import { grantedRule, withRule } from './permissions'
import {
  IPC,
  attachmentSchema,
  petDimensions,
  petScalePresets,
  proactiveChoices,
  settingsSchema,
  trayTier,
  type AgentEvent,
  type Attachment,
  type PetState,
  type Session,
} from '../../src/shared'
import type {
  AgentToShell,
  ShellToAgent,
  WindowLabel,
  UiAction,
} from '../../src/shared/protocol'
import { windowLabels } from '../../src/shared/protocol'
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
  expandTo,
  blurHides,
  quickStartsFresh,
  bubbleTimeout,
  rewind,
  modelHistory,
} from './session'
import { runAgent, resolveApproval } from './agent'
import {
  defaultPersona,
  personaLimit,
  readPersona,
  savePersona,
} from './agent/persona'
import { listModels, testModel } from './agent/probe'
import {
  cancelSignIn,
  chatGptStatus,
  signIn as chatGptSignIn,
  signOut as chatGptSignOut,
} from './agent/chatgpt-auth'
import {
  listPets,
  currentSkin,
  currentSheetPath,
  importCodexPets,
  petCreatePrompt,
  deletePet,
} from './pets'
import { setComputerHooks, stopComputer } from './computer'
import {
  clearConversations,
  conversationTitle,
  deleteConversation,
  listConversations,
  loadConversation,
  saveConversation,
  newConversationId,
} from './conversations'
import {
  attachmentFile,
  maxAttachmentBytes,
  readAttachment,
  saveAttachment,
} from './attachments'
import { resolveState } from './pet-logic'
import {
  checkNow,
  noteConversation,
  petVisibilityChanged,
  noticeActivity,
  proactiveChanged,
  proactiveStatus,
  reopen as reopenProactive,
  respond,
  resumeProactive,
  startProactive,
  stopProactive,
} from './proactive'
import { updateReminders } from './proactive/reminders'
import { mentions, openMemory } from './memory'
import { recordFeedback } from './memory/feedback'
import { reflectDue } from './memory/jobs'
import {
  addKnowledgeFolder,
  knowledgeStatus,
  reindexKnowledge,
  removeKnowledgeFolder,
  revealKnowledge,
  startKnowledge,
  stopKnowledge,
  syncKnowledge,
} from './knowledge/manage'
import {
  cancelLocalModelDownload,
  deleteLocalModel,
  downloadLocalModel,
  localModelStatus,
  onLocalModelChanged,
  stopLeftoverServer,
  stopLocalServer,
} from './local-embedding'
import { ensureWorkspace, snapshot } from './workspace'
import {
  appCandidates,
  appIcons,
  applyPerceptionSettings,
  clearEvents,
  grantAccess,
  perceptionStatus,
  todayUsage,
  recentEvents,
  onActivityDigest,
  startPerception,
  stopPerception,
  summarizeDue,
  buffer as perceptionBuffer,
} from './perception'
import { currentMood, moodOf, setMood } from './mood'
import { readState as readProactiveState } from './proactive/state'
import type {
  Extensions,
  MemoryChange,
  MemoryItem,
  ShortcutAction,
  ShortcutFailure,
} from '../../src/shared'
import {
  closeMcp,
  mcpCandidates,
  mcpFile,
  mcpStatus,
  mcpTools,
  resetMcp,
  updateMcpServer,
} from './extensions/mcp'
import {
  importSkill,
  listSkills,
  removeSkill,
  skillCandidates,
} from './extensions/skills'
import {
  dataDir,
  conversationsDir,
  refreshProxy,
  idleSeconds,
  directorySize,
  openExternal,
  reveal,
} from './system'

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
/** Whether the quick-ask bar is on screen: every show and hide goes through ui(). */
let quickShown = false
let petShown = true
function ui(action: UiAction) {
  if (action.type === 'show-quick') quickShown = true
  if (action.type === 'hide-quick') quickShown = false
  if (action.type === 'pet-visible') {
    petShown = action.visible
    petVisibilityChanged(petShown)
  }
  send({ kind: 'ui', action })
}
/** Window alpha for the floating panels and for the settings and big windows. */
function applyOpacity() {
  const settings = getSettings()
  ui({
    type: 'panel-opacity',
    value: settings.panelOpacity,
    windows: settings.windowOpacity,
  })
}
let session = emptySession()
let capsuleOpen = false
let expandedTurn = false
let resetRequested = false
let bubbleTimer: ReturnType<typeof setTimeout> | undefined
let controller: AbortController | undefined
let operationDone: Promise<void> | undefined

/** Reserve before any await, including attachment I/O and conversation changes. */
async function withSessionOperation(
  work: (run: AbortController) => Promise<void>,
): Promise<void> {
  if (controller || resetRequested) throw new Error('已有对话正在运行')
  const own = new AbortController()
  controller = own
  let release!: () => void
  const done = new Promise<void>((resolve) => {
    release = resolve
  })
  operationDone = done
  try {
    await work(own)
  } catch (error) {
    if (!own.signal.aborted) throw error
  } finally {
    if (controller === own) controller = undefined
    if (operationDone === done) operationDone = undefined
    release()
  }
}

let state: PetState = 'idle'
const activity: Partial<Record<PetState, boolean>> = {}
let typingAt = 0
/** Some window's composer holds unsent text; leaving must not throw it away. */
let hasDraft = false
let greetedDay = ''
let petReady = false
let chatVisible = false
let chatFocused = false
let mainVisible = false
let mainFocused = false
/** Where the running turn was sent from; the big window shows its own approvals and replies. */
let turnWindow: WindowLabel | 'tray' = 'chat'
let closing = false
const pendingApprovals = new Set<string>()
function publishSession() {
  broadcast(IPC.session, session)
}
/** Write the transcript; a failed save must never break the conversation itself. */
function persist(snapshot = session) {
  void saveConversation(
    { ...snapshot, running: false },
    getSettings().pet.name,
  ).catch((error) => console.error('Saving conversation failed', error))
}
// Unsaved model settings from the settings window; an empty key falls back to the saved one.
const modelDraft = settingsSchema.shape.model
/** After this long without a message, the capsule starts a fresh conversation. */
const idleRestart = 2 * 60 * 60 * 1000
/** Opening a conversation counts as activity without rewriting its saved time. */
let openedAt = 0
async function memory() {
  const workspace = await ensureWorkspace(getSettings())
  await snapshot(workspace, 'familiar: 保存之前的改动')
  return { workspace, ...openMemory() }
}
function memoryChanged(change: MemoryChange = {}) {
  broadcast(IPC.memoryChanged, change)
}
/** Reflect in the background; failures (no model set, relay down) only reach the log or the memory page. */
function reflect(force = false) {
  void reflectDue(session.id, force)
    .then((result) => {
      if (force || result.conversations) memoryChanged({ reflect: result })
    })
    .catch((error) => {
      console.error('Reflection failed', error)
      if (force)
        memoryChanged({
          reflect: {
            error: error instanceof Error ? error.message : '整理失败',
          },
        })
    })
}
/** Run after the user leaves a conversation, once the new one has been published. */
function reflectSoon() {
  setTimeout(() => reflect(), 3000)
}
async function memoryEdit(
  work: (m: Awaited<ReturnType<typeof memory>>) => Promise<string>,
) {
  const m = await memory()
  const message = await work(m)
  await snapshot(m.workspace, `familiar: ${message}`)
  memoryChanged()
}
let shortcutFailures: ShortcutFailure[] = []
let petHidden = false
function sendShortcuts() {
  ui({ type: 'shortcuts', bindings: getSettings().shortcuts })
}
function setPetVisible(visible: boolean) {
  petHidden = !visible
  if (!visible) dismissChat()
  ui({ type: 'pet-visible', visible })
}
// While Computer Use acts, the pet rides its cursor instead of sitting on the desktop.
setComputerHooks({
  petVisible: (visible) => {
    if (!petHidden) ui({ type: 'pet-visible', visible })
  },
  stop: () => controller?.abort(),
  sheet: () => currentSheetPath(getSettings().pet.id),
  rate: () => getSettings().pet.rate,
})
function shortcut(action: ShortcutAction) {
  if (action === 'togglePet') return setPetVisible(petHidden)
  if (action === 'quick') {
    const settings = getSettings()
    const fresh = quickStartsFresh({
      mode: settings.quickOpen,
      idleMinutes: settings.quickIdleMinutes,
      shown: quickShown,
      running: Boolean(controller) || resetRequested,
      messages: session.messages.length,
      lastActivity: Math.max(session.updatedAt, openedAt),
      now: Date.now(),
    })
    // One conversation on screen at a time: the bar takes over from panel and capsule.
    dismissChat()
    if (fresh) startFresh()
    return ui({ type: 'show-quick' })
  }
  if (petHidden) setPetVisible(true)
  if (action === 'main') {
    dismissChat()
    emit(IPC.view, 'chat', 'main')
    return ui({ type: 'show-main' })
  }
  if (action === 'newChat') {
    if (controller || resetRequested) return
    startFresh()
  }
  // summon (and a new chat) put the user in the capsule, ready to type.
  if (chatVisible) ui({ type: 'show-chat' })
  else {
    restartIfIdle()
    setCapsule(true)
  }
}
async function extensions(connect: boolean): Promise<Extensions> {
  if (connect) await mcpTools().catch(console.error)
  return {
    mcp: await mcpStatus(),
    skills: await listSkills(),
    mcpFile: mcpFile(),
  }
}
function startFresh() {
  const previous = session.messages.length
    ? { id: session.id, title: conversationTitle(session.messages) }
    : session.previous
  // An idle conversation is already on disk; only a run being cut off has unsaved output.
  if (controller && session.messages.length) persist()
  clearTimeout(bubbleTimer)
  session = { ...emptySession(), ...(previous ? { previous } : {}) }
  publishSession()
  reflectSoon()
}
function restartIfIdle() {
  if (
    !controller &&
    !resetRequested &&
    session.messages.length &&
    Date.now() - Math.max(session.updatedAt, openedAt) > idleRestart
  )
    startFresh()
}
async function openConversation(id: string) {
  return withSessionOperation(async (run) => {
    const stored = await loadConversation(id)
    run.signal.throwIfAborted()
    clearTimeout(bubbleTimer)
    session = {
      ...emptySession(),
      id: stored.id,
      updatedAt: stored.updatedAt,
      messages: stored.messages,
      tools: stored.tools,
    }
    // The idle restart must not set it aside again on the next message.
    openedAt = Date.now()
    publishSession()
    reflectSoon()
  })
}

let failedAt: number | undefined
let chattedAt: number | undefined
/** Recomputes the mood from what already happened and tells the pet and the panel if it moved. */
async function refreshMood() {
  const now = Date.now()
  const settings = getSettings()
  const watching = settings.perception.enabled && !settings.perception.paused
  const events = watching
    ? await perceptionBuffer.read(now - 4 * 3600000).catch(() => [])
    : []
  const welcomedAt = (
    await readProactiveState().catch(() => undefined)
  )?.history
    .filter((m) => m.response === 'ok' && m.trigger !== 'reminder')
    .reduce((t, m) => Math.max(t, m.at), 0)
  const next = moodOf({
    now,
    hour: new Date(now).getHours(),
    events,
    failedAt,
    chattedAt,
    welcomedAt: welcomedAt || undefined,
  })
  if (setMood(next)) {
    emit(IPC.petMood, next, 'pet')
    emit(IPC.petMood, next, 'panel')
  }
}
function refreshState(force = false) {
  // A proactive bubble waiting for an answer keeps the pet in its waiting pose, like an approval.
  const next = resolveState({
    ...activity,
    'needs-you': activity['needs-you'] || Boolean(session.proactive),
  }) as PetState
  if (force || next !== state) {
    state = next
    emit(IPC.petState, state, 'pet')
    emit(IPC.petState, state, 'panel')
  }
}
function setCapsule(open: boolean) {
  capsuleOpen = open
  emit(IPC.capsule, open, 'pet')
  // Key status lets the capsule take typing and later report that the user left.
  if (open) ui({ type: 'focus-pet' })
  if (!open) {
    hasDraft = false
    typingAt = 0
    activity.listening = false
    refreshState()
  }
}
/** Back to just the pet: no panel, no capsule. A running reply still lands in the bubble. */
function dismissChat() {
  if (chatVisible) ui({ type: 'hide-chat' })
  if (capsuleOpen) setCapsule(false)
  ui({ type: 'hide-quick' })
}
/** One conversation on screen at a time: the big window takes over from panel, capsule and quick bar. */
function showMain() {
  dismissChat()
  emit(IPC.view, 'chat', 'main')
  ui({ type: 'show-main' })
}
function showChat() {
  activity.done = false
  refreshState()
  expandedTurn = true
  session = { ...session, origin: 'chat' }
  publishSession()
  setCapsule(false)
  ui({ type: 'hide-quick' })
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
    size: trayTier(settings.pet.scale),
    perception: !settings.perception.enabled
      ? 'off'
      : settings.perception.paused
        ? 'paused'
        : 'on',
  })
}
/** The pet window grows while a proactive bubble shows: its reason and buttons need the room. */
function sizePet() {
  const size = petDimensions(getSettings().pet.scale)
  ui({
    type: 'pet-size',
    ...size,
    // The first-run naming card needs the same room.
    height:
      size.height + (session.proactive || !getSettings().pet.named ? 90 : 0),
  })
}
function updatePet() {
  const settings = getSettings()
  sizePet()
  // Every window shows the pet (the chat header avatar too), so skin changes go to all.
  emit(IPC.petSkin, currentSkin(settings.pet.id), 'all')
  emit(IPC.petSize, settings.pet.scale, 'pet')
  // The chat panel's perched pet animates too.
  emit(IPC.petSpeed, settings.pet.rate, 'all')
  emit(IPC.petWander, settings.pet.wander, 'pet')
}
/** Files sent with a message: name and base64 bytes, saved before the turn starts. */
const uploadSchema = z
  .array(
    z.object({
      name: z.string().min(1).max(200),
      data: z.string().max(Math.ceil((maxAttachmentBytes * 4) / 3) + 4),
    }),
  )
  .max(10)
const messageText = z.string().trim().max(100000)
async function run(
  window: WindowLabel | 'tray',
  input: unknown,
  files: unknown = [],
) {
  if (controller || resetRequested) throw new Error('已有对话正在运行')
  const uploads = uploadSchema.parse(files ?? [])
  const text = messageText.parse(input ?? '')
  if (!text && !uploads.length) throw new Error('消息是空的')
  if (session.messages.length >= 498) throw new Error('请开启新对话')
  clearTimeout(bubbleTimer)
  if (window === 'pet') restartIfIdle()
  return withSessionOperation(async (run) => {
    // The conversation id exists before the files are written beside it.
    if (!session.id) session = { ...session, id: newConversationId() }
    const attachments = []
    for (const u of uploads) {
      run.signal.throwIfAborted()
      attachments.push(
        await saveAttachment(session.id, u.name, Buffer.from(u.data, 'base64')),
      )
    }
    run.signal.throwIfAborted()
    noteConversation()
    chattedAt = Date.now()
    void refreshMood()
    await turn(window, text, attachments, run)
  })
}

/**
 * Runs again from one of the user's messages: it and everything after it go, and it is sent
 * again, edited when `input` is given, with the files it had. Retry, regenerate and edit.
 */
async function resend(
  window: WindowLabel | 'tray',
  index: unknown,
  input: unknown,
) {
  return withSessionOperation(async (run) => {
    const at = z.number().int().min(0).parse(index)
    const { session: before, message } = rewind(session, at)
    const text = optionalArg(messageText).parse(input) ?? message.content
    if (!text && !message.attachments?.length) throw new Error('消息是空的')
    clearTimeout(bubbleTimer)
    session = before
    await turn(window, text, message.attachments ?? [], run)
  })
}

/**
 * A new conversation holding this one up to and including message `index`; its files are
 * copied so either can be deleted on its own. The copy opens; the original stays as it was.
 */
async function branch(index: unknown) {
  return withSessionOperation(async (run) => {
    const at = z
      .number()
      .int()
      .min(0)
      .max(session.messages.length - 1)
      .parse(index)
    if (!session.id) throw new Error('这个对话还没有内容')
    persist()
    const id = newConversationId()
    const messages = []
    for (const m of session.messages.slice(0, at + 1)) {
      run.signal.throwIfAborted()
      const attachments = []
      for (const a of m.attachments ?? []) {
        try {
          const copy = await saveAttachment(
            id,
            a.name,
            await readAttachment(a),
            a.mediaType,
          )
          attachments.push(a.at === undefined ? copy : { ...copy, at: a.at })
        } catch {
          // A file already gone stays gone in the copy too.
        }
      }
      messages.push({
        ...m,
        ...(m.attachments ? { attachments } : {}),
      })
    }
    const copy: Session = {
      ...emptySession(),
      id,
      updatedAt: Date.now(),
      messages,
      tools: session.tools
        .filter((t) => t.turn <= at)
        .map((t) => ({ ...t, id: `${id}-${t.id}` })),
    }
    await saveConversation(copy, getSettings().pet.name)
    run.signal.throwIfAborted()
    clearTimeout(bubbleTimer)
    session = copy
    openedAt = Date.now()
    publishSession()
  })
}

async function turn(
  window: WindowLabel | 'tray',
  text: string,
  attachments: Attachment[],
  run: AbortController,
) {
  run.signal.throwIfAborted()
  expandedTurn = window === 'chat' || window === 'main'
  turnWindow = window
  session = beginTurn(
    session,
    text,
    window === 'pet' ? 'capsule' : 'chat',
    attachments,
  )
  persist()
  const messages = modelHistory(session)
  publishSession()
  Object.assign(activity, {
    thinking: true,
    talking: false,
    failed: false,
    done: false,
  })
  refreshState()
  const emit = (item: AgentEvent): void => {
    if (resetRequested || controller !== run) return
    session = reduceSession(session, item)
    publishSession()
    const target = expandTo({
      turnWindow,
      mainVisible,
      chatVisible,
      approvalRequested: item.type === 'tool-approval-request',
      needsRoom: shouldExpand(session),
      expanded: expandedTurn,
    })
    // A turn from the quick bar grows into the big window, as its expand button does.
    if (target === 'main') {
      showMain()
      turnWindow = 'main'
      expandedTurn = true
    } else if (target === 'chat') showChat()

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
      failedAt = Date.now()
      void refreshMood()
      activity.done = false
    }
    if (item.type === 'finish')
      // A reply read in the quick-ask bar is not waiting to be seen.
      activity.done =
        !item.stopped &&
        turnWindow !== 'quick' &&
        !(chatVisible && chatFocused) &&
        !(mainVisible && mainFocused)
    if (item.type === 'tool-approval-request') {
      pendingApprovals.add(item.id)
      activity['needs-you'] = true
    }
    refreshState()
    broadcast(IPC.agentEvent, item)
  }
  try {
    await runAgent(messages, emit, run.signal, session.id)
  } catch (error) {
    // runAgent already turns model, network and config failures into user-facing Chinese messages.
    console.error('Agent run failed', error)
    emit({
      type: 'error',
      message: error instanceof Error ? error.message : '运行失败，请重试。',
    })
  } finally {
    if (controller === run) {
      if (!resetRequested) {
        session = {
          ...session,
          running: false,
          approvals: [],
          updatedAt: Date.now(),
        }
        persist()
      }
      publishSession()
      bubbleTimer = setTimeout(() => {
        session = { ...session, bubble: '' }
        refreshState()
        publishSession()
      }, bubbleTimeout(session.bubble))
      memoryChanged()
      pendingApprovals.clear()
      activity.thinking = false
      activity.talking = false
      activity['needs-you'] = false
      refreshState()
    }
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
      // Perception has its own channels (page and tray), so a stale form copy cannot undo them.
      const before = getSettings().embeddingModel
      const form = input as Parameters<typeof saveSettings>[0]
      const saved = await saveSettings({
        ...form,
        // A name changed on the settings page counts as the pet being named.
        pet: {
          ...form.pet,
          named:
            getSettings().pet.named || form.pet.name !== getSettings().pet.name,
        },
        dirRules: getSettings().dirRules,
        perception: getSettings().perception,
        // Folders are added and removed on the knowledge page's own channels.
        knowledge: getSettings().knowledge,
      })
      const after = getSettings().embeddingModel
      // A new embedding model (or its key) means the knowledge base has vectors to make.
      if (
        before.source !== after.source ||
        before.model !== after.model ||
        before.baseURL !== after.baseURL ||
        before.apiKey !== after.apiKey
      ) {
        if (after.source !== 'local') stopLocalServer()
        void syncKnowledge()
      }
      updatePet()
      broadcast(IPC.appearance, saved.panelOpacity)
      applyOpacity()
      publishSession()
      rebuildTray()
      sendShortcuts()
      applyPerceptionSettings()
      return saved
    }
    case IPC.sessionGet:
      return session
    case IPC.sessionNew: {
      requireSender(window, ['chat', 'pet', 'tray', 'main', 'panel', 'quick'])
      if (resetRequested) throw new Error('正在新建对话')
      resetRequested = true
      if (controller && session.messages.length) persist()
      controller?.abort()
      await operationDone
      pendingApprovals.clear()
      startFresh()
      resetRequested = false
      // From the tray, the pet menu or the menu bar panel: put the user somewhere they can type.
      if (window === 'tray' || window === 'panel') {
        if (chatVisible) emit(IPC.view, 'chat', 'chat')
        else setCapsule(true)
      }
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
    }
    case IPC.conversationsList:
      requireSender(window, ['chat', 'settings', 'main', 'panel'])
      return listConversations(optionalArg(z.string().max(200)).parse(input))
    case IPC.conversationsOpen:
      requireSender(window, ['chat', 'pet', 'main', 'settings', 'panel'])
      return openConversation(z.string().parse(input))
    case IPC.conversationsDelete: {
      requireSender(window, ['chat', 'main'])
      const id = z.string().parse(input)
      if (id === session.id && controller)
        throw new Error('正在进行的对话不能删除，先停止它')
      return withSessionOperation(async (run) => {
        await deleteConversation(id)
        run.signal.throwIfAborted()
        if (id === session.id) {
          clearTimeout(bubbleTimer)
          session = emptySession()
        } else if (session.previous?.id === id)
          session = { ...session, previous: undefined }
        publishSession()
      })
    }
    case IPC.conversationsClear:
      requireSender(window, ['settings'])
      return withSessionOperation(async (run) => {
        await clearConversations()
        run.signal.throwIfAborted()
        clearTimeout(bubbleTimer)
        session = emptySession()
        publishSession()
      })
    case IPC.conversationsReveal:
      requireSender(window, ['chat', 'settings', 'main'])
      await mkdir(conversationsDir, { recursive: true })
      await reveal(conversationsDir)
      return
    case IPC.dirRuleRemove: {
      requireSender(window, ['settings'])
      const path = z.string().parse(input)
      const settings = publicSettings()
      const saved = await saveSettings({
        ...settings,
        model: { ...settings.model, apiKey: undefined },
        imageModel: { ...settings.imageModel, apiKey: undefined },
        dirRules: settings.dirRules.filter((r) => r.path !== path),
      })
      broadcast(IPC.dirRulesChanged, saved.dirRules)
      return saved.dirRules
    }
    case IPC.modelsList:
      requireSender(window, ['settings'])
      return listModels(modelDraft.parse(input))
    case IPC.modelTest:
      requireSender(window, ['settings'])
      return testModel(modelDraft.parse(input))
    case IPC.chatgptStatus:
      requireSender(window, ['settings', 'panel'])
      return chatGptStatus()
    case IPC.chatgptSignIn:
      requireSender(window, ['settings'])
      return chatGptSignIn(openExternal)
    case IPC.chatgptCancel:
      requireSender(window, ['settings'])
      cancelSignIn()
      return
    case IPC.chatgptSignOut:
      requireSender(window, ['settings'])
      return chatGptSignOut()
    case IPC.chatDismiss:
      requireSender(window, ['chat'])
      dismissChat()
      return
    case IPC.chatOpen:
      requireSender(window, ['tray'])
      showChat()
      return
    case IPC.mainOpen:
      requireSender(window, [
        'chat',
        'pet',
        'tray',
        'settings',
        'panel',
        'quick',
      ])
      showMain()
      return
    case IPC.chatHistory:
      requireSender(window, ['tray'])
      showChat()
      emit(IPC.view, 'history', 'chat')
      return
    case IPC.agentRun:
      requireSender(window, ['chat', 'pet', 'main', 'quick'])
      return run(window, input, args[1])
    case IPC.agentResend:
      requireSender(window, ['chat', 'main'])
      return resend(window, input, args[1])
    case IPC.conversationsBranch:
      requireSender(window, ['chat', 'main'])
      return branch(input)
    case IPC.agentStop:
      requireSender(window, ['chat', 'pet', 'main', 'quick'])
      controller?.abort()
      return
    case IPC.approval: {
      requireSender(window, ['chat', 'main'])
      const id = z.string().parse(input)
      const choice = z.enum(['approve', 'deny', 'always']).parse(args[1])
      if (!pendingApprovals.has(id)) throw new Error('Unknown approval')
      const owner = controller
      const approval = session.approvals.find((a) => a.id === id)
      if (choice === 'always' && approval?.server) {
        const server = approval.server
        await updateMcpServer(server, (entry) =>
          entry ? { ...entry, access: 'allow' } : null,
        )
      }
      // "Allow all" is remembered as a directory rule, which settings lists and can take back;
      // a plain "allow" lets only this request through.
      const rule =
        choice === 'always' && approval ? grantedRule(approval) : undefined
      if (rule) {
        const settings = publicSettings()
        const saved = await saveSettings({
          ...settings,
          model: { ...settings.model, apiKey: undefined },
          imageModel: { ...settings.imageModel, apiKey: undefined },
          dirRules: withRule(settings.dirRules, rule),
        })
        broadcast(IPC.dirRulesChanged, saved.dirRules)
      }
      if (
        controller !== owner ||
        owner?.signal.aborted ||
        !pendingApprovals.has(id)
      )
        return
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
      if (window === 'pet' || window === 'quick') showChat()
      else if (window === 'chat') {
        ui({ type: 'hide-chat' })
        setCapsule(true)
      } else {
        requireSender(window, ['tray'])
        if (chatVisible) ui({ type: 'hide-chat' })
        else showChat()
      }
      return
    case IPC.settingsOpen: {
      const page = optionalArg(
        z.enum(['timeline', 'pending', 'proactive', 'model', 'permissions']),
      ).parse(input)
      if (page) emit(IPC.settingsPage, page, 'settings')
      ui({ type: 'show-settings' })
      return
    }
    case IPC.quickHide:
      requireSender(window, ['quick'])
      ui({ type: 'hide-quick' })
      return
    case IPC.capsule: {
      requireSender(window, ['pet'])
      const open = z.boolean().parse(input)
      if (open) restartIfIdle()
      setCapsule(open)
      return
    }
    case IPC.petSkin:
      return currentSkin(getSettings().pet.id)
    case IPC.petsList:
      skins = await listPets()
      rebuildTray()
      return skins
    case IPC.petsCreatePrompt:
      requireSender(window, ['settings'])
      return petCreatePrompt()
    case IPC.petsDelete: {
      requireSender(window, ['settings'])
      const id = z.string().parse(input)
      await deletePet(id)
      skins = await listPets()
      const settings = publicSettings()
      // The pet on screen was the one deleted: back to the default.
      if (settings.pet.id === id)
        await saveSettings({
          ...settings,
          model: { ...settings.model, apiKey: undefined },
          imageModel: { ...settings.imageModel, apiKey: undefined },
          pet: { ...settings.pet, id: 'xiaohei-q' },
        })
      updatePet()
      rebuildTray()
      return skins
    }
    case IPC.petMood:
      requireSender(window, ['pet', 'panel'])
      return currentMood()
    case IPC.petName: {
      requireSender(window, ['pet'])
      const name = settingsSchema.shape.pet.parse({ name: input }).name
      const settings = publicSettings()
      await saveSettings({
        ...settings,
        model: { ...settings.model, apiKey: undefined },
        imageModel: { ...settings.imageModel, apiKey: undefined },
        pet: { ...settings.pet, name, named: true },
      })
      sizePet()
      rebuildTray()
      publishSession()
      emit(IPC.petGesture, 'wave', 'pet')
      return
    }
    case IPC.petFocus:
      requireSender(window, ['pet'])
      ui({ type: 'focus-pet' })
      return
    case IPC.personaGet: {
      requireSender(window, ['settings'])
      const text = await readPersona()
      return { text: text || defaultPersona, isDefault: !text }
    }
    case IPC.personaSave:
      requireSender(window, ['settings'])
      await savePersona(z.string().max(personaLimit).parse(input))
      return
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
      } else
        pet.scale =
          petScalePresets[z.enum(['small', 'medium', 'large']).parse(input)]
      await saveSettings({
        ...settings,
        model: { ...settings.model, apiKey: undefined },
        imageModel: { ...settings.imageModel, apiKey: undefined },
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
      requireSender(window, ['pet', 'chat', 'main', 'quick'])
      activity.listening = z.boolean().parse(input)
      hasDraft = activity.listening
      typingAt = activity.listening ? Date.now() : 0
      refreshState()
      return
    case IPC.ready:
      requireSender(window, [
        'pet',
        'chat',
        'settings',
        'main',
        'panel',
        'quick',
      ])
      emit(IPC.appearance, getSettings().panelOpacity, window as WindowLabel)
      if (window === 'panel') {
        emit(IPC.petState, state, 'panel')
        emit(IPC.petSkin, currentSkin(getSettings().pet.id), 'panel')
        return
      }
      emit(IPC.session, session, window as WindowLabel)
      if (window === 'pet') {
        emit(IPC.petState, state, 'pet')
        emit(IPC.capsule, capsuleOpen, 'pet')
        emit(IPC.petSkin, currentSkin(getSettings().pet.id), 'pet')
        emit(IPC.petSize, getSettings().pet.scale, 'pet')
        emit(IPC.petSpeed, getSettings().pet.rate, 'pet')
        emit(IPC.petWander, getSettings().pet.wander, 'pet')
        petReady = true
        await greet()
      }
      if (window === 'chat' || window === 'main') {
        emit(IPC.view, 'chat', window)
        // The chat may have asked for the skin before the shell finished spawning us.
        emit(IPC.petSkin, currentSkin(getSettings().pet.id), window)
      }
      return
    case IPC.memoryList: {
      requireSender(window, ['settings', 'panel'])
      const { store } = await memory()
      return (await store.list()).map(({ seen, ...entry }): MemoryItem => ({
        ...entry,
        ...(seen ? { seen: seen.length } : {}),
      }))
    }
    case IPC.memoryConfirm: {
      requireSender(window, ['settings'])
      const id = z.string().parse(input)
      const text = optionalArg(z.string().trim().min(1).max(300)).parse(args[1])
      await memoryEdit(async ({ store }) => {
        const entry = await store.get(id)
        await store.confirm(id, text)
        if (entry)
          await recordFeedback(
            text && text !== entry.text ? 'correct' : 'confirm',
            entry,
            text,
          )
        return 'confirm memory'
      })
      return
    }
    case IPC.memoryCorrect: {
      requireSender(window, ['settings'])
      const id = z.string().parse(input)
      const text = z.string().trim().min(1).max(300).parse(args[1])
      await memoryEdit(async ({ store }) => {
        const entry = await store.get(id)
        await store.correct(id, text)
        if (entry?.source === 'reflection')
          await recordFeedback('correct', entry, text)
        return 'correct memory'
      })
      return
    }
    case IPC.memoryDelete: {
      requireSender(window, ['settings'])
      const id = z.string().parse(input)
      let also: MemoryItem[] = []
      await memoryEdit(async ({ store }) => {
        const entry = await store.remove(id)
        if (entry.status === 'pending') await recordFeedback('reject', entry)
        // A deleted fact may still be restated in the timeline; the page offers to delete those too.
        else if (entry.category !== 'timeline')
          also = mentions(await store.list(), entry).map(
            ({ seen, ...e }): MemoryItem => ({
              ...e,
              ...(seen ? { seen: seen.length } : {}),
            }),
          )
        return 'delete memory'
      })
      return also
    }
    case IPC.memoryReflect:
      requireSender(window, ['settings'])
      reflect(true)
      return
    case IPC.dataInfo: {
      requireSender(window, ['settings'])
      return { path: dataDir, bytes: await directorySize(dataDir) }
    }
    case IPC.attachmentOpen: {
      requireSender(window, ['chat', 'main'])
      const attachment = attachmentSchema.shape.path.parse(input)
      await reveal(attachmentFile(attachment))
      return
    }
    case IPC.dataReveal:
      requireSender(window, ['settings'])
      await reveal(dataDir)
      return
    case IPC.knowledgeStatus:
      requireSender(window, ['settings'])
      return knowledgeStatus()
    case IPC.knowledgeAdd:
      requireSender(window, ['settings'])
      return addKnowledgeFolder()
    case IPC.knowledgeRemove:
      requireSender(window, ['settings'])
      return removeKnowledgeFolder(z.string().min(1).parse(input))
    case IPC.knowledgeReindex:
      requireSender(window, ['settings'])
      void reindexKnowledge()
      return
    case IPC.knowledgeReveal:
      // Settings opens folders; the chat windows open a cited file.
      requireSender(window, ['settings', 'chat', 'main', 'quick'])
      await revealKnowledge(z.string().min(1).parse(input))
      return
    case IPC.localModelStatus:
      requireSender(window, ['settings'])
      return localModelStatus()
    case IPC.localModelDownload:
      requireSender(window, ['settings'])
      // Once it is in place the knowledge base has vectors to make.
      await downloadLocalModel(() => void syncKnowledge())
      return
    case IPC.localModelCancel:
      requireSender(window, ['settings'])
      cancelLocalModelDownload()
      return
    case IPC.localModelDelete:
      requireSender(window, ['settings'])
      await deleteLocalModel()
      void syncKnowledge()
      return
    case IPC.memoryReveal: {
      requireSender(window, ['settings'])
      const { store } = await memory()
      await mkdir(store.dir, { recursive: true })
      await reveal(store.dir)
      return
    }
    case IPC.shortcut:
      requireSender(window, ['tray'])
      shortcut(
        z
          .enum(['summon', 'main', 'togglePet', 'newChat', 'quick'])
          .parse(input),
      )
      return
    case IPC.shortcutStatus:
      requireSender(window, ['settings'])
      return shortcutFailures
    case IPC.extensionsGet:
      requireSender(window, ['settings'])
      return extensions(optionalArg(z.boolean()).parse(input) ?? false)
    case IPC.mcpAccess: {
      requireSender(window, ['settings'])
      const name = z.string().parse(input)
      const access = z.enum(['allow', 'ask', 'off']).parse(args[1])
      await updateMcpServer(name, (entry) =>
        entry ? { ...entry, access } : null,
      )
      resetMcp(name)
      return
    }
    case IPC.mcpRemove:
      requireSender(window, ['settings'])
      await updateMcpServer(z.string().parse(input), () => null)
      resetMcp(z.string().parse(input))
      return
    case IPC.mcpCandidates:
      requireSender(window, ['settings'])
      return mcpCandidates()
    case IPC.mcpImport: {
      requireSender(window, ['settings'])
      const items = z
        .array(
          z.object({
            name: z.string().min(1).max(64),
            entry: z.record(z.string(), z.unknown()),
          }),
        )
        .parse(input)
      for (const { name, entry } of items)
        await updateMcpServer(name, (old) => old ?? { ...entry, access: 'ask' })
      return
    }
    case IPC.mcpReconnect:
      requireSender(window, ['settings'])
      resetMcp(z.string().parse(input))
      await mcpTools().catch(console.error)
      return
    case IPC.mcpReveal:
      requireSender(window, ['settings'])
      // Creates an empty config on first use, then opens it in the default editor.
      await updateMcpServer('', () => null)
      await reveal(mcpFile())
      return
    case IPC.skillCandidates:
      requireSender(window, ['settings'])
      return skillCandidates()
    case IPC.skillImport:
      requireSender(window, ['settings'])
      await importSkill(z.string().parse(input))
      return
    case IPC.skillRemove:
      requireSender(window, ['settings'])
      await removeSkill(z.string().parse(input))
      return
    case IPC.perceptionStatus:
      requireSender(window, ['settings', 'panel', 'pet'])
      return perceptionStatus()
    case IPC.usageToday:
      requireSender(window, ['panel'])
      return todayUsage()
    case IPC.perceptionRecent:
      requireSender(window, ['settings'])
      return recentEvents()
    case IPC.perceptionClear:
      requireSender(window, ['settings'])
      await clearEvents(
        z.union([z.literal('all'), z.number().int().positive()]).parse(input),
      )
      memoryChanged()
      return
    case IPC.perceptionIcons:
      requireSender(window, ['settings', 'panel'])
      return appIcons(z.array(z.string()).max(100).parse(input))
    case IPC.perceptionSummarize:
      requireSender(window, ['settings'])
      void summarizeDue(true)
        .catch(console.error)
        .finally(() => memoryChanged())
      return
    case IPC.perceptionApps:
      requireSender(window, ['settings'])
      return appCandidates()
    case IPC.perceptionGrant:
      requireSender(window, ['settings'])
      await grantAccess()
      return
    case IPC.perceptionSave: {
      requireSender(window, ['settings'])
      const settings = publicSettings()
      await saveSettings({
        ...settings,
        model: { ...settings.model, apiKey: undefined },
        imageModel: { ...settings.imageModel, apiKey: undefined },
        perception: settingsSchema.shape.perception.parse(input),
      })
      applyPerceptionSettings()
      rebuildTray()
      return getSettings().perception
    }
    case IPC.proactiveStatus:
      requireSender(window, ['settings', 'panel', 'pet'])
      return proactiveStatus()
    case IPC.proactiveRespond: {
      requireSender(window, ['pet', 'chat', 'main'])
      const id = z.string().parse(input)
      const choice = z.enum(['ok', 'later', 'quiet']).parse(args[1])
      const answered = await respond(id, choice)
      const message = session.proactive
      session = { ...session, proactive: undefined }
      sizePet()
      refreshState()
      // 好: the line becomes part of the conversation, so the reply has something to answer.
      if (
        choice === 'ok' &&
        answered &&
        message &&
        proactiveChoices(message.trigger).opensChat &&
        !controller
      ) {
        const now = Date.now()
        // After a long pause the line starts a fresh conversation, as the capsule would.
        restartIfIdle()
        session = {
          ...session,
          id: session.id || newConversationId(new Date(now)),
          updatedAt: now,
          messages: [
            ...session.messages,
            { role: 'assistant', content: message.text, createdAt: now },
          ],
        }
        persist()
        showChat()
      } else publishSession()
      return
    }
    case IPC.proactiveCheck:
      requireSender(window, ['settings'])
      return checkNow()
    case IPC.proactiveReopen:
      requireSender(window, ['pet', 'panel'])
      if (controller || capsuleOpen) throw new Error('正在对话，稍后再看')
      return reopenProactive(z.string().parse(input))
    case IPC.proactiveResume:
      requireSender(window, ['settings', 'panel'])
      return resumeProactive()
    case IPC.reminderCancel: {
      requireSender(window, ['settings'])
      const id = z.string().parse(input)
      await updateReminders((list) => ({
        list: list.filter((r) => r.id !== id),
        result: undefined,
      }))
      void proactiveChanged()
      return
    }
    case IPC.perceptionPause: {
      requireSender(window, ['tray', 'settings', 'panel'])
      const settings = publicSettings()
      const paused =
        optionalArg(z.boolean()).parse(input) ?? !settings.perception.paused
      await saveSettings({
        ...settings,
        model: { ...settings.model, apiKey: undefined },
        imageModel: { ...settings.imageModel, apiKey: undefined },
        perception: {
          ...settings.perception,
          paused,
        },
      })
      applyPerceptionSettings()
      rebuildTray()
      return
    }
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
  window: z.enum([...windowLabels, 'tray']),
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
    z.object({
      name: z.literal('main-window'),
      visible: z.boolean(),
      focused: z.boolean(),
    }),
    z.object({
      name: z.literal('shortcut-status'),
      failed: z.array(
        z.object({
          action: z.enum(['summon', 'main', 'togglePet', 'newChat', 'quick']),
          accelerator: z.string(),
          error: z.string(),
        }),
      ),
    }),
    z.object({ name: z.literal('blurred') }),
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
      } else if (signal.name === 'main-window') {
        mainVisible = signal.visible
        mainFocused = signal.focused
        if (mainVisible && mainFocused) {
          activity.done = false
          refreshState()
        }
      } else if (signal.name === 'shortcut-status') {
        shortcutFailures = signal.failed
      } else if (signal.name === 'blurred') {
        const hide = blurHides({
          autoHide: getSettings().chatAutoHide,
          quickAutoHide: getSettings().quickAutoHide,
          approvals: pendingApprovals.size,
          draft: hasDraft,
          running: Boolean(controller),
        })
        if (hide.chat) {
          if (chatVisible) ui({ type: 'hide-chat' })
          if (capsuleOpen) setCapsule(false)
        }
        if (hide.quick) ui({ type: 'hide-quick' })
      } else
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
/** Move the old ~/Familiar workspace into ~/.familiar once, then point the setting at it. */
async function migrate() {
  try {
    const moved = await migrateLegacyWorkspace(
      join(homedir(), 'Familiar'),
      dataDir,
      getSettings().workspacePath,
    )
    if (!moved) return
    const settings = publicSettings()
    await saveSettings({
      ...settings,
      model: { ...settings.model, apiKey: undefined },
      imageModel: { ...settings.imageModel, apiKey: undefined },
      workspacePath: moved,
    })
    await ensureWorkspace(getSettings())
    await snapshot(moved, 'familiar: move ~/Familiar into ~/.familiar')
  } catch (error) {
    console.error('Moving ~/Familiar into ~/.familiar failed', error)
  }
}
/** Pick up where the last run left off, or offer it as "previous" when it is old. */
async function restoreLatest() {
  try {
    const [latest] = await listConversations()
    if (!latest) return
    if (Date.now() - latest.updatedAt <= idleRestart)
      await openConversation(latest.id)
    else
      session = { ...session, previous: { id: latest.id, title: latest.title } }
  } catch (error) {
    console.error('Restoring conversation failed', error)
  }
}
async function start() {
  await mkdir(dataDir, { recursive: true })
  startLog()
  await loadSettings()
  await migrate()
  skins = await listPets()
  await refreshProxy()
  try {
    greetedDay = await readFile(join(dataDir, 'pet-greeting.txt'), 'utf8')
  } catch {
    /* First launch. */
  }
  await restoreLatest()
  // The shell may keep its WebViews alive across an agent restart.
  session = { ...session, running: false, bubble: '', proactive: undefined }
  refreshState(true)
  broadcast(IPC.petMood, currentMood())
  emit(IPC.capsule, capsuleOpen, 'pet')
  publishSession()
  broadcast(IPC.proactiveChanged, await proactiveStatus())
  updatePet()
  rebuildTray()
  sendShortcuts()
  applyOpacity()
  setPetVisible(getSettings().showPetOnLaunch)
  startPerception((status) => broadcast(IPC.perceptionChanged, status))
  onLocalModelChanged((status) => broadcast(IPC.localModelChanged, status))
  void stopLeftoverServer().catch(console.error)
  startKnowledge((status) => broadcast(IPC.knowledgeChanged, status))
  onActivityDigest((digest) => void noticeActivity(digest))
  startProactive({
    busy: () =>
      Boolean(controller) ||
      capsuleOpen ||
      chatVisible ||
      mainVisible ||
      quickShown ||
      hasDraft,
    visible: () => petShown,
    say: (message) => {
      clearTimeout(bubbleTimer)
      session = { ...session, proactive: message }
      sizePet()
      emit(IPC.petGesture, 'wave', 'pet')
      refreshState()
      publishSession()
    },
    changed: (status) => {
      // A bubble the user did not answer in time goes away.
      if (
        session.proactive &&
        status.history.find((m) => m.id === session.proactive?.id)?.response
      ) {
        session = { ...session, proactive: undefined }
        sizePet()
        refreshState()
        publishSession()
      }
      broadcast(IPC.proactiveChanged, status)
    },
  })
  const proxyTimer = setInterval(() => {
    void refreshProxy()
  }, 60000)
  const idleTimer = setInterval(() => {
    void idleSeconds()
      .then((seconds) => {
        // Energy, simple version (docs/design.md §9): late at night it dozes off sooner.
        const hour = new Date().getHours()
        const late = hour >= 23 || hour < 6
        activity.sleeping = seconds >= (late ? 120 : 600)
        refreshState()
        return refreshMood()
      })
      .catch(console.error)
  }, 30000)
  // Conversations that went quiet; the first pass also picks up what the last run left.
  const reflectTimer = setInterval(() => reflect(), 5 * 60000)
  reflectSoon()
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
    void closeMcp()
    stopPerception()
    stopKnowledge()
    stopLocalServer()
    stopProactive()
    stopComputer()
    clearTimeout(bubbleTimer)
    for (const timer of [proxyTimer, idleTimer, stateTimer, reflectTimer])
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
