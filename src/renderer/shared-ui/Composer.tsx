import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { Icon } from './Icon'
import { api } from '../api'
import { fileKind } from '../chat/Attachments'

import {
  maxFiles,
  maxBytes,
  limitFiles,
  sendError,
  inputKey,
  createDraftStore,
  sendDraft,
  type Pending,
} from './input'
const draft = createDraftStore()

export function Composer({
  running,
  mini = false,
  name = '小黑',
  status = '',
  failed = '',
  continuing = false,
  quick = false,
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
  /** The quick-ask bar: several lines, files, and Esc closes it. */
  quick?: boolean
}) {
  const {
    input,
    files,
    error = '',
  } = useSyncExternalStore(draft.subscribe, draft.get)
  const setInput = (next: string | ((current: string) => string)) =>
    draft.set({
      ...draft.get(),
      input: typeof next === 'function' ? next(draft.get().input) : next,
    })
  const setFiles = (next: Pending[] | ((current: Pending[]) => Pending[])) => {
    const files = typeof next === 'function' ? next(draft.get().files) : next
    draft.set({ ...draft.get(), files })
  }
  const setError = (error: string) => draft.set({ ...draft.get(), error })
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
      return [
        ...old,
        ...limitFiles(
          next,
          URL.revokeObjectURL,
          Math.max(0, maxFiles - old.length),
        ),
      ]
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
  const area = useRef<HTMLTextAreaElement>(null)
  // The bar stays mounted while hidden, so focus comes back with the window.
  useEffect(() => {
    if (!quick) return
    const focus = () => area.current?.focus()
    window.addEventListener('focus', focus)
    return () => window.removeEventListener('focus', focus)
  }, [quick])
  useEffect(() => {
    if (!input && area.current) area.current.style.height = ''
  }, [input])
  // The capsule cannot take a second message mid-turn, so it shows progress instead of an idle field.
  const working = mini && running
  useEffect(() => {
    api.typing(Boolean(input || files.length))
  }, [input, files.length])
  useEffect(() => () => api.typing(false), [])
  useEffect(() => {
    if (!working) (quick ? area.current : field.current)?.focus()
  }, [working, quick])
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
                <Icon name="close" size={12} />
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
        className={`composer ${mini ? 'mini' : ''} ${quick ? 'quick' : ''} ${working ? 'working' : ''}`}
        // The quick bar has no title bar: its empty edges are where it is dragged.
        data-tauri-drag-region={quick ? '' : undefined}
        onKeyDown={(e) => {
          if (inputKey(e.nativeEvent) === 'close' && mini) api.capsule(false)
        }}
        onSubmit={async (e) => {
          e.preventDefault()
          if (
            (!input.trim() && !files.length) ||
            running ||
            busy.current ||
            draft.sending
          )
            return
          const text = input.trim()
          setError('')
          busy.current = true
          lastSent.current = text
          api.typing(false)
          try {
            await sendDraft(draft, api.run)
          } catch (err) {
            lastSent.current = ''
            setError(sendError(err))
          } finally {
            busy.current = false
          }
        }}
      >
        {(mini || quick) && (
          <button
            type="button"
            className="icon"
            aria-label={quick ? '在大窗口打开' : '打开对话'}
            title={quick ? '在大窗口打开' : '打开对话'}
            // The quick bar is already wide: expanding it means the big window, not the side panel.
            onClick={() => (quick ? api.openMainWindow() : api.toggleChat())}
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
            title="打开对话看看它在做什么"
            onClick={() => (quick ? api.openMainWindow() : api.toggleChat())}
          >
            <span className="dots" aria-hidden="true">
              <i />
              <i />
              <i />
            </span>
            <span>{status || `${name}在想…`}</span>
          </button>
        ) : quick ? (
          <textarea
            ref={area}
            rows={1}
            aria-label="消息"
            placeholder={continuing ? '接着聊…' : `和${name}说点什么…`}
            value={input}
            onChange={(e) => {
              setInput(e.target.value)
              e.target.style.height = 'auto'
              e.target.style.height = `${Math.min(e.target.scrollHeight, 132)}px`
            }}
            onKeyDown={(e) => {
              // Enter sends, Shift+Enter breaks the line; Enter that confirms an IME choice does neither.
              if (inputKey(e.nativeEvent) !== 'send') return
              e.preventDefault()
              e.currentTarget.form?.requestSubmit()
            }}
            onPaste={(e) => {
              const pasted = [...e.clipboardData.files]
              if (!pasted.length) return
              e.preventDefault()
              addFiles(pasted)
            }}
          />
        ) : (
          <input
            ref={field}
            aria-label="消息"
            placeholder={continuing ? '接着聊…' : `和${name}说点什么…`}
            value={input}
            onChange={(e) => {
              setInput(e.target.value)
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && inputKey(e.nativeEvent) !== 'send')
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
            <Icon name="stop" size={14} />
          </button>
        ) : (
          <button
            className="send primary"
            aria-label="发送"
            disabled={!input.trim() && !files.length}
          >
            <Icon name="send" />
          </button>
        )}
      </form>
    </div>
  )
}
