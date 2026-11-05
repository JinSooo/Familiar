import { describe, expect, test } from 'bun:test'
import { mkdtempSync } from 'node:fs'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { normalize, type Embedder } from '../src/embedding'
import { chunk, KnowledgeIndex } from '../src/knowledge'
import { extract } from '../src/knowledge/files'
import { sensorPath } from '../src/system'
import { MemoryIndex, MemoryStore } from '../src/memory'

const temp = (prefix: string) => mkdtempSync(join(tmpdir(), prefix))

/** Words in one group mean the same thing; a text's vector counts the groups it mentions. */
const groups = [
  ['咖啡', '美式', '拿铁'],
  ['部署', '上线', '发布'],
  ['猫', '橘猫'],
]
function fakeEmbedder(calls: string[][] = []): Embedder {
  const embed = async (texts: string[]) => {
    calls.push(texts)
    return texts.map((t) =>
      normalize([
        ...groups.map((g) => g.filter((w) => t.includes(w)).length),
        0.05,
      ]),
    )
  }
  return {
    key: 'fake',
    embed,
    query: async (text) => (await embed([text]))[0]!,
  }
}

describe('chunk', () => {
  test('Markdown chunks keep their heading path and lines; fenced # is not a heading', () => {
    const text = [
      '# 项目',
      '简介。',
      '',
      '## 安装',
      '```sh',
      '# 这是注释',
      'pnpm i',
      '```',
      '### 依赖',
      'Bun 1.4',
    ].join('\n')
    const chunks = chunk([text], 'text')
    expect(chunks.map((c) => [c.heading, c.start, c.end])).toEqual([
      ['项目', 1, 3],
      ['项目 › 安装', 4, 8],
      ['项目 › 安装 › 依赖', 9, 10],
    ])
    expect(chunks[1]!.text).toContain('# 这是注释')
    // A title right before the first section is not a chunk of its own.
    const titled = chunk(['# 咖啡笔记\n\n## 器具\nV60'], 'text')
    expect(titled.map((c) => [c.heading, c.start])).toEqual([
      ['咖啡笔记 › 器具', 1],
    ])
  })

  test('long text splits near 800 characters; PDF chunks name their page', () => {
    const para = '这是一句话。'.repeat(100)
    const chunks = chunk([`${para}\n\n${para}\n\n${para}`], 'text')
    expect(chunks.length).toBeGreaterThan(1)
    for (const c of chunks) expect(c.text.length).toBeLessThan(1700)
    const pages = chunk(['第一页内容', '', '第三页内容'], 'pdf')
    expect(pages.map((c) => c.start)).toEqual([1, 3])
  })
})

const fixture = (name: string) => join(import.meta.dir, 'fixtures', name)

describe('pdf', () => {
  // 2026-11-05: three résumés exported as page pictures were listed as unreadable.
  test.skipIf(!sensorPath())(
    'a page that is only a picture is recognized; a picture on a text page adds its words',
    async () => {
      const [scan] = await extract(fixture('image-only.pdf'), 'pdf')
      expect(scan).toContain('先切流量')
      const [mixed] = await extract(fixture('text-and-image.pdf'), 'pdf')
      expect(mixed).toContain('发布窗口是周一到周四')
      expect(mixed).toContain('【图中文字】')
      expect(mixed!.split('【图中文字】')[1]).toContain('再回退镜像')
      // The text layer is not repeated as picture text.
      expect(mixed!.split('【图中文字】')[1]).not.toContain('发布窗口')

      // Indexed pages are kept, so read_knowledge does not run OCR again.
      const index = new KnowledgeIndex(join(temp('familiar-kbdb-'), 'i.sqlite'))
      const dir = temp('familiar-kbpdf-')
      await writeFile(
        join(dir, 'scan.pdf'),
        await readFile(fixture('image-only.pdf')),
      )
      await index.sync([dir])
      expect((await index.search('回退镜像')).length).toBe(1)
      expect(index.pages(join(dir, 'scan.pdf'))?.[0]).toContain('先切流量')
      index.close()
    },
    60_000,
  )

  // Printed by macOS, the text comes out with Kangxi radicals (⼝ U+2F1D, ⼀ U+2F00).
  test('radical look-alikes become the characters people type', async () => {
    const [page] = await extract(fixture('kangxi-radicals.pdf'), 'pdf')
    expect(page).toContain('发布窗口是周一到周四')
    expect(page).toContain('，')
  })
})

