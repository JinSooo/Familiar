import { invoke } from '@tauri-apps/api/core'
import { getCurrentWebviewWindow } from '@tauri-apps/api/webviewWindow'
import { IPC, type FamiliarAPI } from '../shared'

export function subscribe<T>(
  channel: string,
  callback: (value: T) => void,
): () => void {
  let cancelled = false
  let unlisten: (() => void) | undefined
  void getCurrentWebviewWindow()
    .listen<T>(channel, (event) => {
      if (!cancelled) callback(event.payload)
    })
    .then((off) => {
      if (cancelled) off()
      else unlisten = off
    })
    .catch(console.error)
  return () => {
    if (cancelled) return
    cancelled = true
    unlisten?.()
  }
}
function request<T>(channel: string, ...args: unknown[]): Promise<T> {
  return invoke<T>('familiar_invoke', { channel, args })
}
function send(channel: string, ...args: unknown[]): void {
  void request(channel, ...args).catch(console.error)
}
export const api: FamiliarAPI = {
  getSession: () => request(IPC.sessionGet),
  onSession: (cb) => subscribe(IPC.session, cb),
  newSession: () => send(IPC.sessionNew),
  openSettings: (page) => send(IPC.settingsOpen, page),
  onSettingsPage: (cb) => subscribe(IPC.settingsPage, cb),
  chatgptStatus: () => request(IPC.chatgptStatus),
  chatgptSignIn: () => request(IPC.chatgptSignIn),
  chatgptCancel: () => send(IPC.chatgptCancel),
  chatgptSignOut: () => request(IPC.chatgptSignOut),
  onAppearance: (cb) => subscribe(IPC.appearance, cb),
  capsule: (open) => send(IPC.capsule, open),
  onCapsule: (cb) => subscribe(IPC.capsule, cb),
  typing: (hasText) => send(IPC.typing, hasText),
  animationFinished: () => send(IPC.petFinished),
  onSize: (cb) => subscribe(IPC.petSize, cb),
  onSpeed: (cb) => subscribe(IPC.petSpeed, cb),
  getPetSkin: () => request(IPC.petSkin),
  listPets: () => request(IPC.petsList),
  importCodexPets: () => request(IPC.petsImport),
  onGesture: (cb) => subscribe(IPC.petGesture, cb),
  onSkin: (cb) => subscribe(IPC.petSkin, cb),
  getSettings: () => request(IPC.settingsGet),
  saveSettings: (settings) => request(IPC.settingsSave, settings),
  run: (text, files) => request(IPC.agentRun, text, files ?? []),
  resend: (index, text) => request(IPC.agentResend, index, text),
  branch: (index) => request(IPC.conversationsBranch, index),
  stop: () => send(IPC.agentStop),
  approve: (id, decision) => send(IPC.approval, id, decision),
  hit: (inside) => {
    void invoke('pet_hit', { inside }).catch(console.error)
  },
  drag: (action) => {
    if (action === 'start') void invoke('pet_drag_start').catch(console.error)
  },
  toggleChat: () => send(IPC.toggleChat),
  dismissChat: () => send(IPC.chatDismiss),
  openMainWindow: () => send(IPC.mainOpen),
  ready: () => send(IPC.ready),
  onEvent: (cb) => subscribe(IPC.agentEvent, cb),
  onState: (cb) => subscribe(IPC.petState, cb),
  onView: (cb) => subscribe(IPC.view, cb),
  listConversations: (query) => request(IPC.conversationsList, query),
  openConversation: (id) => request(IPC.conversationsOpen, id),
  deleteConversation: (id) => request(IPC.conversationsDelete, id),
  clearConversations: () => request(IPC.conversationsClear),
  revealConversations: () => send(IPC.conversationsReveal),
  listModels: (draft) => request(IPC.modelsList, draft),
  removeDirRule: (path) => request(IPC.dirRuleRemove, path),
  testModel: (draft) => request(IPC.modelTest, draft),
  listMemory: () => request(IPC.memoryList),
  confirmMemory: (id, text) => request(IPC.memoryConfirm, id, text),
  correctMemory: (id, text) => request(IPC.memoryCorrect, id, text),
  deleteMemory: (id) => request(IPC.memoryDelete, id),
  reflectMemory: () => send(IPC.memoryReflect),
  revealMemory: () => send(IPC.memoryReveal),
  dataInfo: () => request(IPC.dataInfo),
  revealData: () => send(IPC.dataReveal),
  openAttachment: (path) => send(IPC.attachmentOpen, path),
  onMemoryChanged: (cb) => subscribe(IPC.memoryChanged, cb),
  getExtensions: (connect) => request(IPC.extensionsGet, connect),
  setMcpAccess: (name, access) => request(IPC.mcpAccess, name, access),
  removeMcp: (name) => request(IPC.mcpRemove, name),
  mcpCandidates: () => request(IPC.mcpCandidates),
  importMcp: (items) => request(IPC.mcpImport, items),
  reconnectMcp: (name) => request(IPC.mcpReconnect, name),
  revealMcp: () => send(IPC.mcpReveal),
  skillCandidates: () => request(IPC.skillCandidates),
  importSkill: (path) => request(IPC.skillImport, path),
  removeSkill: (path) => request(IPC.skillRemove, path),
  shortcutStatus: () => request(IPC.shortcutStatus),
  perceptionStatus: () => request(IPC.perceptionStatus),
  usageToday: () => request(IPC.usageToday),
  perceptionRecent: () => request(IPC.perceptionRecent),
  perceptionClear: (minutes) => request(IPC.perceptionClear, minutes),
  perceptionSummarize: () => send(IPC.perceptionSummarize),
  perceptionApps: () => request(IPC.perceptionApps),
  perceptionIcons: (ids) => request(IPC.perceptionIcons, ids),
  perceptionGrant: () => send(IPC.perceptionGrant),
  perceptionPause: (paused) => request(IPC.perceptionPause, paused),
  savePerception: (perception) => request(IPC.perceptionSave, perception),
  onPerceptionChanged: (cb) => subscribe(IPC.perceptionChanged, cb),
  proactiveStatus: () => request(IPC.proactiveStatus),
  respondProactive: (id, response) =>
    request(IPC.proactiveRespond, id, response),
  resumeProactive: () => request(IPC.proactiveResume),
  checkProactive: () => request(IPC.proactiveCheck),
  cancelReminder: (id) => request(IPC.reminderCancel, id),
  onProactiveChanged: (cb) => subscribe(IPC.proactiveChanged, cb),
  petMenu: (x, y) => {
    void invoke('pet_menu', { x, y }).catch(console.error)
  },
}
