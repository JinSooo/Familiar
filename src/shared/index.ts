import { z } from 'zod'
/** Pet size (a multiplier of the 192x208 sprite) and animation rate. The named presets are shortcuts. */
export const petScaleRange = { min: 0.4, max: 1.3 } as const
export const petRateRange = { min: 0.5, max: 2 } as const
export const petScalePresets = {
  small: 0.5,
  medium: 0.73,
  large: 0.95,
} as const
export const petRatePresets = { slow: 0.6, normal: 1, fast: 1.5 } as const
/** The pet window for a scale: the sprite plus room for the capsule and the bubble. */
export function petDimensions(scale: number) {
  return {
    width: Math.ceil((460 * scale) / 0.73),
    height: Math.ceil((330 * scale) / 0.73),
  }
}
/** Which menu bar size item to check; a value none of the three matches checks none. */
export function trayTier(
  scale: number,
): 'small' | 'medium' | 'large' | 'custom' {
  const hit = (['small', 'medium', 'large'] as const).find(
    (k) => petScalePresets[k] === scale,
  )
  return hit ?? 'custom'
}
/** Settings written before the numbers: size small / medium / large, speed slow / normal / fast. */
function legacyPet(value: unknown) {
  if (!value || typeof value !== 'object') return value
  const { size, speed, ...rest } = value as Record<string, unknown>
  const pet: Record<string, unknown> = { ...rest }
  if (
    pet.scale === undefined &&
    typeof size === 'string' &&
    size in petScalePresets
  )
    pet.scale = petScalePresets[size as keyof typeof petScalePresets]
  if (
    pet.rate === undefined &&
    typeof speed === 'string' &&
    speed in petRatePresets
  )
    pet.rate = petRatePresets[speed as keyof typeof petRatePresets]
  return pet
}
export const settingsSchema = z.object({
  model: z
    .object({
      protocol: z
        .enum(['openai-compatible', 'openai-responses', 'anthropic', 'chatgpt'])
        .default('openai-compatible'),
      baseURL: z.string().default(''),
      apiKey: z.string().default(''),
      model: z.string().default(''),
      /** Optional cheaper model on the same endpoint for background work (reflection); empty = model. */
      smallModel: z.string().default(''),
      // Relay (中转站) options. authStyle only applies to the Anthropic protocol.
      authStyle: z.enum(['x-api-key', 'bearer']).default('x-api-key'),
      headers: z
        .array(z.object({ name: z.string(), value: z.string() }))
        .default([]),
      /** Merged verbatim into every request body. */
      extraBody: z.record(z.string(), z.unknown()).default({}),
    })
    .prefault({}),
  pet: z.preprocess(
    legacyPet,
    z
      .object({
        id: z.string().default('xiaohei-q'),
        name: z.string().trim().min(1).max(40).default('小黑'),
        /** Size as a multiplier of the sprite; small / medium / large are 0.5 / 0.73 / 0.95. */
        scale: z
          .number()
          .min(petScaleRange.min)
          .max(petScaleRange.max)
          .default(0.73),
        /** Playback rate of the pet's own animations (drag running follows the hand instead). */
        rate: z.number().min(petRateRange.min).max(petRateRange.max).default(1),
      })
      .prefault({}),
  ),
  permissionMode: z.enum(['ask', 'auto', 'full']).default('auto'),
  dirRules: z
    .array(
      z.object({ path: z.string(), access: z.enum(['allow', 'ask', 'deny']) }),
    )
    .default([]),
  workspacePath: z.string().default('~/.familiar/workspace'),
  /** Commit the workspace to git after every change Familiar makes, so mistakes can be undone. */
  workspaceSnapshots: z.boolean().default(true),
  /** Close the chat panel and capsule when the user clicks another app. */
  chatAutoHide: z.boolean().default(true),
  /** Close the quick-ask bar when the user clicks another app. Off by default: files are dragged in from Finder. */
  quickAutoHide: z.boolean().default(false),
  /** Image generation, separate from the chat model (the ChatGPT plan route cannot make images). */
  imageModel: z
    .object({
      /** Off until a model is set. */
      model: z.string().default(''),
      baseURL: z.string().default('https://api.openai.com/v1'),
      apiKey: z.string().default(''),
    })
    .prefault({}),
  /** How opaque the floating panels (capsule, bubble, chat panel, menu bar panel) are, 0.5 to 1. */
  panelOpacity: z.number().min(0.5).max(1).default(1),
  /** How opaque the settings and big conversation windows are, 0.5 to 1. */
  windowOpacity: z.number().min(0.5).max(1).default(1),
  /** Off: Familiar starts with only the menu bar icon; the pet comes back with its shortcut or menu. */
  showPetOnLaunch: z.boolean().default(true),
  /** Global shortcuts as Tauri accelerators ("Alt+Space"); empty means none. */
  shortcuts: z
    .object({
      summon: z.string().default('Alt+Space'),
      main: z.string().default('Alt+Shift+Space'),
      togglePet: z.string().default('Alt+Shift+P'),
      newChat: z.string().default('Alt+Shift+N'),
      quick: z.string().default('Alt+Shift+A'),
    })
    .prefault({}),
  /** Skills by name that the model should not be offered. */
  disabledSkills: z.array(z.string()).default([]),
  /** Computer History (docs/design.md §7): off until the user turns it on. */
  perception: z
    .object({
      enabled: z.boolean().default(false),
      paused: z.boolean().default(false),
      /** Every app is read except these, which are not even named in the history. */
      excludedApps: z
        .array(z.object({ bundleId: z.string().min(1), name: z.string() }))
        .default([]),
      /** Read and kept on this Mac, but never sent to the model for summaries. */
      localApps: z
        .array(z.object({ bundleId: z.string().min(1), name: z.string() }))
        .default([]),
      /** Domains whose pages only count as "in the browser". */
      excludedSites: z.array(z.string()).default([]),
      /** Each period this long becomes one history entry. */
      summaryMinutes: z.number().int().min(5).max(60).default(30),
    })
    .prefault({}),
  /** Speaking up on its own (docs/design.md §8). Reminders the user asked for ignore the budget. */
  proactive: z
    .object({
      enabled: z.boolean().default(true),
      /**
       * How much it speaks up. auto: learned from how the user answers and how often they talk
       * to it; the others set a pace that feedback still moves a little.
       */
      level: z.enum(['auto', 'quiet', 'normal', 'chatty']).default('auto'),
      quiet: z
        .object({
          enabled: z.boolean().default(false),
          /** "HH:MM", local time; may wrap past midnight. */
          from: z
            .string()
            .regex(/^\d{2}:\d{2}$/)
            .default('23:00'),
          to: z
            .string()
            .regex(/^\d{2}:\d{2}$/)
            .default('08:00'),
        })
        .prefault({}),
      triggers: z
        .object({
          longWork: z.boolean().default(true),
          back: z.boolean().default(true),
          firstToday: z.boolean().default(true),
          /** Something in what the user is doing that memory or past talks can help with. */
          activity: z.boolean().default(true),
          followUp: z.boolean().default(true),
          lateNight: z.boolean().default(true),
        })
        .prefault({}),
    })
    .prefault({}),
})
export type Settings = z.infer<typeof settingsSchema>
export type PublicSettings = Omit<Settings, 'model' | 'imageModel'> & {
  model: Omit<Settings['model'], 'apiKey'> & { apiKeySet: boolean }
  imageModel: Omit<Settings['imageModel'], 'apiKey'> & { apiKeySet: boolean }
}
export type SettingsUpdate = Omit<Settings, 'model' | 'imageModel'> & {
  model: Omit<Settings['model'], 'apiKey'> & { apiKey?: string }
  imageModel: Omit<Settings['imageModel'], 'apiKey'> & { apiKey?: string }
}
/** Model settings as edited in the settings window; no apiKey means the saved one. */
export type ModelDraft = SettingsUpdate['model']
/** The ChatGPT account the app is signed in with (docs/design.md §4). */
export interface ChatGptStatus {
  signedIn: boolean
  email?: string
  /** Whether the user granted use of the ChatGPT plan, not just identity. */
  planUsage?: boolean
}
export interface ModelTestResult {
  ms: number
  reply: string
}
export type ApprovalDecision = 'approve' | 'deny'
/** What the approval card can send: "always" also saves an allow rule for the request's directory. */
export type ApprovalChoice = ApprovalDecision | 'always'
/** Long-lived activity, chosen by the main process; see docs/design.md §9. */
export type PetState =
  | 'idle'
  | 'listening'
  | 'thinking'
  | 'talking'
  | 'needs-you'
  | 'done'
  | 'failed'
  | 'sleeping'
