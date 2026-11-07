import { useEffect } from 'react'
import { createRoot } from 'react-dom/client'
import { Chat } from './chat/Chat'
import { Overlay } from './overlay/Overlay'
import { SettingsView } from './settings/SettingsView'
import { TrayPanel } from './panel/TrayPanel'
import { Quick } from './quick/Quick'
import { api } from './api'
import './style.css'
const kind = new URLSearchParams(location.search).get('window')
document.body.className = `${kind}-window`
function App() {
  useEffect(() => {
    const off = api.onAppearance((opacity) =>
      document.documentElement.style.setProperty(
        '--panel-opacity',
        String(opacity),
      ),
    )
    api.ready()
    return off
  }, [])
  return kind === 'pet' ? (
    <Overlay />
  ) : kind === 'quick' ? (
    <Quick />
  ) : kind === 'panel' ? (
    <TrayPanel />
  ) : kind === 'settings' ? (
    <SettingsView />
  ) : kind === 'main' ? (
    <Chat variant="window" />
  ) : (
    <Chat />
  )
}
createRoot(document.getElementById('root')!).render(<App />)
