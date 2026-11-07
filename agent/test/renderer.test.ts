import { describe, expect, test } from 'bun:test'
import { readFile } from 'node:fs/promises'
import { loader } from 'vega'
import { settingsSchema, type PublicSettings } from '../../src/shared'
import {
  activeEdit,
  submitEdit,
  createDraftStore,
  sendDraft,
  sendError,
  inputKey,
  limitFiles,
  maxBytes,
  maxFiles,
} from '../../src/renderer/shared-ui/input'
import {
  observeSnapshot,
  createListenerBarrier,
  recoverSettings,
} from '../../src/renderer/shared-ui/synchronization'
import {
  chartSpec,
  restrictChartLoader,
  asyncResource,
} from '../../src/renderer/chat/visual-safety'
import { maxAttachmentBytes } from '../src/attachments'

const deferred = <T>() => {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}
const tick = async () => {
  await Promise.resolve()
  await Promise.resolve()
}
const source = (path: string) =>
  readFile(new URL(`../../src/renderer/${path}`, import.meta.url), 'utf8')
const file = (name: string) => ({
  file: new File(['image'], name, { type: 'image/png' }),
  preview: `blob:${name}`,
})

describe('renderer event ordering', () => {
  test('a session broadcast beats an older initial response, including after restart', async () => {
    const initial = deferred<string>()
    let event!: (value: string) => void
    const seen: string[] = []
    const off = observeSnapshot(
      () => initial.promise,
      (cb) => {
        event = cb
        return () => {}
      },
      (s) => seen.push(s),
    )
    event('running with approval')
    event('restarted and idle')
    initial.resolve('old running state')
    await tick()
    expect(seen).toEqual(['running with approval', 'restarted and idle'])
    off()
  })
  test('a disposed view ignores late snapshots and callbacks', async () => {
    const initial = deferred<string>()
    const seen: string[] = []
    let event!: (value: string) => void
    let removed = 0
    const off = observeSnapshot(
      () => initial.promise,
      (cb) => {
        event = cb
        return () => {
          removed++
        }
      },
      (s) => seen.push(s),
    )
    off()
    initial.resolve('late')
    event('queued event')
    await tick()
    expect(removed).toBe(1)
    expect(seen).toEqual([])
  })
  test('ready waits for async listener installation, including listeners added in the same turn', async () => {
    const barrier = createListenerBarrier()
    const registered = deferred<void>()
    const calls: string[] = []
    barrier.ready(() => calls.push('ready'))
    barrier.track(
      registered.promise.then(() => {
        calls.push('listening')
      }),
    )
    await tick()
    expect(calls).toEqual([])
    registered.resolve()
    await tick()
    await tick()
    expect(calls).toEqual(['listening', 'ready'])
  })
  test('settings changes and restarts refresh visible chat preferences', async () => {
    for (const path of ['chat/Chat.tsx', 'quick/Quick.tsx'])
      expect(await source(path)).toContain('api.onSkin(update)')
    expect(await source('settings/SettingsView.tsx')).toContain(
      'api.onSkin(refresh)',
    )
  })
  test('failed initial settings can recover without replacing an existing unsaved field', () => {
    const loaded = settingsSchema.parse({}) as unknown as PublicSettings
    expect(recoverSettings(undefined, loaded)).toEqual(loaded)
    const edited = { ...loaded, pet: { ...loaded.pet, name: '正在编辑' } }
    expect(recoverSettings(edited, loaded)?.pet.name).toBe('正在编辑')
  })
})

describe('composer drafts and attachments', () => {
  test('unmounting for history or a closed capsule preserves the draft', () => {
    const draft = createDraftStore()
    const stop = draft.subscribe(() => {})
    draft.set({ input: '还没说完', files: [file('one.png')] })
    stop()
    expect(draft.get().input).toBe('还没说完')
    expect(draft.get().files).toHaveLength(1)
  })
  test('typing during attachment encoding belongs to the next draft', async () => {
    const draft = createDraftStore()
    const encoded = deferred<string>()
    const sent: string[] = []
    draft.set({ input: '第一条', files: [file('one.png')] })
    const sending = sendDraft(
      draft,
      async (text) => {
        sent.push(text)
      },
      () => encoded.promise,
      () => {},
    )
    draft.set({ input: '下一条', files: [file('two.png')] })
    encoded.resolve('data')
    await sending
    expect(sent).toEqual(['第一条'])
    expect(draft.get().input).toBe('下一条')
    expect(draft.get().files.map((f) => f.file.name)).toEqual(['two.png'])
  })
  test('a rejected send restores its files and text without losing the next draft', async () => {
    const draft = createDraftStore()
    const reply = deferred<void>()
    const revoked: string[] = []
    draft.set({ input: '第一条', files: [file('one.png')] })
    const sending = sendDraft(
      draft,
      () => reply.promise,
      async () => 'data',
      (url) => revoked.push(url),
    )
    await tick()
    draft.set({ input: '下一条', files: [file('two.png')] })
    reply.reject('已有对话正在运行')
    await expect(sending).rejects.toBe('已有对话正在运行')
    expect(draft.get().input).toBe('第一条\n下一条')
    expect(draft.get().files.map((f) => f.file.name)).toEqual([
      'one.png',
      'two.png',
    ])
    expect(revoked).toEqual([])
  })
  test('Tauri string rejections retain the actionable reason', () => {
    expect(sendError('已有对话正在运行')).toBe('已有对话正在运行')
    expect(sendError(new Error('连接断开'))).toBe('连接断开')
    expect(sendError(null)).toBe('没发出去，再试一次')
  })
  test('discarded thumbnails are released, retained thumbnails stay alive', () => {
    const files = Array.from({ length: 12 }, (_, i) => file(`${i}.png`))
    const revoked: string[] = []
    expect(limitFiles(files, (url) => revoked.push(url))).toEqual(
      files.slice(0, 10),
    )
    expect(revoked).toEqual(['blob:10.png', 'blob:11.png'])
    expect(maxFiles).toBe(10)
    expect(maxBytes).toBe(maxAttachmentBytes)
  })
})