/** One-shot animations that play once and fall back to the current PetState. */
export type PetGesture = 'wave' | 'jump' | 'petted' | 'poked'

/** One animation row inside a 192x208-cell, 8-column sprite sheet. */
export const spriteRowSchema = z.object({
  row: z.number().int().min(0),
  frames: z.number().int().min(1).max(8),
  loop: z.boolean(),
})
/**
 * familiar.json, stored next to a ChatGPT pet's pet.json. Adds animation rows that the
 * ChatGPT sheet lacks, in a separate sheet so the original stays untouched.
 */
export const skinExtensionSchema = z.object({
  version: z.literal(1),
  sheet: z.string(),
  rows: z.record(z.string(), spriteRowSchema),
})
export type SkinExtension = z.infer<typeof skinExtensionSchema>
export interface PetSkin {
  id: string
  displayName: string
  description: string
  /** URL the renderer can load (served by the main process). */
  spritesheetUrl: string
  /** ChatGPT sheet version: v1 = 1536x1872 (rows 0-8), v2 = 1536x2288 (adds look rows 9-10). */
  version: 1 | 2
  /** False for the pets that ship with the app; those cannot be deleted. */
  removable: boolean
  extension?: { sheetUrl: string; rows: SkinExtension['rows'] }
}
/** A file kept with the conversation (sent by the user or made by a tool), under conversations/files. */
export const attachmentSchema = z.object({
  /** Relative to conversations/files: "<conversation id>/<name>". */
  path: z.string().regex(/^[0-9A-Za-z-]{1,64}\/[^/\\]{1,200}$/),
  name: z.string().min(1).max(200),
  mediaType: z.string().min(1).max(100),
  /** On a reply's own file: how much of the reply text came before it, so it shows in place. */
  at: z.number().int().min(0).optional(),
})
export type Attachment = z.infer<typeof attachmentSchema>
export const messageSchema = z.object({
  role: z.enum(['user', 'assistant']),
  content: z.string().max(100000),
  attachments: z.array(attachmentSchema).max(10).optional(),
})
export type Message = z.infer<typeof messageSchema>
export interface Source {
  url: string
  title: string
  /** A picture from the page (og:image or first large image), when it was read. */
  image?: string
  /** How much of the reply text came before it; none means after the text (older transcripts). */
  at?: number
}
export type AgentEvent =
  | { type: 'text-delta'; text: string }
  /** A file the reply produced (a generated image). */
  | { type: 'attachment'; attachment: Attachment }
  | { type: 'tool-call'; id: string; toolName: string; input: unknown }
  | {
      type: 'tool-approval-request'
      id: string
      toolName: string
      input: unknown
      reason: string
      dir?: string
      /** For an MCP tool: the server an "always allow" would trust. */
      server?: string
    }
  | { type: 'tool-result'; id: string; output: unknown }
  /** Web pages the reply drew on (search results, pages read), for its source cards. */
  | { type: 'sources'; sources: Source[] }
  | { type: 'finish'; stopped?: boolean }
  | { type: 'error'; message: string }
