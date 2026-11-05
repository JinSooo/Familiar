import { readdir, readFile, stat } from 'node:fs/promises'
import { basename, extname, join } from 'node:path'

/**
 * Which files the knowledge base reads and how they become chunks. Folders are read only:
 * nothing here writes into them.
 */
const textTypes = new Set([
  'md',
  'markdown',
  'mdx',
  'txt',
  'text',
  'org',
  'rst',
])
const codeTypes = new Set(
  'ts tsx js jsx mjs cjs py rs go swift java kt kts c h cc cpp hpp m mm cs rb php sh zsh bash fish sql lua r scala dart vue svelte css scss less html htm xml yaml yml toml ini tex'.split(
    ' ',
  ),
)
/** Build output, dependencies and caches: large and never what the user means. */
const skippedDirs = new Set([
  'node_modules',
  'dist',
  'build',
  'target',
  'out',
  'vendor',
  'Pods',
  'DerivedData',
  '__pycache__',
  'venv',
  'coverage',
])
const maxTextBytes = 2 * 1024 * 1024
const maxPdfBytes = 50 * 1024 * 1024
/** Per folder; past this the folder is marked truncated. */
export const maxFiles = 5000

export type FileKind = 'text' | 'code' | 'pdf'
export function kindOf(path: string): FileKind | undefined {
  const ext = extname(path).slice(1).toLowerCase()
  if (ext === 'pdf') return 'pdf'
  if (textTypes.has(ext)) return 'text'
  if (codeTypes.has(ext)) return 'code'
  return undefined
}

export interface FoundFile {
  path: string
  size: number
  mtime: number
  kind: FileKind
}

/** Every readable file under `root`, skipping hidden and build folders and oversized files. */
export async function walk(
  root: string,
): Promise<{ files: FoundFile[]; truncated: boolean }> {
  const files: FoundFile[] = []
  let truncated = false
  const visit = async (dir: string): Promise<void> => {
    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    entries.sort((a, b) => a.name.localeCompare(b.name))
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue
      const path = join(dir, entry.name)
      if (entry.isDirectory()) {
        if (!skippedDirs.has(entry.name)) await visit(path)
      } else if (entry.isFile()) {
        const kind = kindOf(path)
        if (!kind || /\.(min|lock)\.|-lock\./.test(entry.name)) continue
        let s
        try {
          s = await stat(path)
        } catch {
          continue
        }
        if (s.size === 0) continue
        if (s.size > (kind === 'pdf' ? maxPdfBytes : maxTextBytes)) continue
        if (files.length >= maxFiles) {
          truncated = true
          return
        }
        files.push({ path, size: s.size, mtime: s.mtimeMs, kind })
      }
      if (truncated) return
    }
  }
  await visit(root)
  return { files, truncated }
}

/** Text of a file; a PDF comes back one string per page. */
export async function extract(path: string, kind: FileKind): Promise<string[]> {
  if (kind === 'pdf') {
    const { extractText, getDocumentProxy } = await import('unpdf')
    const pdf = await getDocumentProxy(new Uint8Array(await readFile(path)))
    try {
      const { text } = await extractText(pdf, { mergePages: false })
      // Many PDFs set common characters with Kangxi radical glyphs (⼝ U+2F1D for 口), which
      // look the same but never match a typed query. Only those are normalized; full-width
      // punctuation stays as it is.
      return text.map((page) =>
        page.replace(/[\u2E80-\u2EFF\u2F00-\u2FDF]/g, (c) =>
          c.normalize('NFKC'),
        ),
      )
    } finally {
      // Typed loosely by unpdf; frees the parsed document.
      await (pdf as unknown as { destroy?: () => Promise<void> }).destroy?.()
    }
  }
  const text = await readFile(path, 'utf8')
  if (text.includes('\u0000')) throw new Error('不是文本文件')
  return [text]
}

export interface Chunk {
  /** Heading path for Markdown ("安装 › 依赖"), empty elsewhere. */
  heading: string
  /** Lines for text and code, pages for PDF; 1-based, inclusive. */
  start: number
  end: number
  text: string
}

const target = 800
const hardMax = 1600

/**
 * Splits a file into chunks of about 800 characters. Markdown breaks at headings first, then
 * at blank lines; each chunk remembers its heading path so a hit says where it is. PDF pages
 * are chunked one page at a time so a chunk names its page.
 */
export function chunk(pages: string[], kind: FileKind): Chunk[] {
  const out: Chunk[] = []
  if (kind === 'pdf') {
    pages.forEach((page, i) => {
      for (const part of split(page.replace(/[ \t]+\n/g, '\n'), target))
        if (part.trim())
          out.push({ heading: '', start: i + 1, end: i + 1, text: part.trim() })
    })
    return out
  }
  const lines = (pages[0] ?? '').replace(/\r\n?/g, '\n').split('\n')
  const headings: string[] = []
  let fence = false
  let buffer: string[] = []
  let size = 0
  let start = 1
  let heading = ''
  const flush = (end: number) => {
    const text = buffer.join('\n').trim()
    if (text) {
      // An over-long single block (minified line, huge paragraph) is cut by characters.
      const parts = text.length > hardMax ? split(text, target) : [text]
      for (const part of parts) out.push({ heading, start, end, text: part })
    }
    buffer = []
    size = 0
    start = end + 1
  }
  lines.forEach((line, i) => {
    const n = i + 1
    if (kind === 'text' && /^\s*(```|~~~)/.test(line)) fence = !fence
    const match =
      kind === 'text' && !fence ? /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line) : null
    if (match) {
      // A heading straight after another ("# 项目" then "## 安装") joins the next section
      // instead of becoming a chunk of its own.
      const content = buffer.some((l) => l.trim() && !/^#{1,6}\s/.test(l))
      if (content) flush(n - 1)
      if (!buffer.length) start = n
      headings.length = match[1]!.length - 1
      headings[match[1]!.length - 1] = match[2]!
      heading = headings.filter(Boolean).join(' › ')
    }
    const breakable = !fence && line.trim() === ''
    if (size >= target && (breakable || size >= hardMax)) flush(n - 1)
    if (!buffer.length && line.trim() === '') {
      start = n + 1
      return
    }
    buffer.push(line)
    size += line.length + 1
  })
  if (buffer.length) flush(lines.length)
  return out
}

/** Cuts text into pieces of about `size` characters, at a sentence or line end when it can. */
function split(text: string, size: number): string[] {
  const parts: string[] = []
  let rest = text
  while (rest.length > size * 1.5) {
    const window = rest.slice(0, size * 1.5)
    let cut = Math.max(
      window.lastIndexOf('\n', size * 1.2),
      ...['。', '！', '？', '. ', '; ', '；'].map(
        (p) => window.lastIndexOf(p, size * 1.2) + p.length - 1,
      ),
    )
    if (cut < size * 0.5) cut = size
    parts.push(rest.slice(0, cut + 1))
    rest = rest.slice(cut + 1)
  }
  if (rest.trim()) parts.push(rest)
  return parts
}

/** What a chunk is embedded and searched as: the file name and heading give it context. */
export function searchText(path: string, c: Chunk): string {
  const name = basename(path)
  return `${name}${c.heading ? ` › ${c.heading}` : ''}\n${c.text}`
}

/** Title of a Markdown file (first # heading) or its name without extension. */
export function titleOf(path: string, pages: string[]): string {
  const first = /^#\s+(.+)$/m.exec(pages[0]?.slice(0, 4000) ?? '')
  if (kindOf(path) === 'text' && first) return first[1]!.trim()
  return basename(path, extname(path))
}
