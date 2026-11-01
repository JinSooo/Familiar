import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { extname, join } from 'node:path'
import type { ModelMessage } from 'ai'
import type { Attachment, Message } from '../../src/shared'
import { conversationsDir } from './system'

/**
 * Files kept with a conversation: what the user sends and what tools make (generated images).
 * They live beside the transcripts, in conversations/files/<conversation id>/, so the Markdown
 * can link to them and the workspace snapshot keeps them.
 */
export const filesDir = () => join(conversationsDir, 'files')
/** Big enough for photos and PDFs, small enough that a turn does not carry a video. */
export const maxAttachmentBytes = 20 * 1024 * 1024
/** Text files go into the prompt as text; beyond this they are cut. */
const maxInlineText = 60_000

const mediaTypes: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.heic': 'image/heic',
  '.pdf': 'application/pdf',
  '.txt': 'text/plain',
  '.md': 'text/markdown',
  '.csv': 'text/csv',
  '.json': 'application/json',
  '.html': 'text/html',
  '.xml': 'application/xml',
  '.yaml': 'text/yaml',
  '.yml': 'text/yaml',
}
/** Source code and other plain text that has no registered media type. */
const textExtensions = new Set([
  '.ts',
  '.tsx',
  '.js',
  '.jsx',
  '.mjs',
  '.cjs',
  '.py',
  '.rs',
  '.go',
  '.java',
  '.kt',
  '.swift',
  '.c',
  '.h',
  '.cpp',
  '.hpp',
  '.cs',
  '.rb',
  '.php',
  '.sh',
  '.zsh',
  '.sql',
  '.css',
  '.scss',
  '.vue',
  '.svelte',
  '.toml',
  '.ini',
  '.env',
  '.log',
  '.tex',
])

export function mediaTypeOf(name: string): string {
  const ext = extname(name).toLowerCase()
  return (
    mediaTypes[ext] ??
    (textExtensions.has(ext) ? 'text/plain' : 'application/octet-stream')
  )
}
const isText = (mediaType: string) =>
  mediaType.startsWith('text/') ||
  mediaType === 'application/json' ||
  mediaType === 'application/xml'

/** A file name that is safe as one path segment and readable in Finder. */
export function safeName(name: string): string {
  const base = name
    .replace(/[/\\:\0]/g, '_')
    .replace(/^\.+/, '')
    .trim()
    .slice(0, 120)
  return base || 'file'
}

/** Saves bytes under the conversation; a name already taken gets a number. */
export async function saveAttachment(
  conversationId: string,
  name: string,
  bytes: Uint8Array,
  mediaType = mediaTypeOf(name),
): Promise<Attachment> {
  if (!/^[0-9A-Za-z-]{1,64}$/.test(conversationId))
    throw new Error('对话编号无效')
  if (bytes.byteLength > maxAttachmentBytes)
    throw new Error(`文件太大（超过 ${maxAttachmentBytes / 1024 / 1024} MB）`)
  const dir = join(filesDir(), conversationId)
  await mkdir(dir, { recursive: true })
  const clean = safeName(name)
  const ext = extname(clean)
  const stem = clean.slice(0, clean.length - ext.length) || 'file'
  for (let i = 1; ; i++) {
    const candidate = i === 1 ? clean : `${stem} ${i}${ext}`
    try {
      await stat(join(dir, candidate))
    } catch {
      await writeFile(join(dir, candidate), bytes, { mode: 0o600, flag: 'wx' })
      return { path: `${conversationId}/${candidate}`, name: clean, mediaType }
    }
  }
}

/** The file on disk for an attachment path ("<conversation id>/<name>"). */
export function attachmentFile(path: string): string {
  const [id, file, ...rest] = path.split('/')
  if (
    !id ||
    !file ||
    rest.length ||
    !/^[0-9A-Za-z-]{1,64}$/.test(id) ||
    file === '.' ||
    file === '..'
  )
    throw new Error('附件路径无效')
  return join(filesDir(), id, file)
}

export async function readAttachment(attachment: Attachment): Promise<Buffer> {
  return readFile(attachmentFile(attachment.path))
}

/**
 * The model's view of a message: text plus its attachments as parts. Images and PDFs go in as
 * they are; text files are inlined; anything else is named so the model knows it was there.
 */
export async function toModelMessage(message: Message): Promise<ModelMessage> {
  if (!message.attachments?.length)
    return { role: message.role, content: message.content }
  if (message.role === 'assistant') {
    const names = message.attachments.map((a) => a.name).join('、')
    return {
      role: 'assistant',
      content: `${message.content}${message.content ? '\n\n' : ''}（附上了：${names}）`,
    }
  }
  const parts: Exclude<
    Extract<ModelMessage, { role: 'user' }>['content'],
    string
  > = []
  if (message.content) parts.push({ type: 'text', text: message.content })
  for (const a of message.attachments) {
    let bytes: Buffer
    try {
      bytes = await readAttachment(a)
    } catch {
      parts.push({ type: 'text', text: `（附件「${a.name}」已经找不到了）` })
      continue
    }
    if (a.mediaType.startsWith('image/'))
      parts.push({ type: 'image', image: bytes, mediaType: a.mediaType })
    else if (a.mediaType === 'application/pdf')
      parts.push({
        type: 'file',
        data: bytes,
        mediaType: a.mediaType,
        filename: a.name,
      })
    else if (isText(a.mediaType)) {
      const text = bytes.toString('utf8')
      parts.push({
        type: 'text',
        text: `附件「${a.name}」：\n<file>\n${text.slice(0, maxInlineText)}${text.length > maxInlineText ? '\n…（后面省略）' : ''}\n</file>`,
      })
    } else
      parts.push({
        type: 'text',
        text: `（附件「${a.name}」是 ${a.mediaType}，读不了内容）`,
      })
  }
  return { role: 'user', content: parts }
}
