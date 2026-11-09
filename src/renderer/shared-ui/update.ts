import { useEffect, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { subscribe } from '../api'

/** What the shell knows about updates (src-tauri/src/update.rs). */
export interface UpdateState {
  current: string
  available: string | null
  installing: boolean
  /** Bytes downloaded so far, and the archive size when the server sent it. */
  received: number
  total: number | null
  /** Download done; verifying and replacing the app. */
  unpacking: boolean
}

const mb = (bytes: number) => `${Math.round(bytes / 1024 / 1024)} MB`

/** While installing: the line under the version, and the bar's value (undefined: no known end). */
export function updateProgress(state: UpdateState): {
  text: string
  percent?: number
} {
  if (state.unpacking) return { text: '正在安装，完成后自动重启' }
  if (!state.received) return { text: '正在连接…' }
  if (!state.total) return { text: `已下载 ${mb(state.received)}` }
  const percent = Math.min(
    100,
    Math.floor((state.received / state.total) * 100),
  )
  return {
    text: `下载中 ${percent}%（${mb(state.received)} / ${mb(state.total)}）`,
    percent,
  }
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
