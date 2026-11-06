import type { AgentEvent, Attachment, Session } from '../../src/shared'
import { newConversationId } from './conversations'
export const emptySession = (): Session => ({
  id: '',
  updatedAt: 0,
  messages: [],
  running: false,
  approvals: [],
  tools: [],
  error: '',
  origin: 'chat',
  bubble: '',
})
export function beginTurn(
  session: Session,
  text: string,
  origin: Session['origin'],
  attachments: Attachment[] = [],
): Session {
  const now = Date.now()
  return {
    ...session,
    previous: undefined,
    id: session.id || newConversationId(new Date(now)),
    updatedAt: now,
    messages: [
      // Empty replies stay (stopped or failed turns): tool rows and errors point at them by index.
      ...session.messages,
      {
        role: 'user',
        content: text,
        createdAt: now,
        ...(attachments.length ? { attachments } : {}),
      },
      { role: 'assistant', content: '', createdAt: now },
    ],
    running: true,
    approvals: [],
    error: '',
    origin,
    bubble: '',
  }
}
/**
 * The conversation cut back to before message `index` (a user message): what is resent from
 * there, with its files, and the session without it and anything after.
 */
export function rewind(
  session: Session,
  index: number,
): { session: Session; message: Session['messages'][number] } {
  const message = session.messages[index]
  if (!message || message.role !== 'user')
    throw new Error('只能从你发的消息重新开始')
  return {
    message,
    session: {
      ...session,
      messages: session.messages.slice(0, index),
      tools: session.tools.filter((t) => t.turn < index),
      approvals: [],
      error: '',
      bubble: '',
    },
  }
}
export function reduceSession(session: Session, event: AgentEvent): Session {
  const next = { ...session }
  if (event.type === 'text-delta') {
    next.messages = session.messages.map((m, i) =>
      i === session.messages.length - 1
        ? { ...m, content: m.content + event.text }
        : m,
    )
    next.bubble += event.text
  }
  // Tool rows, files and source cards remember where the reply text was, to show in order.
  const at = session.messages.at(-1)?.content.length ?? 0
  if (event.type === 'attachment') {
    const last = session.messages.length - 1
    next.messages = session.messages.map((m, i) =>
      i === last && m.role === 'assistant'
        ? {
            ...m,
            attachments: [
              ...(m.attachments ?? []),
              { ...event.attachment, at },
            ],
          }
        : m,
    )
  }
  if (event.type === 'tool-call')
    next.tools = [
      ...session.tools,
      {
        id: event.id,
        name: toolDescription(event.toolName, event.input),
        ...(toolDetail(event.toolName, event.input)
          ? { detail: toolDetail(event.toolName, event.input) }
          : {}),
        done: false,
        turn: session.messages.length - 1,
        at,
      },
    ]
  if (event.type === 'tool-result')
    next.tools = session.tools.map((t) =>
      t.id === event.id
        ? {
            ...t,
            done: true,
            ...(toolOutput(event.output)
              ? { output: toolOutput(event.output) }
              : {}),
          }
        : t,
    )
  if (event.type === 'sources') {
    const last = session.messages.length - 1
    next.messages = session.messages.map((m, i) => {
      if (i !== last || m.role !== 'assistant') return m
      const known = new Set((m.sources ?? []).map((s) => s.url))
      const added = event.sources
        .filter((s) => !known.has(s.url) && known.add(s.url))
        .map((s) => ({ ...s, at }))
      return { ...m, sources: [...(m.sources ?? []), ...added].slice(0, 20) }
    })
  }
  if (event.type === 'tool-approval-request')
    next.approvals = [...session.approvals, event]
  if (event.type === 'error') {
    next.error = event.message
    next.bubble = event.message
    next.messages = session.messages.map((m, i) =>
      i === session.messages.length - 1 && m.role === 'assistant'
        ? { ...m, error: event.message }
        : m,
    )
  }
  if (event.type === 'finish' || event.type === 'error') {
    next.running = false
    next.approvals = []
  }
  return next
}
/**
 * What goes away when the user leaves for another app. Nothing while something still needs them
 * here. The quick-ask bar has its own setting (dragging a file in from Finder leaves it first),
 * and also stays while its reply is coming, so a glance away does not lose it.
 */
export function blurHides(state: {
  autoHide: boolean
  quickAutoHide: boolean
  approvals: number
  draft: boolean
  running: boolean
}): { chat: boolean; quick: boolean } {
  const stay = state.approvals > 0 || state.draft
  return {
    chat: state.autoHide && !stay,
    quick: state.quickAutoHide && !stay && !state.running,
  }
}
/**
 * Where a running turn has to move so the user can see it (an approval, a long capsule reply):
 * the big window for a turn from the quick bar or already handed there, else the chat panel.
 * A turn handed to the big window stays there even before the shell reports it visible.
 */
