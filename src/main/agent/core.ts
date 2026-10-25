import {
  ToolLoopAgent,
  isStepCount,
  type LanguageModel,
  type ToolSet,
} from 'ai'
import type { AgentEvent, Message } from '../../shared'
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
  try {
    signal.throwIfAborted()
    const agent = new ToolLoopAgent({
      model: dependencies.model,
      tools: dependencies.tools,
      instructions: dependencies.instructions,
      maxRetries: 0,
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
        const decision = await waitForApproval(
          call,
          result.reason,
          onEvent,
          signal,
        )
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
          onEvent({ type: 'text-delta', text: part.text })
          break
        case 'tool-call':
          onEvent({
            type: 'tool-call',
            id: part.toolCallId,
            toolName: part.toolName,
            input: part.input,
          })
          break
        case 'tool-result':
          onEvent({
            type: 'tool-result',
            id: part.toolCallId,
            output: preview(part.output),
          })
          break
        case 'tool-error':
          onEvent({
            type: 'tool-result',
            id: part.toolCallId,
            output: '工具执行失败，请检查输入和访问权限。',
          })
          break
        case 'tool-output-denied':
          onEvent({
            type: 'tool-result',
            id: part.toolCallId,
            output: '工具执行已拒绝',
          })
          break
        case 'error':
          throw part.error
      }
    }
  } catch (error) {
    if (!signal.aborted) failure = agentError(error)
  } finally {
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
  }
  if (failure) throw failure
  onEvent(
    signal.aborted ? { type: 'finish', stopped: true } : { type: 'finish' },
  )
}
