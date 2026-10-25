import { contextBridge, ipcRenderer } from 'electron'
import { IPC, type FamiliarAPI } from '../shared'
function subscribe<T>(
  channel: string,
  callback: (value: T) => void,
): () => void {
  const listener = (_event: Electron.IpcRendererEvent, value: T): void =>
    callback(value)
  ipcRenderer.on(channel, listener)
  return () => {
    ipcRenderer.removeListener(channel, listener)
  }
}
const api: FamiliarAPI = {
  getSession: () => ipcRenderer.invoke(IPC.sessionGet),
  onSession: (callback) => subscribe(IPC.session, callback),
  newSession: () => ipcRenderer.send(IPC.sessionNew),
  openSettings: () => ipcRenderer.send(IPC.settingsOpen),
  capsule: (open) => ipcRenderer.send(IPC.capsule, open),
  onCapsule: (callback) => subscribe(IPC.capsule, callback),
  onAppearance: (callback) => subscribe(IPC.appearance, callback),
  typing: (hasText) => ipcRenderer.send(IPC.typing, hasText),
  animationFinished: () => ipcRenderer.send(IPC.petFinished),
  onSize: (callback) => subscribe(IPC.petSize, callback),
  getPetSkin: () => ipcRenderer.invoke(IPC.petSkin),
  listPets: () => ipcRenderer.invoke(IPC.petsList),
  importCodexPets: () => ipcRenderer.invoke(IPC.petsImport),
  onGesture: (callback) => subscribe(IPC.petGesture, callback),
  onSkin: (callback) => subscribe(IPC.petSkin, callback),
  getSettings: () => ipcRenderer.invoke(IPC.settingsGet),
  saveSettings: (settings) => ipcRenderer.invoke(IPC.settingsSave, settings),
  run: (messages) => ipcRenderer.invoke(IPC.agentRun, messages),
  stop: () => ipcRenderer.send(IPC.agentStop),
  approve: (id, decision) => ipcRenderer.send(IPC.approval, id, decision),
  hit: (inside) => ipcRenderer.send(IPC.petHit, inside),
  drag: (action) => ipcRenderer.send(IPC.drag, action),
  toggleChat: () => ipcRenderer.send(IPC.toggleChat),
  ready: () => ipcRenderer.send(IPC.ready),
  onEvent: (callback) => subscribe(IPC.agentEvent, callback),
  onState: (callback) => subscribe(IPC.petState, callback),
  onView: (callback) => subscribe(IPC.view, callback),
}
contextBridge.exposeInMainWorld('familiar', api)
