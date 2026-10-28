import type { AgentEvent, Message } from '../../../src/shared'
import { getSettings } from '../settings'
import { decideToolCall } from '../permissions'
import { createWorkspaceTools, ensureWorkspace, snapshot } from '../workspace'
import { createMemoryTools, memoryInstructions, openMemory } from '../memory'
import { createWebTools, sourcesOf, webInstructions } from '../web'
import { runAgentCore } from './core'
import { createModel } from './provider'
import { createPersona } from './persona'
import { agentError } from './errors'
export { resolveApproval } from './approvals'

export async function runAgent(
  messages: Message[],
  onEvent: (event: AgentEvent) => void,
  signal: AbortSignal,
): Promise<void> {
  try {
    signal.throwIfAborted()
    const settings = getSettings()
    const model = createModel(settings.model)
    const workspacePath = await ensureWorkspace(settings)
    const memory = openMemory(workspacePath)
    await runAgentCore(messages, onEvent, signal, {
      model,
      tools: {
        ...createWorkspaceTools(settings),
        ...createMemoryTools(memory),
        ...createWebTools(settings),
      },
      sources: sourcesOf,
      instructions: `${createPersona(
        workspacePath,
        settings.permissionMode,
        settings.pet.name,
      )}\n\n${await memoryInstructions(memory.store)}\n\n${webInstructions}`,
      workspacePath,
      decide: (call) => decideToolCall(call, settings),
      snapshot,
    })
  } catch (error) {
    if (signal.aborted) onEvent({ type: 'finish', stopped: true })
    else throw agentError(error)
  }
}
