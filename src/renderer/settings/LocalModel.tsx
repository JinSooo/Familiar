import { useEffect, useState } from 'react'
import type { LocalModelStatus } from '../../shared'
import { api } from '../api'

const mb = (bytes: number) => `${Math.round(bytes / 1024 / 1024)} MB`

/** Settings › 模型 › 向量 › 本机: the downloadable model, its download and removal. */
export function LocalModel() {
  const [status, setStatus] = useState<LocalModelStatus>()
  const [notice, setNotice] = useState('')
  useEffect(() => {
    api
      .localModelStatus()
      .then(setStatus)
      .catch((e: unknown) => setNotice(String(e)))
    return api.onLocalModelChanged(setStatus)
  }, [])
  if (!status) return <div className="setting-row muted">{notice || '…'}</div>
  const total = status.total || status.size
  const percent =
    total && status.received
      ? Math.min(100, Math.floor((status.received / total) * 100))
      : 0
  const detail =
    status.state === 'ready'
      ? '已下载，内容不出这台 Mac'
      : status.state === 'downloading'
        ? `下载中 ${percent}%（${mb(status.received ?? 0)} / ${mb(total)}）`
        : status.received
          ? `已下载 ${percent}%，可以接着下`
          : `约 ${mb(status.size || 640 * 1024 * 1024)}，中英文都适用`
  return (
    <>
      <div className="setting-row">
        <span className="ext-main">
          <span>{status.name}</span>
          <span className="muted ext-sub">{detail}</span>
        </span>
        <span className="row-actions">
          {status.state === 'downloading' ? (
            <button
              type="button"
              onClick={() => api.cancelLocalModelDownload()}
            >
              暂停
            </button>
          ) : status.state === 'ready' ? (
            <button
              type="button"
              className="danger-quiet"
              onClick={() =>
                api
                  .deleteLocalModel()
                  .catch((e: unknown) => setNotice(String(e)))
              }
            >
              删除
            </button>
          ) : (
            <button
              type="button"
              disabled={!status.server}
              onClick={() => api.downloadLocalModel()}
            >
              {status.received ? '继续下载' : '下载'}
            </button>
          )}
        </span>
      </div>
      {status.state === 'downloading' && (
        <progress className="local-progress" max={100} value={percent} />
      )}
      {(status.error || !status.server || notice) && (
        <p className="caption probe failed">
          {notice ||
            status.error ||
            '这个版本缺少本机向量程序 llama-server，需要重新打包。'}
        </p>
      )}
    </>
  )
}
