import {
  mkdir,
  readFile,
  readdir,
  rename,
  stat,
  writeFile,
} from 'node:fs/promises'
import { join } from 'node:path'
import {
  attachmentSchema,
  type Attachment,
  type ConversationSummary,
  type Session,
  type Source,
} from '../../src/shared'
import { conversationsDir, moveToTrash } from './system'

/**
 * One conversation per Markdown file. The visible text is for people (and git snapshots);
 * the `<!-- familiar {...} -->` line before each message carries what the app needs to read
 * it back: role, time, the turn's tool rows and its error.
 */
const marker = /^<!-- familiar (\{.*\}) -->$/m
const markerAll = new RegExp(marker.source, 'gm')
const validId = /^[0-9A-Za-z-]{1,64}$/

interface MessageMeta {
  role: 'user' | 'assistant'
  at: number
  bodyEncoding?: 'escaped-v1'
  attachments?: Attachment[]
  tools?: {
    name: string
    tool?: string
    done: boolean
    at?: number
    detail?: string
    output?: string
  }[]
  error?: string
  sources?: Source[]
}
export interface StoredConversation {
  id: string
  title: string
  createdAt: number
  updatedAt: number
  messages: Session['messages']
  tools: Session['tools']
}

export function newConversationId(now = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, '0')
  const stamp = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}`
  return `${stamp}-${Math.random().toString(16).slice(2, 6)}`
}

const oneLine = (text: string, limit: number): string => {
  const plain = text.replace(/\s+/g, ' ').trim()
  return [...plain].length > limit
    ? `${[...plain].slice(0, limit).join('')}…`
    : plain
}
/** Markdown as it reads: no list markers, emphasis, headings, code fences or link targets. */
export function plainText(markdown: string): string {
  return markdown
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/^\s{0,3}(#{1,6}\s+|[-*+]\s+|\d+\.\s+|>\s?)/gm, '')
    .replace(/(\*\*|__|\*|_|`|~~)(?=\S)([\s\S]*?\S)\1/g, '$2')
}

/** The first thing the user said; a conversation the pet opened (a proactive line) takes its first line instead. */
export function conversationTitle(messages: Session['messages']): string {
  const first =
    messages.find((m) => m.role === 'user' && m.content.trim()) ??
    messages.find((m) => m.content.trim())
  return first ? oneLine(plainText(first.content), 30) : '新对话'
}

function clock(at: number): string {
  return new Date(at).toLocaleString('zh-CN', {
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  })
}

export function serialize(
  conversation: StoredConversation,
  petName: string,
): string {
  const head = [
    '---',
    `title: ${JSON.stringify(conversation.title)}`,
    `created: ${JSON.stringify(new Date(conversation.createdAt).toISOString())}`,
    `updated: ${JSON.stringify(new Date(conversation.updatedAt).toISOString())}`,
    '---',
    '',
    `# ${conversation.title}`,
    '',
  ].join('\n')
  const body = conversation.messages.map((m, i) => {
    const tools = conversation.tools
      .filter((t) => t.turn === i)
      .map(({ name, tool, done, at, detail, output }) => ({
        name,
        ...(tool ? { tool } : {}),
        done,
        at,
        ...(detail ? { detail } : {}),
        ...(output ? { output } : {}),
      }))
    const meta: MessageMeta = {
      role: m.role,
      at: m.createdAt,
      bodyEncoding: 'escaped-v1',
      ...(tools.length ? { tools } : {}),
      ...(m.error ? { error: m.error } : {}),
      ...(m.sources?.length ? { sources: m.sources } : {}),
      ...(m.attachments?.length ? { attachments: m.attachments } : {}),
    }
    // The header line is regenerated from the metadata on every save, so readers can edit the body freely.
    const header = [
      `**${m.role === 'user' ? '你' : petName}** · ${clock(m.createdAt)}`,
      ...tools.map((t) => `${t.done ? '已' : '未完成：'}${t.name}`),
      ...(m.error ? [`出错：${oneLine(m.error, 80)}`] : []),
    ].join(' · ')
    // Escaped so a tool's output containing "-->" cannot end the comment early.
    const json = JSON.stringify(meta)
      .replace(/</g, '\\u003c')
      .replace(/>/g, '\\u003e')
    return `<!-- familiar ${json} -->\n${header}\n\n${encodeBody(m.content)}${attachmentLinks(m.attachments)}\n`
  })
  return `${head}\n${body.join('\n')}`
}

// Escape the escape character first, so literal entities round-trip too.
function encodeBody(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/<!-- familiar/g, '&lt;!-- familiar')
}
function decodeBody(text: string): string {
  return text
    .replace(/&lt;!-- familiar/g, '<!-- familiar')
    .replace(/&amp;/g, '&')
}

/** Links to a message's files, so the transcript opens them in any Markdown viewer. */
const linksStart = '\n\n<!-- familiar files -->\n'
function attachmentLinks(list: Attachment[] | undefined): string {
  if (!list?.length) return ''
  const link = (a: Attachment) => {
    const href = `files/${a.path.split('/').map(encodeURIComponent).join('/')}`
    return a.mediaType.startsWith('image/')
      ? `![${a.name}](${href})`
      : `[${a.name}](${href})`
  }
  return linksStart + list.map(link).join('\n')
}
/** The body without the links block written above (metadata is the source of truth). */
function stripAttachmentLinks(body: string): string {
  const at = body.lastIndexOf(linksStart.trim())
  return at === -1 ? body : body.slice(0, at).replace(/\n+$/, '')
}