describe('IME keys', () => {
  test('quick Escape is handled by the window when focus is on a reply action', async () => {
    const quick = await source('quick/Quick.tsx')
    expect(quick).toContain("window.addEventListener('keydown', escape)")
    expect(quick).toContain('api.hideQuick()')
    expect(quick).toContain("window.removeEventListener('keydown', escape)")
  })
  test('composition Esc and confirmation Enter do not invoke application actions', () => {
    expect(inputKey({ key: 'Escape', isComposing: true })).toBeUndefined()
    expect(inputKey({ key: 'Enter', isComposing: true })).toBeUndefined()
    expect(inputKey({ key: 'Escape', isComposing: false })).toBe('close')
    expect(inputKey({ key: 'Enter', isComposing: false })).toBe('send')
    expect(
      inputKey({ key: 'Enter', isComposing: false, shiftKey: true }),
    ).toBeUndefined()
  })
})

describe('model chart boundaries and cleanup', () => {
  test('chart metadata cannot override the interpreter, loader or actions', () => {
    const input = {
      mark: 'bar',
      data: { values: [{ x: 2 }] },
      usermeta: { embedOptions: { ast: false, actions: true } },
    }
    const spec = chartSpec(JSON.stringify(input))
    expect(spec.mark).toBe('bar')
    expect(spec.data).toEqual(input.data)
    expect(spec.usermeta).toBeUndefined()
  })
  test('data, images and hyperlinks cannot request external URLs', async () => {
    const local = restrictChartLoader(loader())
    await expect(
      local.load('https://example.invalid/data.json'),
    ).rejects.toThrow('外部')
    await expect(
      local.sanitize('https://example.invalid/track.png', { context: 'image' }),
    ).rejects.toThrow('外部')
    await expect(
      local.sanitize('https://example.invalid/', { context: 'href' }),
    ).rejects.toThrow('外部')
  })
  test('an embed resolving after unmount is finalized once', () => {
    const resource = asyncResource()
    let count = 0
    resource.dispose()
    resource.accept(() => {
      count++
    })
    expect(count).toBe(1)
    resource.dispose()
    expect(count).toBe(1)
  })
  test('an embed resolving while mounted is finalized on cleanup', () => {
    const resource = asyncResource()
    let count = 0
    resource.accept(() => {
      count++
    })
    expect(count).toBe(0)
    resource.dispose()
    expect(count).toBe(1)
  })
  test('quick image events have a mounted viewer', async () => {
    expect(await source('quick/Quick.tsx')).toContain('<ImageViewer />')
  })
  test('new visual content gets fresh render state after an earlier error', async () => {
    const visual = await source('chat/Visual.tsx')
    expect(visual).toContain('<MermaidContent key={code} code={code} />')
    expect(visual).toContain('<VegaContent key={code} code={code} />')
  })
})

describe('editing messages', () => {
  const original = { role: 'user', content: '原文', createdAt: 10 }
  const edit = { sessionId: 'a', index: 0, original }
  const session = { id: 'a', messages: [original], running: false }
  test('an edit belongs to its original conversation and message', () => {
    expect(activeEdit(session, edit)).toBe(0)
    expect(activeEdit({ ...session, id: 'b' }, edit)).toBeUndefined()
    expect(activeEdit({ ...session, running: true }, edit)).toBeUndefined()
    expect(
      activeEdit(
        { ...session, messages: [{ ...original, content: '已修改' }] },
        edit,
      ),
    ).toBeUndefined()
  })
  test('a rejected resend keeps the edited text open', async () => {
    let closed = false
    await expect(
      submitEdit(
        async () => {
          throw '已有对话正在运行'
        },
        () => {
          closed = true
        },
      ),
    ).rejects.toBe('已有对话正在运行')
    expect(closed).toBe(false)
    await submitEdit(
      async () => {},
      () => {
        closed = true
      },
    )
    expect(closed).toBe(true)
  })
})

