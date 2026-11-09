import { useEffect, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { subscribe } from '../api'

/** What the shell knows about updates (src-tauri/src/update.rs). */
export interface UpdateState {
  current: string
  available: string | null
  installing: boolean
}

export const checkUpdate = () => invoke<UpdateState>('update_check')
/** Downloads, verifies and replaces the app, then restarts; resolves only if that failed to restart. */
export const installUpdate = () => invoke<void>('update_install')

/** The update state, kept current while the window is open. */
export function useUpdate(): [
  UpdateState | undefined,
  (state: UpdateState) => void,
] {
  const [state, setState] = useState<UpdateState>()
  useEffect(() => {
    void invoke<UpdateState>('update_state').then(setState).catch(console.error)
    return subscribe<UpdateState>('update:state', setState)
  }, [])
  return [state, setState]
}