export function expandTo(state: {
  turnWindow: string
  mainVisible: boolean
  chatVisible: boolean
  approvalRequested: boolean
  needsRoom: boolean
  expanded: boolean
}): 'main' | 'chat' | undefined {
  if (state.turnWindow === 'main' && (state.mainVisible || state.expanded))
    return undefined
  const move =
    (state.approvalRequested && !state.chatVisible) ||
    (state.needsRoom && !state.expanded)
  if (!move) return undefined
  return state.turnWindow === 'quick' ? 'main' : 'chat'
}
export function shouldExpand(session: Session): boolean {
  return (
    session.approvals.length > 0 ||
    (session.origin === 'capsule' && [...session.bubble].length > 80)
  )
}
export function bubbleTimeout(text: string): number {
  return 12000 + Math.min(8000, [...text].length * 60)
}

const toolTextLimit = 2000
const capped = (text: string) =>
  text.length > toolTextLimit ? `${text.slice(0, toolTextLimit - 1)}…` : text
/** What a tool gave back, as text. */
function toolOutput(output: unknown): string {
  const text =
    typeof output === 'string'
      ? output
      : (JSON.stringify(output, null, 2) ?? '')
  return capped(text.trim())
}
/** The whole input behind a tool row: the command, path or query, or the arguments as JSON. */
export function toolDetail(name: string, input: unknown): string {
  const field = (key: string): string =>
    input && typeof input === 'object' && key in input
      ? String((input as Record<string, unknown>)[key] ?? '')
      : ''
  const one: Record<string, string> = {
    run_shell: 'command',
    read_file: 'path',
    write_file: 'path',
    edit_file: 'path',
    list_dir: 'path',
    make_dir: 'path',
    delete_path: 'path',
    web_search: 'query',
    fetch_page: 'url',
    save_page: 'url',
    search_knowledge: 'query',
    remember: 'text',
    use_skill: 'name',
  }
  const key = one[name]
  const text = key
    ? field(key)
    : input && typeof input === 'object' && Object.keys(input).length
      ? JSON.stringify(input, null, 2)
      : ''
  return capped(text.trim())
}
/**
 * Whether opening the quick-ask bar starts a new conversation: every time, or after a quiet
 * spell (settings 快捷问答条打开时). Never while it is already open or a reply is running.
 */
export function quickStartsFresh(state: {
  mode: 'continue' | 'new'
  idleMinutes: number
  shown: boolean
  running: boolean
  messages: number
  lastActivity: number
  now: number
}): boolean {
  if (state.shown || state.running || !state.messages) return false
  return (
    state.mode === 'new' ||
    state.now - state.lastActivity > state.idleMinutes * 60_000
  )
}
function toolDescription(name: string, input: unknown): string {
  const labels: Record<string, string> = {
    write_file: '写入',
    read_file: '读取',
    edit_file: '编辑',
    list_dir: '查看目录',
    make_dir: '新建目录',
    delete_path: '移到废纸篓',
    run_shell: '执行命令',
    remember: '记住',
    forget: '忘掉',
    recall: '回想',
    web_search: '搜索',
    use_skill: '使用技能',
    fetch_page: '读网页',
    save_page: '存网页',
    search_knowledge: '查资料',
    read_knowledge: '读资料',
    remind: '设提醒',
    add_todo: '记待办',
    list_reminders: '查看提醒',
    cancel_reminder: '取消提醒',
  }
  const field = (key: string): string =>
    input && typeof input === 'object' && key in input
      ? String((input as Record<string, unknown>)[key] ?? '')
      : ''
  // The one-line row only has room for the file name; the full input is in the approval card.
  const target =
    name === 'run_shell'
      ? field('command')
      : name === 'remember'
        ? field('text')
        : name === 'forget'
          ? '一条记忆'
          : name === 'recall'
            ? field('query') || field('topic') || '全部记忆'
            : name === 'remind'
              ? `${field('at')} ${field('text')}`
              : name === 'add_todo'
                ? field('text')
                : name === 'use_skill'
                  ? field('name')
                  : name === 'web_search'
                    ? field('query')
                    : name === 'search_knowledge'
                      ? field('query')
                      : name === 'fetch_page' || name === 'save_page'
                        ? (field('url')
                            .replace(/^https?:\/\/(www\.)?/, '')
                            .split('/')[0] ?? '')
                        : (field('path').split('/').filter(Boolean).at(-1) ??
                          '')
  const short = target.length > 40 ? `${target.slice(0, 39)}…` : target
  const mcp = /^mcp__(.+?)__(.+)$/.exec(name)
  if (mcp) return `调用 ${mcp[1]} 的 ${mcp[2]}`
  return `${labels[name] ?? name}${short ? ` ${short}` : ''}`
}