export const IPC = {
  settingsGet: 'settings:get',
  settingsSave: 'settings:save',
  agentRun: 'agent:run',
  agentStop: 'agent:stop',
  /** Runs again from a user message (retry, regenerate, edit); later messages go. */
  agentResend: 'agent:resend',
  agentEvent: 'agent:event',
  approval: 'agent:approval',
  petState: 'pet:state',
  petSize: 'pet:size',
  petSpeed: 'pet:speed',
  petFinished: 'pet:finished',
  typing: 'pet:typing',
  petHit: 'pet:hit',
  drag: 'pet:drag',
  toggleChat: 'chat:toggle',
  view: 'chat:view',
  petGesture: 'pet:gesture',
  petSkin: 'pet:skin',
  petsList: 'pets:list',
  petsImport: 'pets:import',
  petsCreatePrompt: 'pets:create-prompt',
  petsDelete: 'pets:delete',
  ready: 'window:ready',
  session: 'session:changed',
  sessionGet: 'session:get',
  sessionNew: 'session:new',
  capsule: 'overlay:capsule',
  quickHide: 'quick:hide',
  settingsOpen: 'settings:open',
  appearance: 'appearance:changed',
  settingsPage: 'settings:page',
  // Tauri migration (see protocol.ts): Rust → pet webview cursor position for hit testing.
  petCursor: 'pet:cursor',
  // agent → pet webview: drag direction for the running-left/right rows.
  petDrag: 'pet:drag',
  // Tray menu → agent.
  petsSelect: 'pets:select',
  petSizeSet: 'pet:size-set',
  appQuit: 'app:quit',
  // Conversation history (Markdown files in ~/.familiar/conversations).
  conversationsList: 'conversations:list',
  conversationsOpen: 'conversations:open',
  /** A copy of the current conversation up to a message, opened in its place. */
  conversationsBranch: 'conversations:branch',
  conversationsDelete: 'conversations:delete',
  conversationsClear: 'conversations:clear',
  conversationsReveal: 'conversations:reveal',
  // Pet context menu / tray → agent.
  modelsList: 'models:list',
  dirRuleRemove: 'rules:remove',
  modelTest: 'model:test',
  chatgptStatus: 'chatgpt:status',
  chatgptSignIn: 'chatgpt:sign-in',
  chatgptCancel: 'chatgpt:cancel',
  chatgptSignOut: 'chatgpt:sign-out',
  chatOpen: 'chat:open',
  /** Chat panel → agent: close the panel and the capsule together (Esc). */
  chatDismiss: 'chat:dismiss',
  chatHistory: 'chat:history',
  mainOpen: 'main:open',
  shortcut: 'shortcut:fire',
  shortcutStatus: 'shortcut:status',
  extensionsGet: 'extensions:get',
  mcpAccess: 'mcp:access',
  mcpRemove: 'mcp:remove',
  mcpImport: 'mcp:import',
  mcpCandidates: 'mcp:candidates',
  mcpReconnect: 'mcp:reconnect',
  mcpReveal: 'mcp:reveal',
  skillCandidates: 'skills:candidates',
  skillImport: 'skills:import',
  skillRemove: 'skills:remove',
  memoryList: 'memory:list',
  memoryConfirm: 'memory:confirm',
  memoryCorrect: 'memory:correct',
  memoryDelete: 'memory:delete',
  memoryReflect: 'memory:reflect',
  memoryReveal: 'memory:reveal',
  dataInfo: 'data:info',
  dataReveal: 'data:reveal',
  attachmentOpen: 'attachment:open',
  memoryChanged: 'memory:changed',
  perceptionStatus: 'perception:status',
  usageToday: 'usage:today',
  perceptionRecent: 'perception:recent',
  perceptionClear: 'perception:clear',
  perceptionSummarize: 'perception:summarize',
  perceptionApps: 'perception:apps',
  perceptionGrant: 'perception:grant',
  perceptionPause: 'perception:pause',
  perceptionSave: 'perception:save',
  perceptionIcons: 'perception:icons',
  perceptionChanged: 'perception:changed',
  proactiveStatus: 'proactive:status',
  /** The user's answer to a proactive bubble. */
  proactiveRespond: 'proactive:respond',
  proactiveChanged: 'proactive:changed',
  /** Ends 别烦我 early. */
  proactiveResume: 'proactive:resume',
  /** Look for something to say now instead of at the next minute. */
  proactiveCheck: 'proactive:check',
  reminderCancel: 'reminder:cancel',
} as const
export type DragAction = 'start' | 'move' | 'end'
/** Settings pages other windows can open directly. */
export type SettingsPage = 'timeline' | 'pending' | 'proactive'
export interface FamiliarAPI {
  getSettings(): Promise<PublicSettings>
  saveSettings(settings: SettingsUpdate): Promise<PublicSettings>
  /** Sends a message; files are { name, data (base64) } and go with it. */
  run(text: string, files?: { name: string; data: string }[]): Promise<void>
  /** Runs again from user message `index`, with new text when given; what came after goes. */
  resend(index: number, text?: string): Promise<void>
  /** Continues in a new conversation copied up to message `index`. */
  branch(index: number): Promise<void>
  getSession(): Promise<Session>
  onSession(callback: (session: Session) => void): () => void
  newSession(): void
  /** Opens the settings window, on a page when one is named. */
  openSettings(page?: SettingsPage): void
  onSettingsPage(callback: (page: SettingsPage) => void): () => void
  chatgptStatus(): Promise<ChatGptStatus>
  /** Opens the browser for sign-in and resolves once the user has finished there. */
  chatgptSignIn(): Promise<ChatGptStatus>
  chatgptCancel(): void
  chatgptSignOut(): Promise<void>
  onAppearance(callback: (panelOpacity: number) => void): () => void
  capsule(open: boolean): void
  /** Closes the quick-ask bar. */
  hideQuick(): void
  onCapsule(callback: (open: boolean) => void): () => void
  stop(): void
  approve(id: string, decision: ApprovalChoice): void
  hit(inside: boolean): void
  drag(action: DragAction): void
  toggleChat(): void
  /** Close the chat panel and the capsule, leaving only the pet. */
  dismissChat(): void
  /** Move the conversation into the large, resizable window. */
  openMainWindow(): void
  ready(): void
  onEvent(callback: (event: AgentEvent) => void): () => void
  onState(callback: (state: PetState) => void): () => void
  onView(callback: (view: ChatView) => void): () => void
  listConversations(query?: string): Promise<ConversationSummary[]>
  /** Makes a saved conversation the current one. */
  openConversation(id: string): Promise<void>
  /** Moves the conversation's file to the Trash. */
  deleteConversation(id: string): Promise<void>
  clearConversations(): Promise<void>
  revealConversations(): void
  /** Deletes a directory rule right away; returns the remaining rules. */
  removeDirRule(path: string): Promise<Settings['dirRules']>
  /** Model ids the relay reports for these (unsaved) settings. */
  listModels(draft: ModelDraft): Promise<string[]>
  /** One tiny request with these (unsaved) settings. */
  testModel(draft: ModelDraft): Promise<ModelTestResult>
  /** Native pet context menu, opened at window-local CSS pixels clear of the pet. */
  petMenu(x: number, y: number): void
  typing(hasText: boolean): void
  animationFinished(): void
  onSize(callback: (scale: number) => void): () => void
  onSpeed(callback: (rate: number) => void): () => void
  getPetSkin(): Promise<PetSkin>
  listPets(): Promise<PetSkin[]>
  /** Copies pets from ~/.codex/pets into Familiar's own pet library. */
  importCodexPets(): Promise<PetSkin[]>
  /** A prompt for Codex or Claude Code that makes a new pet with the bundled skill. */
  petCreatePrompt(): Promise<string>
  /** Moves a pet the user added to the Trash; returns the pets that are left. */
  deletePet(id: string): Promise<PetSkin[]>
  onGesture(callback: (gesture: PetGesture) => void): () => void
  onSkin(callback: (skin: PetSkin) => void): () => void
  listMemory(): Promise<MemoryItem[]>
  /** Keeps a pending inference, optionally reworded. */
  confirmMemory(id: string, text?: string): Promise<void>
  /** Rewrites a kept memory; the old text stays in the file, struck through. */
  correctMemory(id: string, text: string): Promise<void>
  /** Returns timeline lines that still restate the deleted memory. */
  deleteMemory(id: string): Promise<MemoryItem[]>
  /** Starts reflecting on recent conversations now; the result arrives with onMemoryChanged. */
  reflectMemory(): void
  revealMemory(): void
  /** Where ~/.familiar is and how much space it takes. */
  dataInfo(): Promise<{ path: string; bytes: number }>
  revealData(): void
  /** Opens a conversation file in its default app (Preview for images and PDFs). */
  openAttachment(path: string): void
  onMemoryChanged(callback: (change: MemoryChange) => void): () => void
  /** MCP servers (connecting them first when asked) and skills. */
  getExtensions(connect?: boolean): Promise<Extensions>
  setMcpAccess(name: string, access: McpServerStatus['access']): Promise<void>
  removeMcp(name: string): Promise<void>
  mcpCandidates(): Promise<McpCandidate[]>
  importMcp(
    items: { name: string; entry: Record<string, unknown> }[],
  ): Promise<void>
  reconnectMcp(name: string): Promise<void>
  revealMcp(): void
  skillCandidates(): Promise<(SkillInfo & { from: string; exists: boolean })[]>
  importSkill(path: string): Promise<void>
  removeSkill(path: string): Promise<void>
  /** Which configured shortcuts the system refused (taken by another app). */
  shortcutStatus(): Promise<ShortcutFailure[]>
  perceptionStatus(): Promise<PerceptionStatus>
  usageToday(): Promise<UsageToday>
  /** The raw events of the last hour, decrypted, newest first. */
  perceptionRecent(): Promise<PerceptionEvent[]>
  /** App icons as data: URLs by bundle id; apps without one are left out. */
  perceptionIcons(bundleIds: string[]): Promise<Record<string, string>>
  /** Deletes raw events and history entries from the last `minutes`, or all of them. */
  perceptionClear(minutes: number | 'all'): Promise<void>
  /** Summarizes what is buffered now; the result arrives with onPerceptionChanged. */
  perceptionSummarize(): void
  /** Installed browsers, editors and terminals, plus apps seen recently. */
  perceptionApps(): Promise<PerceptionApp[]>
  /** Shows the macOS Accessibility prompt and opens its settings pane. */
  perceptionGrant(): void
  perceptionPause(paused: boolean): Promise<void>
  /** Perception settings are saved on their own, right away, apart from the settings form. */
  savePerception(
    perception: Settings['perception'],
  ): Promise<Settings['perception']>
  onPerceptionChanged(callback: (status: PerceptionStatus) => void): () => void
  proactiveStatus(): Promise<ProactiveStatus>
  respondProactive(
    id: string,
    response: 'ok' | 'later' | 'quiet',
  ): Promise<void>
  resumeProactive(): Promise<void>
  checkProactive(): Promise<void>
  cancelReminder(id: string): Promise<void>
  onProactiveChanged(callback: (status: ProactiveStatus) => void): () => void
}

