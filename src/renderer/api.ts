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
  openSettings: () => send(IPC.settingsOpen),
  capsule: (open) => send(IPC.capsule, open),
  onCapsule: (cb) => subscribe(IPC.capsule, cb),
  onAppearance: (cb) => subscribe(IPC.appearance, cb),
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
  run: (text) => request(IPC.agentRun, text),
  stop: () => send(IPC.agentStop),
  approve: (id, decision) => send(IPC.approval, id, decision),
  hit: (inside) => {
    void invoke('pet_hit', { inside }).catch(console.error)
  },
  drag: (action) => {
    if (action === 'start') void invoke('pet_drag_start').catch(console.error)
  },
  toggleChat: () => send(IPC.toggleChat),
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
  testModel: (draft) => request(IPC.modelTest, draft),
  petMenu: (x, y) => {
    void invoke('pet_menu', { x, y }).catch(console.error)
  },
}
