import { describe, expect, test } from 'bun:test'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { settingsSchema, type Attachment } from '../../src/shared'
import { filesDir } from '../src/attachments'
import { createImageTools } from '../src/agent/image'

// A one-pixel PNG, what the fake service hands back.
const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
)

describe('generate_image', () => {
  test('no tool until an image model and key are set', () => {
    const settings = settingsSchema.parse({})
    expect(
      createImageTools({
        settings,
        conversationId: () => 'c',
        attached: [],
        onImage: () => {},
      }),
    ).toEqual({})
  })

  test('saves the generated image with the conversation and reports it', async () => {
    const seen: { path?: string; body?: Record<string, unknown> } = {}
    const server = Bun.serve({
      port: 0,
      async fetch(request) {
        seen.path = new URL(request.url).pathname
        seen.body = (await request.json()) as Record<string, unknown>
        return Response.json({ data: [{ b64_json: png.toString('base64') }] })
      },
    })
    try {
      const settings = settingsSchema.parse({
        imageModel: {
          model: 'gpt-image-2',
          baseURL: `http://127.0.0.1:${server.port}/v1`,
          apiKey: 'k',
        },
      })
      const made: Attachment[] = []
      const tools = createImageTools({
        settings,
        conversationId: () => '2026-11-01-1300-img1',
        attached: [],
        onImage: (a) => made.push(a),
      })
      const result = await tools.generate_image!.execute!(
        { prompt: '一只黑猫', size: '1024x1024' },
        { toolCallId: 't', messages: [] },
      )
      expect(result).toMatchObject({ ok: true })
      expect(seen.path).toBe('/v1/images/generations')
      expect(seen.body).toMatchObject({
        model: 'gpt-image-2',
        prompt: '一只黑猫',
      })
      expect(made).toHaveLength(1)
      expect(made[0]!.mediaType).toBe('image/png')
      const [id, name] = made[0]!.path.split('/')
      expect(await readFile(join(filesDir(), id!, name!))).toEqual(png)
    } finally {
      server.stop(true)
    }
  })
})