/** One raw event from familiar-sensor, after the agent's filter. */
/** One line of ~/.familiar/reminders.md. */
export interface Reminder {
  id: string
  /** When it is due, epoch ms. */
  at: number
  text: string
  /** `reminder`: the user asked for it, always shown. `follow-up`: the pet's own idea, budgeted. */
  kind: 'reminder' | 'follow-up'
  /** Set once it was shown (or skipped); done reminders stay a day for the list, then go. */
  done?: number
}
export type ProactiveTrigger =
  | 'reminder'
  | 'follow-up'
  | 'longWork'
  | 'back'
  | 'firstToday'
  | 'activity'
  | 'lateNight'
/** A message the pet put in its bubble on its own. */
export interface ProactiveMessage {
  id: string
  at: number
  trigger: ProactiveTrigger
  text: string
  /** Why now, in one line, shown under the message. */
  reason: string
  /** What the user did with it; `ignored` when the bubble timed out. */
  response?: 'ok' | 'later' | 'quiet' | 'ignored'
}
/**
 * The buttons under a proactive bubble. A reminder the user set has nothing to tell the pet off
 * for, so no 别烦我, and its 知道了 only closes it; 好 on the pet's own line opens the chat with it.
 */
export function proactiveChoices(trigger: ProactiveTrigger) {
  return trigger === 'reminder'
    ? {
        opensChat: false,
        buttons: [
          ['ok', '知道了'],
          ['later', '10 分钟后'],
        ] as const,
      }
    : {
        opensChat: true,
        buttons: [
          ['ok', '好'],
          ['later', '稍后'],
          ['quiet', '别烦我'],
        ] as const,
      }
}
/** Minutes as 45m / 1h / 1h 24m: short and the same shape, so a right-aligned column lines up. */
export const shortDuration = (minutes: number) =>
  minutes < 60
    ? `${minutes}m`
    : `${Math.floor(minutes / 60)}h${minutes % 60 ? ` ${minutes % 60}m` : ''}`
