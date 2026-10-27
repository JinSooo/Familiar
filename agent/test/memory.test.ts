import { describe, expect, test } from 'bun:test'
import { mkdtempSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  MemoryIndex,
  MemoryStore,
  memoryContext,
  sensitiveReason,
} from '../src/memory'

const store = () =>
  new MemoryStore(mkdtempSync(join(tmpdir(), 'familiar-mem-')))

describe('sensitive filter', () => {
  test.each([
    '我的 key 是 sk-proj-abcdefghijklmnop1234',
    'GitHub 令牌 ghp_abcdefghijklmnopqrstuvwxyz12',
    '邮箱密码是 hunter2',
    'password: hunter2',
    '卡号 4111 1111 1111 1111',
    '身份证 11010519491231002X',
    'Authorization: Bearer abcdefghijklmnopqrstuv',
  ])('refuses %s', (text) => expect(sensitiveReason(text)).not.toBeNull())
  test.each([
    '早上喝美式，不加糖',
    '手机尾号不重要，订单号 20261027 也不是卡号',
    '在做 Familiar 项目，用 Tauri 2.12',
    '不喜欢别人问密码学的问题',
  ])('keeps %s', (text) => expect(sensitiveReason(text)).toBeNull())
})

describe('store', () => {
  test('writes readable Markdown and reads it back', async () => {
    const s = store()
    const a = await s.add({ category: 'profile', text: '早上喝美式\n不加糖' })
    await s.add({
      category: 'topic',
      topic: 'Familiar 项目',
      text: '用 Tauri 做壳',
    })
    const file = await readFile(join(s.dir, 'profile.md'), 'utf8')
    expect(file).toStartWith('# 画像\n')
    expect(file).toContain(`- 早上喝美式 不加糖 <!-- familiar {"id":"${a.id}"`)
    expect(await s.topics()).toEqual(['Familiar-项目'])
    expect((await s.list()).map((e) => e.text)).toEqual([
      '早上喝美式 不加糖',
      '用 Tauri 做壳',
    ])
  })

  test('replacing keeps the old memory, struck through', async () => {
    const s = store()
    const old = await s.add({ category: 'profile', text: '喝美式' })
    const next = await s.add({
      category: 'profile',
      text: '改喝拿铁',
      replaces: old.id,
    })
    const entries = await s.list()
    expect(entries.find((e) => e.id === old.id)).toMatchObject({
      status: 'superseded',
      by: next.id,
      text: '喝美式',
    })
    expect(await readFile(join(s.dir, 'profile.md'), 'utf8')).toContain(
      '- ~~喝美式~~',
    )
    expect(await memoryContext(s)).not.toContain('喝美式')
  })

  test('hand-written lines count, keep a stable id, and survive edits', async () => {
    const s = store()
    await mkdir(s.dir, { recursive: true })
    await writeFile(
      join(s.dir, 'habits.md'),
      '# 习惯\n\n我自己的备注\n\n- 周五下午复盘\n',
    )
    const [hand] = await s.list()
    expect(hand).toMatchObject({ text: '周五下午复盘', status: 'confirmed' })
    expect((await s.list())[0]!.id).toBe(hand!.id)
    await s.add({ category: 'habits', text: '晚上十一点前睡' })
    const file = await readFile(join(s.dir, 'habits.md'), 'utf8')
    expect(file).toContain('我自己的备注')
    expect(file.indexOf('周五下午复盘')).toBeLessThan(
      file.indexOf('晚上十一点前睡'),
    )
    await s.remove(hand!.id)
    expect((await s.list()).map((e) => e.text)).toEqual(['晚上十一点前睡'])
  })

  test('refuses sensitive text and bad topic names', async () => {
    const s = store()
    await expect(
      s.add({ category: 'profile', text: '密码是 123456' }),
    ).rejects.toThrow('不能写入记忆')
    await expect(
      s.add({ category: 'topic', topic: '../..', text: 'x' }),
    ).rejects.toThrow('主题名无效')
  })
})

describe('search index', () => {
  const setup = async () => {
    const s = store()
    const index = new MemoryIndex(
      s,
      join(s.dir, '..', `${Math.random()}.sqlite`),
    )
    await s.add({ category: 'habits', text: '用户早上喝美式咖啡，不加糖' })
    await s.add({
      category: 'topic',
      topic: 'Familiar',
      text: '壳用 Tauri 2.12，大脑是 Bun 进程',
    })
    await s.add({ category: 'profile', text: '住在杭州' })
    return { s, index }
  }

  test('finds Chinese by two- and three-character overlap, and English words', async () => {
    const { index } = await setup()
    expect((await index.search('我早上一般喝什么'))[0]?.text).toContain('美式')
    expect((await index.search('tauri'))[0]?.text).toContain('Tauri')
    expect((await index.search('杭'))[0]?.text).toBe('住在杭州')
    expect(await index.search('量子力学')).toEqual([])
  })

  test('follows file edits and hides superseded memories', async () => {
    const { s, index } = await setup()
    const [coffee] = await index.search('美式')
    await s.add({
      category: 'habits',
      text: '早上改喝拿铁',
      replaces: coffee!.id,
    })
    expect((await index.search('早上 喝')).map((h) => h.text)).toEqual([
      '早上改喝拿铁',
    ])
    await writeFile(
      join(s.dir, 'profile.md'),
      '# 画像\n\n- 养了一只叫小黑的猫\n',
    )
    expect((await index.search('小黑'))[0]?.text).toBe('养了一只叫小黑的猫')
    expect(await index.search('杭州')).toEqual([])
  })
})
