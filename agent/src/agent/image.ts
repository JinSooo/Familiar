import { createOpenAI } from '@ai-sdk/openai'
import { generateImage, tool, type ToolSet } from 'ai'
import { z } from 'zod'
import type { Attachment, Settings } from '../../../src/shared'
import { readAttachment, saveAttachment } from '../attachments'
import { systemFetch } from './fetch'

/**
 * Image generation as a tool, on its own model and key (settings › 模型 › 生图): the ChatGPT plan
 * route that the chat may use cannot make images. Results are saved with the conversation and
 * shown under the reply; the tool returns only the file name, never the bytes.
 */
export function createImageTools(input: {
  settings: Settings
  conversationId: () => string
  /** Images the user attached in this turn, usable as edit sources. */
  attached: Attachment[]
  onImage: (attachment: Attachment) => void
}): ToolSet {
  const config = input.settings.imageModel
  if (!config.model.trim() || !config.apiKey.trim()) return {}
  const provider = createOpenAI({
    baseURL: config.baseURL.trim() || undefined,
    apiKey: config.apiKey.trim(),
    // Plain proxy-aware fetch: an image can take longer than the chat relay's response timeout.
    fetch: systemFetch,
  })
  return {
    generate_image: tool({
      description:
        '生成或修改图片。用户要你画图、做图、生成图片、改图时使用。prompt 用具体的画面描述（主体、风格、构图、颜色）。要改用户刚发的图片时把 edit_attached 设为 true。生成的图片会直接显示给用户，不用再贴链接。',
      inputSchema: z.object({
        prompt: z.string().min(1).max(4000),
        size: z.enum(['1024x1024', '1536x1024', '1024x1536']).optional(),
        edit_attached: z.boolean().optional(),
      }),
      execute: async ({ prompt, size, edit_attached }, { abortSignal }) => {
        try {
          const sources = edit_attached
            ? await Promise.all(
                input.attached
                  .filter((a) => a.mediaType.startsWith('image/'))
                  .map((a) => readAttachment(a)),
              )
            : []
          const { images } = await generateImage({
            model: provider.image(config.model.trim()),
            prompt: sources.length ? { images: sources, text: prompt } : prompt,
            ...(size ? { size } : {}),
            maxRetries: 1,
            abortSignal: abortSignal ?? AbortSignal.timeout(180_000),
          })
          const saved: string[] = []
          for (const [i, image] of images.entries()) {
            const ext =
              image.mediaType === 'image/jpeg'
                ? 'jpg'
                : (image.mediaType.split('/')[1] ?? 'png')
            const attachment = await saveAttachment(
              input.conversationId(),
              `生成的图片${images.length > 1 ? ` ${i + 1}` : ''}.${ext}`,
              image.uint8Array,
              image.mediaType,
            )
            input.onImage(attachment)
            saved.push(attachment.name)
          }
          return { ok: true, images: saved }
        } catch (error) {
          return {
            error: error instanceof Error ? error.message : String(error),
          }
        }
      },
    }),
  }
}

export const imageInstructions =
  '你可以用 generate_image 生成图片（如果这个工具可用）。用户要图时直接调用，图片会显示在回复里，回复里简单说一句画了什么就行。'
