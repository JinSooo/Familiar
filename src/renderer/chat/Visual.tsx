import { useEffect, useId, useRef, useState } from 'react'
import { openUrl } from '@tauri-apps/plugin-opener'
import type { Source } from '../../shared'

/**
 * Rich pieces of a reply: Mermaid diagrams, Vega-Lite charts, web images with a viewer, and
 * source cards. The chart libraries are large, so they load on first use.
 */
const dark = () => window.matchMedia('(prefers-color-scheme: dark)').matches

function Fallback({ code, error }: { code: string; error: string }) {
  return (
    <div className="visual-error">
      <p className="error">{error}</p>
      <pre>{code}</pre>
    </div>
  )
}

export function MermaidDiagram({ code }: { code: string }) {
  const id = `m${useId().replace(/[^a-zA-Z0-9]/g, '')}`
  const [svg, setSvg] = useState('')
  const [error, setError] = useState('')
  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const { default: mermaid } = await import('mermaid')
        // strict: no click handlers or HTML labels from the model's text.
        mermaid.initialize({
          startOnLoad: false,
          securityLevel: 'strict',
          theme: dark() ? 'dark' : 'neutral',
          fontFamily: 'inherit',
        })
        const result = await mermaid.render(id, code)
        if (!cancelled) setSvg(result.svg)
      } catch (e) {
        if (!cancelled)
          setError(
            `图没画出来：${e instanceof Error ? e.message.split('\n')[0] : '语法有误'}`,
          )
      }
    })()
    return () => {
      cancelled = true
    }
  }, [code, id])
  if (error) return <Fallback code={code} error={error} />
  return svg ? (
    <div className="visual mermaid" dangerouslySetInnerHTML={{ __html: svg }} />
  ) : (
    <div className="visual loading muted">正在画图…</div>
  )
}

export function VegaChart({ code }: { code: string }) {
  const box = useRef<HTMLDivElement>(null)
  const [error, setError] = useState('')
  useEffect(() => {
    let finalize: (() => void) | undefined
    let cancelled = false
    void (async () => {
      try {
        const spec = JSON.parse(code) as Record<string, unknown>
        const [{ default: embed }, { expressionInterpreter }, vega] =
          await Promise.all([
            import('vega-embed'),
            import('vega-interpreter'),
            import('vega'),
          ])
        if (cancelled || !box.current) return
        // Charts only draw the data written into them: no fetching URLs from a model's spec.
        const loader = vega.loader()
        loader.load = () => Promise.reject(new Error('图表不能读取外部数据'))
        const result = await embed(
          box.current,
          {
            width: 'container',
            ...spec,
            autosize: { type: 'fit-x', contains: 'padding' },
          } as never,
          {
            actions: false,
            renderer: 'svg',
            // The app's CSP forbids eval; the interpreter evaluates expressions without it.
            ast: true,
            expr: expressionInterpreter,
            loader,
            theme: dark() ? 'dark' : undefined,
            config: { background: 'transparent' },
          },
        )
        finalize = () => result.finalize()
      } catch (e) {
        if (!cancelled)
          setError(
            `图表没画出来：${e instanceof Error ? e.message.split('\n')[0] : '数据有误'}`,
          )
      }
    })()
    return () => {
      cancelled = true
      finalize?.()
    }
  }, [code])
  if (error) return <Fallback code={code} error={error} />
  return <div className="visual chart" ref={box} />
}

/** An image from the web: hides itself if it fails, opens the viewer on click. */
export function WebImage({ src, alt }: { src: string; alt: string }) {
  const [broken, setBroken] = useState(false)
  if (broken) return null
  return (
    <button
      type="button"
      className="md-image"
      title={alt || '查看大图'}
      onClick={() =>
        window.dispatchEvent(
          new CustomEvent('familiar:image', { detail: { src, alt } }),
        )
      }
    >
      <img
        src={src}
        alt={alt}
        loading="lazy"
        referrerPolicy="no-referrer"
        onError={() => setBroken(true)}
      />
      {alt && <span className="caption">{alt}</span>}
    </button>
  )
}

/** Full-window image viewer; mounted once per window. */
export function ImageViewer() {
  const [image, setImage] = useState<{ src: string; alt: string }>()
  useEffect(() => {
    const open = (e: Event) =>
      setImage((e as CustomEvent<{ src: string; alt: string }>).detail)
    window.addEventListener('familiar:image', open)
    return () => window.removeEventListener('familiar:image', open)
  }, [])
  useEffect(() => {
    if (!image) return
    // Capture phase: Esc closes the viewer before the window's own Esc handling runs.
    const key = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      e.stopImmediatePropagation()
      setImage(undefined)
    }
    window.addEventListener('keydown', key, true)
    return () => window.removeEventListener('keydown', key, true)
  }, [image])
  if (!image) return null
  return (
    <div
      className="image-viewer"
      role="dialog"
      aria-label={image.alt || '图片'}
      onClick={() => setImage(undefined)}
    >
      <img src={image.src} alt={image.alt} referrerPolicy="no-referrer" />
      <div className="image-viewer-bar" onClick={(e) => e.stopPropagation()}>
        <span>{image.alt}</span>
        <button type="button" onClick={() => void openUrl(image.src)}>
          在浏览器打开
        </button>
        <button type="button" onClick={() => setImage(undefined)}>
          关闭
        </button>
      </div>
    </div>
  )
}

const host = (url: string) => {
  try {
    return new URL(url).hostname.replace(/^www\./, '')
  } catch {
    return url
  }
}
export function SourceCards({ sources }: { sources: Source[] }) {
  if (!sources.length) return null
  return (
    <div className="sources">
      <span className="muted sources-label">来源 · {sources.length}</span>
      <div className="source-row">
        {sources.map((s) => (
          <button
            type="button"
            key={s.url}
            className="source-card"
            title={s.url}
            onClick={() => void openUrl(s.url).catch(console.error)}
          >
            {s.image && (
              <img
                className="source-thumb"
                src={s.image}
                alt=""
                loading="lazy"
                referrerPolicy="no-referrer"
                onError={(e) => e.currentTarget.remove()}
              />
            )}
            <span className="source-title">{s.title}</span>
            <span className="source-host muted">
              <img
                src={`https://${host(s.url)}/favicon.ico`}
                alt=""
                referrerPolicy="no-referrer"
                onError={(e) => (e.currentTarget.style.visibility = 'hidden')}
              />
              {host(s.url)}
            </span>
          </button>
        ))}
      </div>
    </div>
  )
}
