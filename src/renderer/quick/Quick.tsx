import { useEffect, useRef, useState } from 'react'
import { LogicalSize } from '@tauri-apps/api/dpi'
import { getCurrentWindow } from '@tauri-apps/api/window'
import { api } from '../api'
import { Attachments } from '../chat/Attachments'
import { Reply } from '../chat/Chat'
import { PlainText } from '../chat/Markdown'
import { Composer } from '../shared-ui/Composer'
import { useSession } from '../shared-ui/session'
import { useTurnStatus } from '../shared-ui/status'

const width = 680
const minHeight = 76
const maxHeight = 540
/** The last few messages: enough to follow a quick back-and-forth; the rest lives in the chat panel. */
const recent = 6

/** The quick-ask bar: a centered field that takes files, with the reply opening below it. */
export function Quick() {
  const session = useSession()
  const [name, setName] = useState('小黑')
  const bar = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const update = () =>
      void api
        .getSettings()
        .then((s) => setName(s.pet.name))
        .catch(console.error)
    update()
    window.addEventListener('focus', update)
    return () => window.removeEventListener('focus', update)
  }, [])
  // The window is as tall as its content: just the field until a reply opens under it.
  useEffect(() => {
    const el = bar.current
    if (!el) return
    const fit = () => {
      const height = Math.min(
        maxHeight,
        Math.max(minHeight, Math.ceil(el.offsetHeight)),
      )
      void getCurrentWindow()
        .setSize(new LogicalSize(width, height))
        .catch(console.error)
    }
    fit()
    const observer = new ResizeObserver(fit)
    observer.observe(el)
    return () => observer.disconnect()
  }, [])
  const status = useTurnStatus(session, name)
  const from = Math.max(0, session.messages.length - recent)
  const shown = session.messages.slice(from)
  const end = useRef<HTMLDivElement>(null)
  const lastText = session.messages.at(-1)?.content
  useEffect(() => {
    end.current?.scrollIntoView({ block: 'end' })
  }, [shown.length, lastText, session.running])
  return (
    <div className="quick-bar" ref={bar}>
      <Composer
        running={session.running}
        quick
        name={name}
        continuing={session.messages.length > 0}
      />
      {(shown.length > 0 || session.running) && (
        <section
          className="quick-reply"
          onLoadCapture={() => end.current?.scrollIntoView({ block: 'end' })}
        >
          {shown.map((m, k) =>
            m.role === 'assistant' ? (
              <Reply
                key={from + k}
                message={m}
                tools={session.tools.filter((t) => t.turn === from + k)}
              />
            ) : (
              <div className="turn" key={from + k}>
                {m.content && (
                  <article className="message user">
                    <PlainText content={m.content} />
                  </article>
                )}
                {m.attachments?.length ? (
                  <Attachments items={m.attachments} align="end" />
                ) : null}
              </div>
            ),
          )}
          {session.running && <p className="muted status">{status}</p>}
          {session.error && (
            <p className="error" role="alert">
              {session.error}
            </p>
          )}
          <div ref={end} />
        </section>
      )}
    </div>
  )
}
