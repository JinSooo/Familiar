import { useState } from 'react'
import { checkUpdate, installUpdate, useUpdate } from '../shared-ui/update'

const failure = (e: unknown) => (e instanceof Error ? e.message : String(e))

/** 设置 › 通用 › 版本: the running version, a manual check, and the update when there is one. */
export function UpdateRow() {
  const [update, setUpdate] = useUpdate()
  const [checking, setChecking] = useState(false)
  const [note, setNote] = useState<{ text: string; error?: boolean }>()
  const check = () => {
    setChecking(true)
    setNote(undefined)
    checkUpdate()
      .then((state) => {
        setUpdate(state)
        if (!state.available) setNote({ text: '已是最新版本' })
      })
      .catch((e: unknown) => setNote({ text: failure(e), error: true }))
      .finally(() => setChecking(false))
  }
  const install = () => {
    setNote(undefined)
    installUpdate().catch((e: unknown) =>
      setNote({ text: failure(e), error: true }),
    )
  }
  const hint = update?.available
    ? update.installing
      ? '下载完会自动重启'
      : '更新后会自动重启'
    : undefined
  return (
    <div className="setting-row">
      <div className="ch-label">
        <span>Familiar {update?.current}</span>
        {(note ?? hint) && (
          <span className={note?.error ? 'error' : 'muted'}>
            {note?.text ?? hint}
          </span>
        )}
      </div>
      {update?.available ? (
        <button type="button" disabled={update.installing} onClick={install}>
          {update.installing ? '正在更新…' : `更新到 ${update.available}`}
        </button>
      ) : (
        <button type="button" disabled={checking} onClick={check}>
          {checking ? '正在检查…' : '检查更新'}
        </button>
      )}
    </div>
  )
}