export interface ProactiveStatus {
  /** Messages and reminders, newest first, from the last 7 days. */
  history: ProactiveMessage[]
  reminders: Reminder[]
  /** Proactive messages today against today's pace (reminders not counted). */
  usedToday: number
  limit: number
  /** Minutes the current pace keeps between two messages. */
  gapMinutes: number
  /** Set while 别烦我 holds; epoch ms when it ends. */
  quietUntil?: number
}
export interface PerceptionEvent {
  at: number
  kind: 'app' | 'window' | 'idle' | 'active'
  bundleId?: string
  app?: string
  title?: string
  url?: string
  role?: string
  text?: string
  /** A private browsing window: nothing but the app was kept. */
  private?: boolean
  /** The focus was in a password field: its text was never read. */
  secure?: boolean
  /** Fields dropped by the sensitive-information filter. */
  dropped?: string[]
}
export interface PerceptionStatus {
  enabled: boolean
  paused: boolean
  running: boolean
  /** null until the sensor has reported. */
  trusted: boolean | null
  error?: string
  lastEventAt?: number
  lastSummaryAt?: number
  summary?: { timeline: number; pending: number } | { error: string }
}
/** Today's active time and top apps, for the menu bar panel. */
export interface UsageToday {
  activeMinutes: number
  apps: { bundleId: string; name: string; minutes: number }[]
}
export interface PerceptionApp {
  bundleId: string
  name: string
  kind: 'browser' | 'editor' | 'terminal' | 'recent'
}

