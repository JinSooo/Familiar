import type { AgentEvent, Message } from '../../../src/shared'
import { prepareModelContext } from './context'
import { backgroundModel } from '../memory/jobs'
import { createImageTools, imageInstructions } from './image'
import { getSettings } from '../settings'
import { decideToolCall } from '../permissions'
import { createWorkspaceTools, ensureWorkspace, snapshot } from '../workspace'
import { createMemoryTools, memoryInstructions, openMemory } from '../memory'
import { createWebTools, sourcesOf, webInstructions } from '../web'
import { activeEmbedder } from '../embedding'
import {
  createKnowledgeTools,
  knowledgeInstructions,
  knowledgeSources,
} from '../knowledge'
import { mcpTools } from '../extensions/mcp'
import {
  createSkillTools,
  listSkills,
  skillInstructions,
} from '../extensions/skills'
import { runAgentCore } from './core'
import { createModel } from './provider'
import { createPersona, personaText } from './persona'
import { createReminderTools, reminderInstructions } from '../proactive/state'
import { proactiveChanged } from '../proactive'
import { agentError } from './errors'
import {
  computerInstructions,
  createComputerTools,
  endComputerTurn,
} from '../computer'
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
    await snapshot(workspacePath, 'familiar: 保存之前的改动')
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
    const tools = {
      ...createWorkspaceTools(settings, getSettings),
      ...createMemoryTools(memory, await activeEmbedder(settings)),
      ...createKnowledgeTools(settings),
      ...createWebTools(settings),
      ...createSkillTools(skills),
      ...createReminderTools(() => void proactiveChanged()),
      ...createComputerTools(settings),
      ...images,
      ...external,
    }
    const instructions = `${createPersona(
      workspacePath,
      settings.permissionMode,
      settings.pet.name,
      await personaText(),
    )}\n\n${await memoryInstructions(memory.store)}\n\n${knowledgeInstructions(settings)}\n\n${reminderInstructions}\n\n${webInstructions}\n\n${computerInstructions}\n\n${skillInstructions(skills)}${'generate_image' in images ? `\n\n${imageInstructions}` : ''}`
    const modelMessages = await prepareModelContext(messages, {
      conversationId,
      instructions,
      tools,
      summaryModel: backgroundModel,
      signal,
      canReadAttachment: async (path) =>
        (
          await decideToolCall(
            { id: '', toolName: 'read_file', input: { path } },
            getSettings(),
          )
        ).decision !== 'deny',
    })
    await runAgentCore(modelMessages, onEvent, signal, {
      model,
      protocol: settings.model.protocol,
      tools,
      instructions,
      sources: (name, output) => [
        ...sourcesOf(name, output),
        ...knowledgeSources(name, output),
      ],
      // The ChatGPT plan route keeps nothing (store:false). Told so, the SDK sends each step's
      // reasoning back encrypted instead of by id; by id the next step failed with 404 「Item
      // with id 'rs_…' not found」 (2026-11-07, a Computer Use turn on the plan).
      ...(settings.model.protocol === 'chatgpt'
        ? { providerOptions: { openai: { store: false } } }
        : {}),
      workspacePath,
      decide: (call) => decideToolCall(call, getSettings()),
      snapshot,
    })
  } catch (error) {
    if (signal.aborted) onEvent({ type: 'finish', stopped: true })
    else throw agentError(error)
  } finally {
    await endComputerTurn()
  }
}