describe('rendered reply contracts', () => {
  test('new and legacy tool rows stay escaped and closed in all three views', async () => {
    const { createElement } = await import('react')
    const { renderToStaticMarkup } = await import('react-dom/server')
    const { Reply } = await import('../../src/renderer/chat/Chat')
    const tools = Array.from({ length: 4 }, (_, index) => ({
      id: String(index),
      name: '读取文件',
      turn: 1,
      done: true,
      ...(index % 2 ? { tool: 'read_file' } : {}),
      detail: '<script>alert(1)</script>',
      output: '<img src=x onerror=alert(1)>',
    }))
    const message = { role: 'assistant' as const, content: '', createdAt: 1 }
    const render = (view: 'brief' | 'full' | 'hidden') =>
      renderToStaticMarkup(createElement(Reply, { message, tools, view }))
    const full = render('full')
    expect(full.match(/<details/g)).toHaveLength(4)
    expect(full).toContain('&lt;script&gt;alert(1)&lt;/script&gt;')
    expect(full).toContain('&lt;img src=x onerror=alert(1)&gt;')
    expect(full).not.toContain('<script>')
    expect(full).not.toMatch(/<details[^>]*\bopen\b/)
    expect(render('brief')).toContain('tool-group')
    expect(render('hidden')).toBe('')
  })
  test('model HTML and webpage titles render as text, not executable HTML', async () => {
    const { createElement } = await import('react')
    const { renderToStaticMarkup } = await import('react-dom/server')
    const { Markdown } = await import('../../src/renderer/chat/Markdown')
    const { SourceCards } = await import('../../src/renderer/chat/Visual')
    const html = renderToStaticMarkup(
      createElement(Markdown, {
        content:
          '正常正文\n\n<script>alert(1)</script>\n\n[恶意链接](javascript:alert%281%29)',
      }),
    )
    expect(html).toContain('正常正文')
    expect(html).not.toContain('<script>')
    expect(html).not.toContain('href="javascript:')
    const cards = renderToStaticMarkup(
      createElement(SourceCards, {
        sources: [
          { url: 'https://example.invalid/', title: '<img onerror=alert(1)>' },
        ],
      }),
    )
    expect(cards).toContain('&lt;img onerror=alert(1)&gt;')
    expect(cards).not.toContain('<img onerror=')
  })
  test('inline Vega-Lite data still produces a nonempty chart with the restricted loader', async () => {
    const { compile } = await import('vega-lite')
    const { parse, View } = await import('vega')
    const { expressionInterpreter } = await import('vega-interpreter')
    const spec = chartSpec(
      JSON.stringify({
        mark: 'bar',
        width: 200,
        height: 100,
        data: {
          values: [
            { category: 'A', amount: 2 },
            { category: 'B', amount: 3 },
          ],
        },
        encoding: {
          x: { field: 'category', type: 'nominal' },
          y: { field: 'amount', type: 'quantitative' },
        },
      }),
    )
    const view = new View(
      parse(compile(spec as never).spec, {}, { ast: true }),
      {
        renderer: 'none',
        loader: restrictChartLoader(loader()),
        expr: expressionInterpreter,
      },
    )
    try {
      const svg = await view.toSVG()
      expect(svg).toContain('<svg')
      expect(svg).toContain('mark-rect')
      expect(svg).toContain('category: A')
    } finally {
      view.finalize()
    }
  })
})

describe('draft and refresh edge cases', () => {
  test('restored attachments over the limit are kept until the user removes some', async () => {
    const draft = createDraftStore()
    const files = Array.from({ length: 11 }, (_, i) => file(`${i}.png`))
    draft.set({ input: '保留', files })
    let runs = 0
    await expect(
      sendDraft(draft, async () => {
        runs++
      }),
    ).rejects.toThrow('最多 10 个')
    expect(runs).toBe(0)
    expect(draft.get().files).toEqual(files)
    expect(draft.get().input).toBe('保留')
  })
  test('remounting during an upload does not allow a second send', async () => {
    const draft = createDraftStore()
    const encoded = deferred<string>()
    let runs = 0
    draft.set({ input: 'first', files: [file('a.png')] })
    const stop = draft.subscribe(() => {})
    const sending = sendDraft(
      draft,
      async () => {
        runs++
      },
      () => encoded.promise,
      () => {},
    )
    stop()
    draft.set({ input: 'next', files: [] })
    await sendDraft(draft, async () => {
      runs++
    })
    encoded.resolve('encoded')
    await sending
    expect(runs).toBe(1)
    expect(draft.get().input).toBe('next')
  })
  test('focus refreshes cannot overwrite a newer response or restart event', async () => {
    const reads = [deferred<string>(), deferred<string>(), deferred<string>()]
    let requested = 0
    let broadcast!: (state: string) => void
    const seen: string[] = []
    const stop = observeSnapshot(
      () => reads[requested++]!.promise,
      (cb) => {
        broadcast = cb
        return () => {}
      },
      (state) => seen.push(state),
    )
    stop.refresh()
    reads[1]!.resolve('new snapshot')
    await tick()
    reads[0]!.resolve('old snapshot')
    await tick()
    stop.refresh()
    broadcast('restart')
    reads[2]!.resolve('old process')
    await tick()
    expect(seen).toEqual(['new snapshot', 'restart'])
    stop()
    stop.refresh()
    expect(requested).toBe(3)
  })
})
