import { useCallback, useEffect, useRef, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { api } from '../api'
import { Attachments } from '../chat/Attachments'
import { MessageActions, Reply, type ToolView } from '../chat/Chat'
import { errorText } from '../chat/History'
import { PlainText } from '../chat/Markdown'
import { Composer } from '../shared-ui/Composer'
import { useSession } from '../shared-ui/session'
import { useTurnStatus } from '../shared-ui/status'

/** The last few messages: enough to follow a quick back-and-forth; the rest lives in the big window. */
const recent = 6

/**
 * The quick-ask bar. Just the field until there is a conversation; then it opens, with the
 * system's window animation, into a box of a set height: the conversation above, the field at
 * the bottom. The top edge stays put. The user can drag it by its edges and resize it; the shell
 * remembers where (src-tauri/src/windows.rs).
 */
export function Quick() {
  const session = useSession()
  const [name, setName] = useState('小黑')
  const [toolView, setToolView] = useState<ToolView>('brief')
  const [actionError, setActionError] = useState('')
  const act = (work: Promise<unknown>, fallback: string) => {
    setActionError('')
    work.catch((e) => setActionError(errorText(e, fallback)))
  }
  const bar = useRef<HTMLDivElement>(null)
  const reply = useRef<HTMLElement>(null)
  // Follow new output only while the reader is already near the bottom.
  const pinned = useRef(true)
  const follow = () => {
    const el = reply.current
    if (el && pinned.current) el.scrollTop = el.scrollHeight
  }
  useEffect(() => {
    const update = () =>
      void api
        .getSettings()
        .then((s) => {
          setName(s.pet.name)
          setToolView(s.toolView)
        })
        .catch(console.error)
    update()
    window.addEventListener('focus', update)
    return () => window.removeEventListener('focus', update)
  }, [])
  const from = Math.max(0, session.messages.length - recent)
  const shown = session.messages.slice(from)
  const open = shown.length > 0 || session.running
  // The shell sizes the window: the field's height while closed, the remembered box once open.
  const openNow = useRef(open)
  openNow.current = open
  const collapsed = useRef(76)
  const fit = useCallback((animate: boolean) => {
    void invoke('quick_fit', {
      collapsed: collapsed.current,
      open: openNow.current,
      animate,
    }).catch(console.error)
  }, [])
  useEffect(() => {
    const el = bar.current
    const field = el?.querySelector<HTMLElement>('.composer-wrap')
    if (!el || !field) return
    const measure = () => {
      const style = getComputedStyle(el)
      const height = Math.ceil(
        field.offsetHeight +
          parseFloat(style.paddingTop) +
          parseFloat(style.paddingBottom),
      )
      if (height === collapsed.current) return
      collapsed.current = height
      if (!openNow.current) fit(false)
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(field)
    return () => observer.disconnect()
  }, [fit])
  // Opening and closing animate; coming back on screen just takes the right size.
  const wasOpen = useRef<boolean | undefined>(undefined)
  useEffect(() => {
    const animate = wasOpen.current !== undefined && wasOpen.current !== open
    wasOpen.current = open
    fit(animate)
    requestAnimationFrame(follow)
  }, [open, fit])
  useEffect(() => {
    const snap = () => fit(false)
    window.addEventListener('focus', snap)
    return () => window.removeEventListener('focus', snap)
  }, [fit])
  const lastText = session.messages.at(-1)?.content
  useEffect(() => {
    requestAnimationFrame(follow)
  }, [lastText, session.running])
  // The shell resizes the window after the content changed (opening, a resize by hand).
  useEffect(() => {
    const keep = () => follow()
    window.addEventListener('resize', keep)
    return () => window.removeEventListener('resize', keep)
  }, [])
  const status = useTurnStatus(session, name)
  // Opening the bar or a new message brings the newest reply back next to the field.
  useEffect(() => {
    const back = () => {
      pinned.current = true
      requestAnimationFrame(follow)
    }
    back()
    window.addEventListener('focus', back)
    return () => window.removeEventListener('focus', back)
  }, [session.messages.length])
  /** The user message a reply answers: the nearest one before it. */
  const askedBefore = (i: number) =>
    session.messages.findLastIndex((m, k) => k < i && m.role === 'user')
  return (
    <div className="quick-bar" ref={bar} data-tauri-drag-region>
      {(shown.length > 0 || session.running) && (
        <section
          className="quick-reply"
          ref={reply}
          onScroll={(e) => {
            const el = e.currentTarget
            pinned.current =
              el.scrollHeight - el.scrollTop - el.clientHeight < 24
          }}
          onLoadCapture={follow}
        >
          <div className="quick-thread">
            {shown.map((m, k) => {
              const i = from + k
              return (
                <div className="turn" key={i}>
                  {m.role === 'assistant' ? (
                    <Reply
                      message={m}
                      tools={session.tools.filter((t) => t.turn === i)}
                      view={toolView}
                    />
                  ) : (
                    <>
                      {m.content && (
                        <article className="message user">
                          <PlainText content={m.content} />
                        </article>
                      )}
                      {m.attachments?.length ? (
                        <Attachments items={m.attachments} align="end" />
                      ) : null}
                    </>
                  )}
                  {m.error && (
                    <div className="error-row">
                      <p className="error" role="alert">
                        {m.error}
                      </p>
                      {!session.running && askedBefore(i) >= 0 && (
                        <button
                          type="button"
                          onClick={() =>
                            act(api.resend(askedBefore(i)), '重试失败')
                          }
                        >
                          重试
                        </button>
                      )}
                    </div>
                  )}
                  {!session.running && (m.content || m.attachments?.length) && (
                    <MessageActions
                      align={m.role === 'user' ? 'end' : 'start'}
                      text={m.content}
                      onRegenerate={
                        m.role === 'assistant' && askedBefore(i) >= 0
                          ? () =>
                              act(api.resend(askedBefore(i)), '重新生成失败')
                          : undefined
                      }
                    />
                  )}
                </div>
              )
            })}
            {session.running && <p className="muted status">{status}</p>}
            {actionError && (
              <p className="error" role="alert">
                {actionError}
              </p>
            )}
          </div>
        </section>
      )}
      <Composer
        running={session.running}
        quick
        name={name}
        continuing={session.messages.length > 0}
      />
    </div>
  )
}
