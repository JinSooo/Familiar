import {
  Children,
  isValidElement,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import remarkMath from 'remark-math'
import rehypeKatex from 'rehype-katex'
import rehypeHighlight from 'rehype-highlight'
import { normalizeMath } from './content'
import { openUrl } from '@tauri-apps/plugin-opener'
import type { MouseEvent } from 'react'

function openLink(event: MouseEvent<HTMLAnchorElement>) {
  event.preventDefault()
  const href = event.currentTarget.getAttribute('href')
  if (href && /^(https?:|mailto:)/i.test(href))
    void openUrl(href).catch(console.error)
}
import './markdown.css'

function codeText(node: ReactNode): string {
  return Children.toArray(node)
    .map((child) =>
      isValidElement<{ children?: ReactNode }>(child)
        ? codeText(child.props.children)
        : String(child),
    )
    .join('')
}
function CodeBlock({ children }: { children?: ReactNode }) {
  const [copied, setCopied] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  useEffect(() => () => clearTimeout(timer.current), [])
  const code = Children.toArray(children)[0]
  const language = isValidElement<{ className?: string }>(code)
    ? /language-([\w+-]+)/.exec(code.props.className ?? '')?.[1]
    : undefined
  return (
    <div className="code-block">
      <div className="code-toolbar">
        <span>{language ?? '代码'}</span>
        <button
          type="button"
          onClick={async () => {
            try {
              await navigator.clipboard.writeText(
                codeText(children).replace(/\n$/, ''),
              )
              setCopied(true)
              clearTimeout(timer.current)
              timer.current = setTimeout(() => setCopied(false), 1600)
            } catch {
              setCopied(false)
            }
          }}
        >
          {copied ? '已复制' : '复制'}
        </button>
      </div>
      <pre>{children}</pre>
    </div>
  )
}
export function Markdown({ content }: { content: string }) {
  return (
    <div className="markdown">
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkMath]}
        rehypePlugins={[rehypeKatex, rehypeHighlight]}
        skipHtml
        components={{
          pre: ({ children }) => <CodeBlock>{children}</CodeBlock>,
          a: ({ href, children }) => (
            <a
              href={href && /^(https?:|mailto:)/i.test(href) ? href : undefined}
              onClick={openLink}
              rel="noreferrer"
              title={href}
            >
              {children}
            </a>
          ),
          img: ({ src, alt }) =>
            typeof src === 'string' && /^https?:\/\//i.test(src) ? (
              <img src={src} alt={alt ?? ''} loading="lazy" />
            ) : null,
          table: ({ children }) => (
            <div className="markdown-table">
              <table>{children}</table>
            </div>
          ),
        }}
      >
        {normalizeMath(content)}
      </ReactMarkdown>
    </div>
  )
}
export function PlainText({ content }: { content: string }) {
  return content.split(/((?:https?:\/\/|mailto:)[^\s<>]+)/gi).map((part, i) =>
    /^(https?:\/\/|mailto:)/i.test(part) ? (
      <a key={i} href={part} onClick={openLink} rel="noreferrer" title={part}>
        {part}
      </a>
    ) : (
      part
    ),
  )
}
