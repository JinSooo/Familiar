import { randomUUID } from 'node:crypto'
import type { AgentEvent, ApprovalDecision } from '../../shared'
import type { ToolCall } from '../permissions'

const pending = new Map<string, (decision: ApprovalDecision) => void>()

export function resolveApproval(id: string, decision: ApprovalDecision): void {
  pending.get(id)?.(decision)
}

export function waitForApproval(
  call: ToolCall,
  reason: string,
  onEvent: (event: AgentEvent) => void,
  signal: AbortSignal,
): Promise<ApprovalDecision> {
  signal.throwIfAborted()
  const id = randomUUID()
  return new Promise((resolve, reject) => {
    const cleanup = (): void => {
      pending.delete(id)
      signal.removeEventListener('abort', abort)
    }
    const abort = (): void => {
      cleanup()
      reject(signal.reason)
    }
    pending.set(id, (decision) => {
      cleanup()
      resolve(decision)
    })
    signal.addEventListener('abort', abort, { once: true })
    try {
      onEvent({
        type: 'tool-approval-request',
        id,
        toolName: call.toolName,
        input: call.input,
        reason,
      })
    } catch (error) {
      cleanup()
      reject(error)
    }
  })
}
