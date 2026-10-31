import { createRoot } from 'react-dom/client'
import { Chat } from './chat/Chat'
import { Overlay } from './overlay/Overlay'
import { SettingsView } from './settings/SettingsView'
import { TrayPanel } from './panel/TrayPanel'
import { api } from './api'
import './style.css'
const kind = new URLSearchParams(location.search).get('window')
document.body.className = `${kind}-window`
createRoot(document.getElementById('root')!).render(
  kind === 'pet' ? (
    <Overlay />
  ) : kind === 'panel' ? (
    <TrayPanel />
  ) : kind === 'settings' ? (
    <SettingsView />
  ) : kind === 'main' ? (
    <Chat variant="window" />
  ) : (
    <Chat />
  ),
)
api.ready()
