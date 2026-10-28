import { describe, expect, test } from 'bun:test'
import type { Session } from '../../src/shared'
import { parse, serialize } from '../src/conversations'
import { emptySession, reduceSession } from '../src/session'
import { sourcesOf } from '../src/web'
import {
  assertPublic,
  decodeEntities,
  fetchPage,
  parseHtml,
  privateAddress,
} from '../src/web/page'

describe('address check', () => {
  test.each([
    '127.0.0.1',
    '10.1.2.3',
    '172.20.0.1',
    '192.168.1.8',
    '169.254.169.254',
    '::1',
    'fd00::1',
    '::ffff:127.0.0.1',
    '100.100.1.1',
  ])('private %s', (ip) => expect(privateAddress(ip)).toBe(true))
  test.each(['8.8.8.8', '172.32.0.1', '2606:4700::1111'])('public %s', (ip) =>
    expect(privateAddress(ip)).toBe(false),
  )
  test('refuses local hosts and other schemes', async () => {
    await expect(assertPublic('http://localhost:5173')).rejects.toThrow('本机')
    await expect(assertPublic('http://127.0.0.1/x')).rejects.toThrow('本机')
    await expect(assertPublic('http://[::1]/')).rejects.toThrow('本机')
    await expect(assertPublic('file:///etc/passwd')).rejects.toThrow('http')
  })
  test('a redirect into the LAN is refused', async () => {
    const fake = (async () =>
      new Response(null, {
        status: 302,
        headers: { location: 'http://192.168.1.1/admin' },
      })) as unknown as typeof fetch
    await expect(fetchPage('https://93.184.215.14/', fake)).rejects.toThrow(
      '本机',
    )
  })
})

describe('page parsing', () => {
  const html = `<html><head><title>Old &amp; title</title>
<meta property="og:title" content="Genie 4 发布">
<meta name="description" content="DeepMind 新模型">
<meta property="og:image" content="/img/cover.jpg"></head>
<body><nav>菜单 首页 关于</nav>
<article><h1>Genie 4</h1><p>它能生成带声音的世界。&#x4E00;段文字</p>
<img src="https://cdn.example.com/a.png" alt="演示图" width="800">
<img src="/logo.png"><img src="/tiny.jpg" width="40">
<script>alert(1)</script>${'<p>正文。</p>'.repeat(80)}</article></body></html>`
  const page = parseHtml(html, new URL('https://news.example.com/genie'))
  test('title, description and cleaned text', () => {
    expect(page.title).toBe('Genie 4 发布')
    expect(page.description).toBe('DeepMind 新模型')
    expect(page.text).toContain('它能生成带声音的世界。一段文字')
    expect(page.text).not.toContain('菜单')
    expect(page.text).not.toContain('alert')
  })
  test('main images only, absolute', () => {
    expect(page.images.map((i) => i.url)).toEqual([
      'https://news.example.com/img/cover.jpg',
      'https://cdn.example.com/a.png',
    ])
  })
  test('entities', () =>
    expect(decodeEntities('&lt;a&gt; &#20013; &nbsp;x &bogus;')).toBe(
      '<a> 中  x &bogus;',
    ))
})

describe('sources', () => {
  test('from tool results', () => {
    expect(
      sourcesOf('web_search', {
        answer: '',
        sources: [{ url: 'https://a.com', title: 'A' }],
      }),
    ).toEqual([{ url: 'https://a.com', title: 'A' }])
    expect(
      sourcesOf('fetch_page', {
        url: 'https://www.b.com/x',
        title: '',
        images: [{ url: 'https://b.com/i.jpg' }],
      }),
    ).toEqual([
      {
        url: 'https://www.b.com/x',
        title: 'b.com',
        image: 'https://b.com/i.jpg',
      },
    ])
    expect(sourcesOf('fetch_page', { error: '网页返回 404' })).toEqual([])
  })

  test('merge into the reply and survive a save', () => {
    let s: Session = {
      ...emptySession(),
      id: 'c',
      messages: [
        { role: 'user', content: '查一下', createdAt: 1 },
        { role: 'assistant', content: '', createdAt: 2 },
      ],
    }
    const a = { url: 'https://a.com', title: 'A' }
    s = reduceSession(s, { type: 'sources', sources: [a] })
    s = reduceSession(s, {
      type: 'sources',
      sources: [a, { url: 'https://b.com', title: 'B' }],
    })
    expect(s.messages[1]!.sources?.map((x) => x.url)).toEqual([
      'https://a.com',
      'https://b.com',
    ])
    const text = serialize(
      {
        id: 'c',
        title: 't',
        createdAt: 1,
        updatedAt: 2,
        messages: s.messages,
        tools: [],
      },
      '小黑',
    )
    expect(parse('c', text).messages[1]!.sources).toEqual(
      s.messages[1]!.sources,
    )
  })
})

describe('source titles', () => {
  test('untitled links read from their path; bare home pages give way', async () => {
    const { titleFromUrl, tidySources } = await import('../src/web')
    expect(
      titleFromUrl(
        'https://deepmind.google/discover/blog/genie-4-world-model/',
      ),
    ).toBe('genie 4 world model · deepmind.google')
    expect(titleFromUrl('https://www.example.com/')).toBe('example.com')
    expect(titleFromUrl('https://news.site/a/12345')).toBe('news.site')
    expect(
      tidySources([
        { url: 'https://deepmind.google/', title: 'x' },
        { url: 'https://deepmind.google/blog/genie', title: 'Genie' },
        { url: 'https://deepmind.google/blog/genie', title: 'dup' },
        { url: 'https://other.com/', title: 'Other' },
      ]).map((s) => s.title),
    ).toEqual(['Genie', 'Other'])
  })
})
