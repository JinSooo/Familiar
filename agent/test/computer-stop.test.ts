import { expect, test } from 'bun:test'
import { AsyncLocalStorage } from 'node:async_hooks'
import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { setTimeout as delay } from 'node:timers/promises'
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { tool } from 'ai'
import { z } from 'zod'
import { settingsSchema } from '../../src/shared'

// Load the real module with only its sensor path replaced; no global module mocks.
async function fixture() {
  let idle: (() => void) | undefined
  let launches = 0
  const idleToken = {} as ReturnType<typeof setTimeout>
  const dir = await mkdtemp(join(tmpdir(), 'familiar-control-stop-'))
  const helper = join(dir, 'helper')
  const log = join(dir, 'requests')
  await writeFile(
    helper,
    `#!${process.execPath}\nconst fs = require('node:fs');\nrequire('node:readline').createInterface({input:process.stdin}).on('line', line => {\nfs.appendFileSync(${JSON.stringify(log)}, line+'\\n');\nconst r = JSON.parse(line); if (!r.id) return;\nsetTimeout(() => console.log(JSON.stringify({id:r.id,ok:true,result:r.op==='apps'?[]:r.op==='screenshot'?{app:'编辑器',window:'',width:1,height:1,jpeg:'aGVsbG8=',texts:[]}:'ok'})), 120);\n});\n`,
    { mode: 0o700 },
  )
  const source = await readFile(
    new URL('../src/computer/index.ts', import.meta.url),
    'utf8',
  )
  const js = new Bun.Transpiler({ loader: 'ts' })
    .transformSync(source)
    .replace(/^import[\s\S]*?;$/gm, '')
    .replace(/export\s+/g, '')
  const api = new Function(
    'spawn',
    'createInterface',
    'tool',
    'z',
    'sensorPath',
    'AsyncLocalStorage',
    'delay',
    'setTimeout',
    'clearTimeout',
    `${js}\nreturn {control,stopComputer,createComputerTools,setComputerHooks,endComputerTurn,withLatestScreenshot,withLatestWindowTree: typeof withLatestWindowTree === 'function' ? withLatestWindowTree : undefined};`,
  )(
    (...args: Parameters<typeof spawn>) => {
      launches++
      return spawn(...args)
    },
    createInterface,
    tool,
    z,
    () => helper,
    AsyncLocalStorage,
    delay,
    (callback: () => void, ms: number) => {
      if (ms !== 5 * 60_000) return setTimeout(callback, ms)
      idle = callback
      return idleToken
    },
    (timer: ReturnType<typeof setTimeout>) => {
      if (timer === idleToken) idle = undefined
      else clearTimeout(timer)
    },
  ) as typeof import('../src/computer')
  return {
    api,
    idleArmed: () => idle !== undefined,
    expireIdle: () => idle?.(),
    launches: () => launches,
    requests: async () =>
      (await readFile(log, 'utf8').catch(() => ''))
        .trim()
        .split('\n')
        .filter(Boolean)
        .map((l) => JSON.parse(l)),
    close: async () => {
      api.stopComputer()
      await Bun.sleep(30)
      await rm(dir, { recursive: true, force: true })
    },
  }
}

test('abort clears queued requests, settles immediately, and refuses new work', async () => {
  const f = await fixture()
  try {
    const c = new AbortController()
    const first = f.api
      .control('read', {}, 1000, c.signal)
      .catch((e: Error) => e.message)
    const queued = f.api
      .control('click', {}, 1000, c.signal)
      .catch((e: Error) => e.message)
    await Bun.sleep(40)
    c.abort()
    expect(await first).toBe('已停止')
    expect(await queued).toBe('已停止')
    await expect(f.api.control('type', {}, 1000, c.signal)).rejects.toThrow(
      '已停止',
    )
    await Bun.sleep(30)
    const requests = await f.requests()
    expect(requests.some((r) => r.op === 'read')).toBe(true)
    expect(requests.some((r) => r.op === 'cancel')).toBe(true)
    expect(requests.some((r) => r.op === 'click' || r.op === 'type')).toBe(
      false,
    )
    expect(await f.api.control('apps')).toEqual([])
  } finally {
    await f.close()
  }
})

