import { setTimeout } from 'node:timers/promises'
import {
  ToolLoopAgent,
  isStepCount,
  type LanguageModel,
  type ToolSet,
} from 'ai'
import type { AgentEvent, Message } from '../../../src/shared'
import type { ToolCall, ToolDecision } from '../permissions'
import { waitForApproval } from './approvals'
import { agentError } from './errors'

const mutations = new Set([
  'write_file',
  'edit_file',
  'delete_path',
  'make_dir',
  'run_shell',
])

export interface AgentDependencies {
  model: LanguageModel
  tools: ToolSet
  instructions: string
  workspacePath: string
  decide: (call: ToolCall) => Promise<ToolDecision>
  snapshot: (path: string, message: string) => Promise<void>
}

function preview(output: unknown): string {
  const text =
    typeof output === 'string'
      ? output
      : (JSON.stringify(output) ?? String(output))
  return text.length > 2000 ? `${text.slice(0, 1999)}…` : text
}

/** No Electron or settings dependency: usable with SDK test models. */
export async function runAgentCore(
  messages: Message[],
  onEvent: (event: AgentEvent) => void,
  signal: AbortSignal,
  dependencies: AgentDependencies,
): Promise<void> {
  const executed = new Set<string>()
  let failure: unknown
  // Set once anything reached the user or a tool ran; after that a silent retry would duplicate it.
  let produced = false
  const emit = (event: AgentEvent): void => {
    produced = true
    onEvent(event)
  }
  for (let attempt = 0; ; attempt++) {
    try {
      await streamOnce()
      break
    } catch (error) {
      if (
        !signal.aborted &&
        !produced &&
        executed.size === 0 &&
        attempt < 2 &&
        interruptedStream(error)
      ) {
        await setTimeout(800 * (attempt + 1))
        continue
      }
      if (!signal.aborted) failure = agentError(error)
      break
    }
  }
  if (executed.size) {
    try {
      await dependencies.snapshot(
        dependencies.workspacePath,
        `familiar: ${[...executed].join(', ')}`,
      )
    } catch (error) {
      failure = new Error('工作目录快照保存失败，请检查目录和 Git 状态。', {
        cause: error,
      })
    }
  }
  if (failure) throw failure
  onEvent(
    signal.aborted ? { type: 'finish', stopped: true } : { type: 'finish' },
  )

  async function streamOnce(): Promise<void> {
    signal.throwIfAborted()
    const agent = new ToolLoopAgent({
      model: dependencies.model,
      tools: dependencies.tools,
      instructions: dependencies.instructions,
      // Lets the SDK retry failures before the response starts (5xx, 429, refused connections).
      maxRetries: 2,
      stopWhen: isStepCount(20),
      toolApproval: async ({ toolCall }) => {
        signal.throwIfAborted()
        const call = {
          id: toolCall.toolCallId,
          toolName: toolCall.toolName,
          input: toolCall.input,
        }
        const result = await dependencies.decide(call)
        signal.throwIfAborted()
        if (result.decision === 'deny')
          return { type: 'denied', reason: result.reason }
        if (result.decision === 'allow')
          return { type: 'approved', reason: result.reason }
        const decision = await waitForApproval(call, result, emit, signal)
        signal.throwIfAborted()
        return decision === 'approve'
          ? { type: 'approved', reason: '用户已批准' }
          : { type: 'denied', reason: `用户拒绝：${result.reason}` }
      },
      onToolExecutionStart: ({ toolCall }) => {
        signal.throwIfAborted()
        // Include failed/partially completed writes, so they are recoverable too.
        if (mutations.has(toolCall.toolName)) executed.add(toolCall.toolName)
      },
    })
    const result = await agent.stream({ messages, abortSignal: signal })
    for await (const part of result.fullStream) {
      signal.throwIfAborted()
      switch (part.type) {
        case 'text-delta':
          emit({ type: 'text-delta', text: part.text })
          break
        case 'tool-call':
          emit({
            type: 'tool-call',
            id: part.toolCallId,
            toolName: part.toolName,
            input: part.input,
          })
          break
        case 'tool-result':
          emit({
            type: 'tool-result',
            id: part.toolCallId,
            output: preview(part.output),
          })
          break
        case 'tool-error':
          emit({
            type: 'tool-result',
            id: part.toolCallId,
            output: '工具执行失败，请检查输入和访问权限。',
          })
          break
        case 'tool-output-denied':
          emit({
            type: 'tool-result',
            id: part.toolCallId,
            output: '工具执行已拒绝',
          })
          break
        case 'error':
          throw part.error
      }
    }
  }
}

/** The connection dropped after a 200 response started streaming (relay or proxy hiccup). */
function interruptedStream(error: unknown): boolean {
  const chain: string[] = []
  for (let current = error, i = 0; current && i < 6; i++) {
    if (current instanceof Error) chain.push(current.message)
    if (typeof current !== 'object') break
    current = (current as { cause?: unknown }).cause
  }
  return /ERR_INCOMPLETE_CHUNKED_ENCODING|ERR_CONNECTION_(RESET|CLOSED)|ERR_NETWORK_CHANGED|ECONNRESET|terminated|socket hang up|Failed to process successful response/i.test(
    chain.join(' '),
  )
}