export function parse(id: string, text: string): StoredConversation {
  const front = /^---\n([\s\S]*?)\n---\n/.exec(text)?.[1] ?? ''
  const field = (key: string): string | undefined => {
    const raw = new RegExp(`^${key}: (.*)$`, 'm').exec(front)?.[1]
    if (raw === undefined) return undefined
    try {
      return String(JSON.parse(raw))
    } catch {
      return raw.trim()
    }
  }
  const messages: Session['messages'] = []
  const tools: Session['tools'] = []
  const parts = text.split(markerAll)
  // split() with one capture group alternates: [before, meta, chunk, meta, chunk, …].
  for (let i = 1; i < parts.length; i += 2) {
    let meta: MessageMeta
    try {
      meta = JSON.parse(parts[i] ?? '') as MessageMeta
    } catch {
      continue
    }
    if (meta.role !== 'user' && meta.role !== 'assistant') continue
    const chunk = (parts[i + 1] ?? '').replace(/^\n/, '')
    const attachments = (meta.attachments ?? []).filter(
      (a) => attachmentSchema.safeParse(a).success,
    )
    const body = chunk.slice(chunk.indexOf('\n') + 1).replace(/^\n/, '')
    let content: string
    if (meta.bodyEncoding === 'escaped-v1') {
      // Only remove the separator we wrote, preserving the message's own trailing newlines.
      const raw = body.replace(i + 2 < parts.length ? /\n\n$/ : /\n$/, '')
      const links = attachments.length ? raw.lastIndexOf(linksStart) : -1
      content = decodeBody(links === -1 ? raw : raw.slice(0, links))
    } else {
      content = stripAttachmentLinks(body.replace(/\n+$/, ''))
    }
    const turn = messages.length
    messages.push({
      role: meta.role,
      content,
      createdAt: Number(meta.at) || 0,
      ...(meta.error ? { error: String(meta.error) } : {}),
      ...(attachments.length ? { attachments } : {}),
      ...(Array.isArray(meta.sources)
        ? {
            sources: meta.sources.filter(
              (s) => typeof s?.url === 'string' && typeof s?.title === 'string',
            ),
          }
        : {}),
    })
    for (const [k, t] of (meta.tools ?? []).entries())
      tools.push({
        id: `${id}-${turn}-${k}`,
        name: String(t.name),
        ...(typeof t.tool === 'string' && t.tool ? { tool: t.tool } : {}),
        done: Boolean(t.done),
        turn,
        ...(Number.isInteger(t.at) && t.at! >= 0 ? { at: t.at } : {}),
        ...(typeof t.detail === 'string' && t.detail
          ? { detail: t.detail.slice(0, 2000) }
          : {}),
        ...(typeof t.output === 'string' && t.output
          ? { output: t.output.slice(0, 2000) }
          : {}),
      })
  }
  const time = (key: string, fallback: number) => {
    const value = Date.parse(field(key) ?? '')
    return Number.isFinite(value) ? value : fallback
  }
  const last = messages.at(-1)?.createdAt ?? 0
  return {
    id,
    // Files saved before titles fell back to the pet's first line still say 新对话.
    title:
      (field('title') !== '新对话' && field('title')) ||
      conversationTitle(messages),
    createdAt: time('created', messages[0]?.createdAt ?? 0),
    updatedAt: time('updated', last),
    messages,
    tools,
  }
}

const file = (id: string) => {
  if (!validId.test(id)) throw new Error('对话编号无效')
  return join(conversationsDir, `${id}.md`)
}

export async function saveConversation(
  session: Session,
  petName: string,
): Promise<void> {
  if (!session.id || !session.messages.length) return
  const createdAt = session.messages[0]?.createdAt ?? session.updatedAt
  const text = serialize(
    {
      id: session.id,
      title: conversationTitle(session.messages),
      createdAt,
      updatedAt: session.updatedAt,
      messages: session.messages,
      tools: session.tools,
    },
    petName,
  )
  await mkdir(conversationsDir, { recursive: true })
  const target = file(session.id)
  await writeFile(`${target}.tmp`, text, { mode: 0o600 })
  await rename(`${target}.tmp`, target)
}

export async function loadConversation(
  id: string,
): Promise<StoredConversation> {
  try {
    return parse(id, await readFile(file(id), 'utf8'))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT')
      throw new Error('这个对话已经不在了（可能被移走或删除）')
    throw error
  }
}

async function ids(): Promise<string[]> {
  try {
    return (await readdir(conversationsDir))
      .filter((name) => name.endsWith('.md'))
      .map((name) => name.slice(0, -3))
      .filter((id) => validId.test(id))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
}

export async function listConversations(
  query = '',
): Promise<ConversationSummary[]> {
  const needle = query.trim().toLowerCase()
  const items = await Promise.all(
    (await ids()).map(async (id) => {
      try {
        const text = await readFile(file(id), 'utf8')
        if (needle && !text.toLowerCase().includes(needle)) return undefined
        const c = parse(id, text)
        const reply = c.messages.findLast(
          (m) => m.role === 'assistant' && (m.content || m.error),
        )
        return {
          id,
          title: c.title,
          preview: oneLine(plainText(reply?.content || reply?.error || ''), 60),
          updatedAt: c.updatedAt,
          messages: c.messages.length,
        }
      } catch {
        return undefined
      }
    }),
  )
  return items
    .filter((item): item is ConversationSummary => Boolean(item))
    .sort((a, b) => b.updatedAt - a.updatedAt)
}

/** The conversation's files folder goes to the Trash with it, when it has one. */
async function trashFiles(id: string): Promise<void> {
  const dir = join(conversationsDir, 'files', id)
  try {
    await stat(dir)
  } catch {
    return
  }
  await moveToTrash(dir)
}

export async function deleteConversation(id: string): Promise<void> {
  await moveToTrash(file(id))
  await trashFiles(id)
}

export async function clearConversations(): Promise<void> {
  for (const id of await ids()) {
    await moveToTrash(file(id))
    await trashFiles(id)
  }
}
