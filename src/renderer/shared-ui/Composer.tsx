import { useEffect, useRef, useState } from 'react'
import { Icon } from './Icon'
import { api } from '../api'
import { fileKind } from '../chat/Attachments'

/** Same limits as the agent: ten files, 20 MB each. */
const maxFiles = 10
const maxBytes = 20 * 1024 * 1024
interface Pending {
  file: File
  /** Object URL for image thumbnails. */
  preview?: string
}
const toBase64 = async (file: File) => {
  const bytes = new Uint8Array(await file.arrayBuffer())
  let binary = ''
  for (let i = 0; i < bytes.length; i += 0x8000)
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return btoa(binary)
}
export function Composer({
  running,
  mini = false,
  name = '小黑',
  status = '',
  failed = '',
  continuing = false,
}: {
  running: boolean
  mini?: boolean
  name?: string
  /** Mini only: what the pet is doing, shown in place of the field while running. */
  status?: string
  /** Mini only: the last turn's error; the failed message comes back for a resend. */
  failed?: string
  /** The current conversation already has messages. */
  continuing?: boolean
}) {
  const [input, setInput] = useState('')
  const [error, setError] = useState('')
  const [files, setFiles] = useState<Pending[]>([])
  const [dragging, setDragging] = useState(false)
  const picker = useRef<HTMLInputElement>(null)
  const addFiles = (list: Iterable<File>) => {
    const next: Pending[] = []
    for (const file of list) {
      if (file.size > maxBytes) {
        setError(`「${file.name}」超过 20 MB，发不了`)
        continue
      }
      next.push({
        file,
        ...(file.type.startsWith('image/')
          ? { preview: URL.createObjectURL(file) }
          : {}),
      })
    }
    setFiles((old) => {
      const all = [...old, ...next]
      if (all.length > maxFiles) setError(`一次最多 ${maxFiles} 个文件`)
      return all.slice(0, maxFiles)
    })
  }
  const removeFile = (i: number) =>
    setFiles((old) => {
      const gone = old[i]
      if (gone?.preview) URL.revokeObjectURL(gone.preview)
      return old.filter((_, k) => k !== i)
    })
  const field = useRef<HTMLInputElement>(null)
  const busy = useRef(false)
  const lastSent = useRef('')
  // The capsule cannot take a second message mid-turn, so it shows progress instead of an idle field.
  const working = mini && running
  useEffect(() => {
    return () => api.typing(false)
  }, [])
  useEffect(() => {
    if (!working) field.current?.focus()
  }, [working])
  useEffect(() => {
    if (mini && failed && lastSent.current) {
      setInput((current) => current || lastSent.current)
      lastSent.current = ''
    }
  }, [mini, failed])
  return (
    <div
      className={`composer-wrap ${dragging ? 'dragging' : ''}`}
      data-hit
      onDragOver={(e) => {
        if (mini || !e.dataTransfer.types.includes('Files')) return
        e.preventDefault()
        setDragging(true)
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={(e) => {
        if (mini) return
        e.preventDefault()
        setDragging(false)
        addFiles(e.dataTransfer.files)
      }}
    >
      {files.length > 0 && (
        <div className="composer-files">
          {files.map((f, i) => (
            <span key={`${f.file.name}-${i}`} className="composer-file">
              {f.preview ? (
                <img src={f.preview} alt="" />
              ) : (
                <span className="attachment-kind">{fileKind(f.file.name)}</span>
              )}
              <span className="composer-file-name">{f.file.name}</span>
              <button
                type="button"
                aria-label={`移除 ${f.file.name}`}
                onClick={() => removeFile(i)}
              >
                ×
              </button>
            </span>
          ))}
        </div>
      )}
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      <form
        className={`composer ${mini ? 'mini' : ''} ${working ? 'working' : ''}`}
        onKeyDown={(e) => {
          if (e.key === 'Escape' && mini) api.capsule(false)
        }}
        onSubmit={async (e) => {
          e.preventDefault()
          if ((!input.trim() && !files.length) || running || busy.current)
            return
          const text = input.trim()
          const sending = files
          setError('')
          busy.current = true
          lastSent.current = text
          api.typing(false)
          try {
            const uploads = await Promise.all(
              sending.map(async (f) => ({
                name: f.file.name,
                data: await toBase64(f.file),
              })),
            )
            setInput('')
            setFiles([])
            await api.run(text, uploads)
            for (const f of sending)
              if (f.preview) URL.revokeObjectURL(f.preview)
          } catch (err) {
            setInput(text)
            setFiles(sending)
            lastSent.current = ''
            setError(err instanceof Error ? err.message : '对话启动失败')
          } finally {
            busy.current = false
          }
        }}
      >
        {mini && (
          <button
            type="button"
            className="icon"
            aria-label="展开聊天"
            onClick={() => api.toggleChat()}
          >
            <Icon name="expand" />
          </button>
        )}
        {!mini && !working && (
          <>
            <button
              type="button"
              className="icon attach"
              aria-label="添加图片或文件"
              title="添加图片或文件（也可以粘贴或拖进来）"
              onClick={() => picker.current?.click()}
            >
              <Icon name="attach" />
            </button>
            <input
              ref={picker}
              type="file"
              multiple
              hidden
              onChange={(e) => {
                if (e.target.files) addFiles(e.target.files)
                e.target.value = ''
              }}
            />
          </>
        )}
        {working ? (
          <button
            type="button"
            className="capsule-status"
            role="status"
            title="展开聊天查看过程"
            onClick={() => api.toggleChat()}
          >
            <span className="dots" aria-hidden="true">
              <i />
              <i />
              <i />
            </span>
            <span>{status || `${name}在想…`}</span>
          </button>
        ) : (
          <input
            ref={field}
            aria-label="消息"
            placeholder={continuing ? `继续问${name}…` : `问${name}…`}
            value={input}
            onChange={(e) => {
              setInput(e.target.value)
              api.typing(Boolean(e.target.value))
            }}
            onKeyDown={(e) => {
              if (e.nativeEvent.isComposing && e.key === 'Enter')
                e.preventDefault()
            }}
            onPaste={(e) => {
              if (mini) return
              const pasted = [...e.clipboardData.files]
              if (!pasted.length) return
              e.preventDefault()
              addFiles(pasted)
            }}
          />
        )}
        {running ? (
          <button
            type="button"
            className="send stop"
            aria-label="停止"
            onClick={() => api.stop()}
          >
            ■
          </button>
        ) : (
          <button
            className="send primary"
            aria-label="发送"
            disabled={!input.trim() && !files.length}
          >
            ↑
          </button>
        )}
      </form>
    </div>
  )
}
