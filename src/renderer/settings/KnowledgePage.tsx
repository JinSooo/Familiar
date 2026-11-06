import { useEffect, useState } from 'react'
import type { KnowledgeFolder, KnowledgeStatus } from '../../shared'
import { api } from '../api'

const failure = (e: unknown) =>
  typeof e === 'string' ? e : e instanceof Error ? e.message : '操作失败'
const home = /^\/Users\/[^/]+/
const tilde = (path: string) => path.replace(home, '~')
const nameOf = (path: string) => path.split('/').filter(Boolean).at(-1) ?? path

function counts(folder: KnowledgeFolder, vectors: boolean): string {
  if (folder.missing) return '找不到这个文件夹'
  const parts = [`${folder.files} 个文件`]
  if (vectors && folder.chunks && folder.embedded < folder.chunks)
    parts.push(`按意思检索准备了 ${folder.embedded}/${folder.chunks} 段`)
  if (folder.truncated) parts.push('文件太多，只收录了一部分')
  return parts.join('，')
}

/** Settings › 知识库: the folders it reads, how far indexing got, and files it could not read. */
export function KnowledgePage() {
  const [status, setStatus] = useState<KnowledgeStatus>()
  const [notice, setNotice] = useState('')
  const [open, setOpen] = useState<string>()
  useEffect(() => {
    api
      .knowledgeStatus()
      .then(setStatus)
      .catch((e: unknown) => setNotice(failure(e)))
    return api.onKnowledgeChanged(setStatus)
  }, [])
  if (!status) return <p role="status">{notice || '正在读取…'}</p>
  const act = (work: Promise<KnowledgeStatus>) =>
    work
      .then((next) => {
        setStatus(next)
        setNotice('')
      })
      .catch((e: unknown) => setNotice(failure(e)))
  return (
    <div className="ext-page">
      <div className="page-actions">
        <button
          type="button"
          aria-disabled={status.busy}
          onClick={() => !status.busy && api.reindexKnowledge()}
        >
          重新索引
        </button>
        <button type="button" onClick={() => act(api.addKnowledgeFolder())}>
          添加文件夹…
        </button>
      </div>
      <ul className="group memory-list">
        {status.folders.map((folder) => (
          <li key={folder.path} className="knowledge-folder">
            <div className="ext-item">
              <span className="ext-main">
                <span className="ext-title">
                  {folder.builtIn ? 'Familiar 资料' : nameOf(folder.path)}
                </span>
                <span className="muted ext-sub" title={folder.path}>
                  {tilde(folder.path)}
                </span>
                <span
                  className={`ext-sub ${folder.missing ? 'warn' : 'muted'}`}
                >
                  {counts(folder, status.vectors)}
                  {folder.failed.length > 0 && (
                    <>
                      {'，'}
                      <button
                        type="button"
                        className="link"
                        aria-expanded={open === folder.path}
                        onClick={() =>
                          setOpen(
                            open === folder.path ? undefined : folder.path,
                          )
                        }
                      >
                        {folder.failed.length} 个读不了
                      </button>
                    </>
                  )}
                </span>
              </span>
              <span className="row-actions">
                <button
                  type="button"
                  disabled={folder.missing}
                  onClick={() => api.revealKnowledge(folder.path)}
                >
                  打开
                </button>
                {!folder.builtIn && (
                  <button
                    type="button"
                    className="danger-quiet"
                    onClick={() => act(api.removeKnowledgeFolder(folder.path))}
                  >
                    移除
                  </button>
                )}
              </span>
            </div>
            {open === folder.path && (
              <ul className="knowledge-failed">
                {folder.failed.map((f) => (
                  <li key={f.path}>
                    <code title={f.path}>
                      {f.path.slice(folder.path.length + 1)}
                    </code>
                    <span className="muted">{f.error}</span>
                  </li>
                ))}
              </ul>
            )}
          </li>
        ))}
      </ul>
      <p className="caption" role="status">
        {notice ||
          (status.busy
            ? '正在整理…'
            : status.error
              ? status.error
              : status.local
                ? '按意思检索用的是本机模型，文件内容不出这台 Mac。'
                : status.vectors
                  ? '文件内容会发给向量模型的服务商，用来按意思检索。'
                  : '现在只按关键词找；在「模型 › 按意思检索」设置后也能按意思找。')}
      </p>
    </div>
  )
}