describe('knowledge index', () => {
  test('follows the folder: new, changed, deleted files and removed folders', async () => {
    const root = temp('familiar-kb-')
    const other = temp('familiar-kb2-')
    const index = new KnowledgeIndex(join(temp('familiar-kbdb-'), 'i.sqlite'))
    await mkdir(join(root, 'notes'))
    await mkdir(join(root, 'node_modules'))
    await writeFile(
      join(root, 'notes', 'tauri.md'),
      '# 窗口\n点击穿透靠轮询鼠标坐标。',
    )
    await writeFile(join(root, 'node_modules', 'x.md'), '点击穿透')
    await writeFile(join(root, '.hidden.md'), '点击穿透')
    await writeFile(join(other, 'a.txt'), '橘猫叫小黑')
    expect(await index.sync([root, other])).toBe(true)
    expect(await index.sync([root, other])).toBe(false)

    const hits = await index.search('点击穿透')
    expect(hits.map((h) => h.path)).toEqual([join(root, 'notes', 'tauri.md')])
    expect(hits[0]).toMatchObject({ title: '窗口', heading: '窗口', start: 1 })
    // Two-character words go through LIKE.
    expect((await index.search('橘猫')).length).toBe(1)

    await writeFile(join(root, 'notes', 'tauri.md'), '# 窗口\n改用事件监听。')
    await index.sync([root, other])
    expect(await index.search('点击穿透')).toEqual([])
    expect((await index.search('事件监听')).length).toBe(1)

    await rm(join(root, 'notes', 'tauri.md'))
    await index.sync([root])
    expect(await index.search('事件监听')).toEqual([])
    expect(await index.search('橘猫')).toEqual([])
    index.close()
  })

  test('vectors find matches by meaning, are cached, and skip sensitive text', async () => {
    const root = temp('familiar-kbv-')
    const index = new KnowledgeIndex(join(temp('familiar-kbdb-'), 'i.sqlite'))
    await writeFile(join(root, 'ops.md'), '# 流程\n周五不发布新版本。')
    await writeFile(join(root, 'drink.md'), '早上一杯美式。')
    await writeFile(
      join(root, 'secret.md'),
      '服务器 password: hunter2，发布前要换。',
    )
    await index.sync([root])
    const calls: string[][] = []
    const embedder = fakeEmbedder(calls)
    expect(await index.embed(embedder)).toBe(2)
    expect(calls.flat().some((t) => t.includes('hunter2'))).toBe(false)
    // Nothing new to embed the second time.
    expect(await index.embed(embedder)).toBe(0)

    // No shared characters with "发布", found through the vector only.
    const hits = await index.search('上线', { embedder })
    expect(hits[0]?.path).toBe(join(root, 'ops.md'))
    expect(hits.some((h) => h.path.endsWith('drink.md'))).toBe(false)
    // Without an embedder the same query finds nothing.
    expect(await index.search('上线')).toEqual([])
    // A failing embedder falls back to full text.
    const broken: Embedder = {
      key: 'fake',
      embed: () => Promise.reject(new Error('down')),
      query: () => Promise.reject(new Error('down')),
    }
    expect((await index.search('美式', { embedder: broken })).length).toBe(1)
    index.close()
  })
})

describe('memory vectors', () => {
  test('recall finds a memory by meaning when an embedder is set', async () => {
    const store = new MemoryStore(temp('familiar-memv-'))
    await store.add({ category: 'profile', text: '早上喝美式，不加糖' })
    await store.add({ category: 'profile', text: '养了一只橘猫' })
    const index = new MemoryIndex(
      store,
      join(temp('familiar-memdb-'), 'i.sqlite'),
    )
    expect(await index.search('咖啡')).toEqual([])
    const hits = await index.search('咖啡', 8, fakeEmbedder())
    expect(hits.map((h) => h.text)).toEqual(['早上喝美式，不加糖'])
    index.close()
  })
})
