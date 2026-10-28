import { z } from 'zod'
export const settingsSchema = z.object({
  model: z
    .object({
      protocol: z
        .enum(['openai-compatible', 'openai-responses', 'anthropic'])
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
  pet: z
    .object({
      id: z.string().default('xiaohei-q'),
      name: z.string().trim().min(1).max(40).default('小黑'),
      size: z.enum(['small', 'medium', 'large']).default('medium'),
      /** Playback rate of the pet's own animations (drag running follows the hand instead). */
      speed: z.enum(['slow', 'normal', 'fast']).default('normal'),
    })
    .prefault({}),
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
  /** Global shortcuts as Tauri accelerators ("Alt+Space"); empty means none. */
  shortcuts: z
    .object({
      summon: z.string().default('Alt+Space'),
      main: z.string().default('Alt+Shift+Space'),
      togglePet: z.string().default('Alt+Shift+P'),
      newChat: z.string().default('Alt+Shift+N'),
    })
    .prefault({}),
  /** Skills by name that the model should not be offered. */
  disabledSkills: z.array(z.string()).default([]),
})
export type Settings = z.infer<typeof settingsSchema>
export type PublicSettings = Omit<Settings, 'model'> & {
  model: Omit<Settings['model'], 'apiKey'> & { apiKeySet: boolean }
}
export type SettingsUpdate = Omit<Settings, 'model'> & {
  model: Omit<Settings['model'], 'apiKey'> & { apiKey?: string }
}
/** Model settings as edited in the settings window; no apiKey means the saved one. */
export type ModelDraft = SettingsUpdate['model']
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
  extension?: { sheetUrl: string; rows: SkinExtension['rows'] }
}
export const messageSchema = z.object({
  role: z.enum(['user', 'assistant']),
  content: z.string().max(100000),
})
export type Message = z.infer<typeof messageSchema>
export interface Source {
  url: string
  title: string
  /** A picture from the page (og:image or first large image), when it was read. */
  image?: string
}
export type AgentEvent =
  | { type: 'text-delta'; text: string }
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
  ready: 'window:ready',
  session: 'session:changed',
  sessionGet: 'session:get',
  sessionNew: 'session:new',
  capsule: 'overlay:capsule',
  appearance: 'appearance:changed',
  settingsOpen: 'settings:open',
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
  conversationsDelete: 'conversations:delete',
  conversationsClear: 'conversations:clear',
  conversationsReveal: 'conversations:reveal',
  // Pet context menu / tray → agent.
  modelsList: 'models:list',
  dirRuleRemove: 'rules:remove',
  modelTest: 'model:test',
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
  memoryChanged: 'memory:changed',
} as const
export type DragAction = 'start' | 'move' | 'end'
export interface FamiliarAPI {
  getSettings(): Promise<PublicSettings>
  saveSettings(settings: SettingsUpdate): Promise<PublicSettings>
  run(text: string): Promise<void>
  getSession(): Promise<Session>
  onSession(callback: (session: Session) => void): () => void
  newSession(): void
  openSettings(): void
  capsule(open: boolean): void
  onCapsule(callback: (open: boolean) => void): () => void
  onAppearance(callback: (accent: string) => void): () => void
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
  onSize(callback: (size: Settings['pet']['size']) => void): () => void
  onSpeed(callback: (speed: Settings['pet']['speed']) => void): () => void
  getPetSkin(): Promise<PetSkin>
  listPets(): Promise<PetSkin[]>
  /** Copies pets from ~/.codex/pets into Familiar's own pet library. */
  importCodexPets(): Promise<PetSkin[]>
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
export type ShortcutAction = 'summon' | 'main' | 'togglePet' | 'newChat'
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
  /** `turn` is the index of the assistant message the call belongs to. */
  tools: { id: string; name: string; done: boolean; turn: number }[]
  error: string
  origin: 'capsule' | 'chat'
  bubble: string
}
