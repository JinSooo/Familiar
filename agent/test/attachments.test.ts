import { describe, expect, test } from 'bun:test'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  attachmentFile,
  filesDir,
  mediaTypeOf,
  safeName,
  saveAttachment,
  toModelMessage,
} from '../src/attachments'
import { parse, serialize } from '../src/conversations'

const id = '2026-11-01-1200-abcd'

describe('attachments', () => {
  test('saved under the conversation; a taken name gets a number', async () => {
    const a = await saveAttachment(id, 'cat.png', new Uint8Array([1, 2, 3]))
    const b = await saveAttachment(id, 'cat.png', new Uint8Array([4]))
    expect(a).toMatchObject({ path: `${id}/cat.png`, mediaType: 'image/png' })
    expect(b.path).toBe(`${id}/cat 2.png`)
    expect([...(await readFile(join(filesDir(), id, 'cat.png')))]).toEqual([
      1, 2, 3,
    ])
  })

  test('names and paths cannot leave the folder', () => {
    expect(safeName('../../etc/passwd')).toBe('_.._etc_passwd')
    expect(() => attachmentFile('../settings.json')).toThrow()
    expect(() => attachmentFile(`${id}/..`)).toThrow()
    expect(() => attachmentFile(`${id}/a/b`)).toThrow()
    expect(mediaTypeOf('main.ts')).toBe('text/plain')
    expect(mediaTypeOf('report.PDF')).toBe('application/pdf')
  })

  test('images go to the model as image parts, text files inline', async () => {
    const image = await saveAttachment(id, 'shot.png', new Uint8Array([9]))
    const text = await saveAttachment(
      id,
      'notes.md',
      new TextEncoder().encode('# hi'),
    )
    const message = await toModelMessage({
      role: 'user',
      content: '看看',
      attachments: [image, text],
    })
    const parts = message.content as { type: string; text?: string }[]
    expect(parts.map((p) => p.type)).toEqual(['text', 'image', 'text'])
    expect(parts[2]!.text).toContain('# hi')
  })

  test('a transcript keeps attachments and its body stays the text', () => {
    const attachment = {
      path: `${id}/cat.png`,
      name: 'cat.png',
      mediaType: 'image/png',
    }
    const text = serialize(
      {
        id,
        title: 't',
        createdAt: 1,
        updatedAt: 2,
        messages: [
          { role: 'user', content: '画只猫', createdAt: 1 },
          {
            role: 'assistant',
            content: '好的',
            createdAt: 2,
            attachments: [attachment],
          },
        ],
        tools: [],
      },
      '小黑',
    )
    expect(text).toContain('![cat.png](files/2026-11-01-1200-abcd/cat.png)')
    const back = parse(id, text)
    expect(back.messages[1]).toMatchObject({
      content: '好的',
      attachments: [attachment],
    })
  })
})

describe('conversation preview', () => {
  test('reads as text, not Markdown', async () => {
    const { plainText } = await import('../src/conversations')
    expect(
      plainText('- **图片**：橙色背景\n## 标题\n`code` 和 [链接](http://x.y)'),
    ).toBe('图片：橙色背景\n标题\ncode 和 链接')
  })
})