export interface McpServerStatus {
  name: string
  /** The command line or URL. */
  target: string
  access: 'allow' | 'ask' | 'off'
  state: 'connected' | 'error' | 'idle' | 'off'
  tools: string[]
  error?: string
}
export interface McpCandidate {
  source: string
  name: string
  target: string
  exists: boolean
  entry: Record<string, unknown>
}
export interface SkillInfo {
  name: string
  description: string
  /** imported: a copy under ~/.familiar/skills; shared: read in place from ~/.agents/skills. */
  source: 'imported' | 'shared'
  path: string
}
export interface Extensions {
  mcp: McpServerStatus[]
  skills: SkillInfo[]
  mcpFile: string
}
export type ShortcutAction =
  'summon' | 'main' | 'togglePet' | 'newChat' | 'quick'
export interface ShortcutFailure {
  action: ShortcutAction
  accelerator: string
  error: string
}

/** One line of ~/.familiar/memory as the memory page shows it; see agent/src/memory/store.ts. */
export interface MemoryItem {
  id: string
  category: 'profile' | 'habits' | 'topic' | 'pending' | 'timeline'
  /** Topic name, or timeline period (2026-10-27, 2026-W44, 2026-10). */
  key?: string
  text: string
  at: string
  source: 'user' | 'reflection'
  status: 'confirmed' | 'superseded' | 'pending'
  target?: 'profile' | 'habits' | 'topic'
  targetTopic?: string
  confidence?: number
  evidence?: string
  /** Pending: how many conversations showed it. */
  seen?: number
  /** A timeline entry written from a conversation: its id, so the entry can open it again. */
  conversation?: string
  /** A rolled-up (week or month) timeline line: every conversation it was merged from. */
  conversations?: string[]
  /** A Computer History entry: its title, period and the apps used. */
  activity?: {
    title: string
    start: number
    end: number
    apps: { bundleId: string; name: string }[]
  }
}
export interface ReflectResult {
  conversations: number
  pending: number
  promoted: number
  timeline: number
  failed: number
}
export interface MemoryChange {
  reflect?: ReflectResult | { error: string }
}

export type Approval = Extract<AgentEvent, { type: 'tool-approval-request' }>
export type ChatView = 'chat' | 'history'
export interface ConversationSummary {
  id: string
  title: string
  /** Last reply as one plain line. */
  preview: string
  updatedAt: number
  messages: number
}
export interface Session {
  /** Conversation file id; empty until the first message. */
  id: string
  updatedAt: number
  /** Set when the capsule started fresh after a long pause, so it can offer to go back. */
  previous?: { id: string; title: string }
  /** `error` marks a reply that failed, so the transcript keeps the failure where it happened. */
  messages: (Message & {
    createdAt: number
    error?: string
    sources?: Source[]
  })[]
  running: boolean
  approvals: Approval[]
  /**
   * `turn` is the index of the assistant message the call belongs to; `at` is how much of its
   * text came before the call (none: before all of it, as older transcripts show).
   */
  tools: {
    id: string
    name: string
    done: boolean
    turn: number
    at?: number
  }[]
  error: string
  origin: 'capsule' | 'chat'
  bubble: string
  /** A proactive message in the bubble, waiting for 好 / 稍后 / 别烦我. */
  proactive?: ProactiveMessage
}
