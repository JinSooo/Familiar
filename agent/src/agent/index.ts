import type { AgentEvent, Message } from '../../../src/shared'
import { toModelMessage } from '../attachments'
import { createImageTools, imageInstructions } from './image'
import { getSettings } from '../settings'
import { decideToolCall } from '../permissions'
import { createWorkspaceTools, ensureWorkspace, snapshot } from '../workspace'
import { createMemoryTools, memoryInstructions, openMemory } from '../memory'
import { createWebTools, sourcesOf, webInstructions } from '../web'
import { activeEmbedder } from '../embedding'
import { createKnowledgeTools, knowledgeInstructions } from '../knowledge'
import { mcpTools } from '../extensions/mcp'
import {
  createSkillTools,
  listSkills,
  skillInstructions,
} from '../extensions/skills'
import { runAgentCore } from './core'
import { createModel } from './provider'
import { createPersona } from './persona'
import { createReminderTools, reminderInstructions } from '../proactive/state'
import { proactiveChanged } from '../proactive'
import { agentError } from './errors'
export { resolveApproval } from './approvals'

export async function runAgent(
  messages: Message[],
  onEvent: (event: AgentEvent) => void,
  signal: AbortSignal,
  conversationId = '',
): Promise<void> {
  try {
    signal.throwIfAborted()
    const settings = getSettings()
    const model = createModel(settings.model)
    const workspacePath = await ensureWorkspace(settings)
    const memory = openMemory()
    const skills = (await listSkills()).filter(
      (s) => !settings.disabledSkills.includes(s.name),
    )
    // A broken MCP server shows up on the extensions page; it must not stop the conversation.
    const external = await mcpTools().catch((error: unknown) => {
      console.error('MCP tools unavailable', error)
      return {}
    })
    const attached = messages.at(-1)?.attachments ?? []
    const images = conversationId
      ? createImageTools({
          settings,
          conversationId: () => conversationId,
          attached,
          onImage: (attachment) => onEvent({ type: 'attachment', attachment }),
        })
      : {}
    const modelMessages = await Promise.all(messages.map(toModelMessage))
    await runAgentCore(modelMessages, onEvent, signal, {
      model,
      tools: {
        ...createWorkspaceTools(settings),
        ...createMemoryTools(memory, await activeEmbedder(settings)),
        ...createKnowledgeTools(settings),
        ...createWebTools(settings),
        ...createSkillTools(skills),
        ...createReminderTools(() => void proactiveChanged()),
        ...images,
        ...external,
      },
      sources: sourcesOf,
      instructions: `${createPersona(
        workspacePath,
        settings.permissionMode,
        settings.pet.name,
      )}\n现在是 ${new Date().toLocaleString('zh-CN', { hour12: false, weekday: 'long' })}。\n\n${await memoryInstructions(memory.store)}\n\n${knowledgeInstructions(settings)}\n\n${reminderInstructions}\n\n${webInstructions}\n\n${skillInstructions(skills)}${'generate_image' in images ? `\n\n${imageInstructions}` : ''}`,
      workspacePath,
      decide: (call) => decideToolCall(call, settings),
      snapshot,
    })
  } catch (error) {
    if (signal.aborted) onEvent({ type: 'finish', stopped: true })
    else throw agentError(error)
  }
}