test('SDK cancellation during sprite loading cannot send a cursor or action afterwards', async () => {
  const f = await fixture()
  let ready!: (value: undefined) => void
  const sheet = new Promise<undefined>((r) => {
    ready = r
  })
  f.api.setComputerHooks({
    petVisible: () => {},
    stop: () => {},
    sheet: () => sheet,
    rate: () => 1,
  })
  try {
    const c = new AbortController()
    const tools = f.api.createComputerTools(settingsSchema.parse({}))
    const result = tools.click!.execute!(
      { element: 1 },
      { messages: [], toolCallId: 'a', abortSignal: c.signal },
    )
    await Bun.sleep(10)
    c.abort()
    ready(undefined)
    expect(await result).toBe('已停止')
    expect(await f.requests()).toEqual([])
  } finally {
    ready(undefined)
    await f.api.endComputerTurn()
    await f.close()
  }
})

test('window pruning keeps the latest Chat Completions screenshot injected once', async () => {
  const f = await fixture()
  try {
    const tools = f.api.createComputerTools(settingsSchema.parse({}))
    await tools.screenshot!.execute!({}, { messages: [], toolCallId: 'shot' })
    const messages: import('ai').ModelMessage[] = [
      {
        role: 'tool',
        content: [
          {
            type: 'tool-result',
            toolCallId: 'old',
            toolName: 'read_window',
            output: {
              type: 'text',
              value: '「编辑器」：\n[1] AXTextArea：旧树',
            },
          },
          {
            type: 'tool-result',
            toolCallId: 'new',
            toolName: 'read_window',
            output: {
              type: 'text',
              value: '「编辑器」：\n[2] AXTextArea：新树',
            },
          },
          {
            type: 'tool-result',
            toolCallId: 'shot',
            toolName: 'screenshot',
            output: { type: 'text', value: '截图' },
          },
        ],
      },
    ]
    const injected = f.api.withLatestScreenshot(messages)!
    const result = f.api.withLatestScreenshot(
      f.api.withLatestWindowTree(injected),
    )!
    expect(result.filter((m) => m.role === 'user')).toHaveLength(1)
    expect(JSON.stringify(result)).toContain('aGVsbG8=')
    expect(JSON.stringify(result)).toContain('新树')
    expect(JSON.stringify(result)).not.toContain('旧树')
    expect(JSON.stringify(injected)).toContain('旧树')
  } finally {
    await f.api.endComputerTurn()
    await f.close()
  }
})

test('helper idle timeout starts after the last native reply, never during an action', async () => {
  const f = await fixture()
  try {
    const action = f.api.control('read').catch(() => undefined)
    expect(f.idleArmed()).toBe(false)
    await action
    expect(f.idleArmed()).toBe(true)
    const next = f.api.control('apps').catch(() => undefined)
    expect(f.idleArmed()).toBe(false)
    await next
    expect(f.idleArmed()).toBe(true)
  } finally {
    await f.close()
  }
})

test('a cancelled request is not idle until its native cleanup replies', async () => {
  const f = await fixture()
  try {
    const c = new AbortController()
    const action = f.api
      .control('read', {}, 1000, c.signal)
      .catch((e: Error) => e.message)
    await Bun.sleep(30)
    c.abort()
    expect(await action).toBe('已停止')
    expect(f.idleArmed()).toBe(false)
    await Bun.sleep(180)
    expect(f.idleArmed()).toBe(true)
  } finally {
    await f.close()
  }
})

test('a new request after idle shutdown gets a fresh helper immediately', async () => {
  const f = await fixture()
  try {
    await f.api.control('apps')
    f.expireIdle()
    const next = f.api.control('apps').catch((e: Error) => e.message)
    expect(f.launches()).toBe(2)
    expect(await next).toEqual([])
  } finally {
    await f.close()
  }
})
