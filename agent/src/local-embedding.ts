import { execFile, spawn, type ChildProcess } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createReadStream, existsSync } from 'node:fs'
import {
  mkdir,
  open,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises'
import { createServer } from 'node:net'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { LocalModelStatus } from '../../src/shared'
import { systemFetch } from './agent/fetch'
import { dataDir } from './system'

/**
 * Embeddings on this Mac (settings › 模型 › 向量 › 本机): a GGUF model downloaded into
 * ~/.familiar/models and served by the llama-server sidecar (llama.cpp, Metal). Nothing leaves
 * the machine and no key is needed. The server starts on the first request and stops after
 * ten idle minutes, so it costs nothing while unused.
 */
export const localModel = {
  id: 'qwen3-embedding-0.6b-q8',
  name: 'Qwen3-Embedding-0.6B',
  file: 'Qwen3-Embedding-0.6B-Q8_0.gguf',
  /**
   * Same file in both places (checked by SHA-256). Hugging Face can crawl at ~10 KB/s from
   * where the author is while ModelScope (Alibaba, Qwen's own publisher) is fast, and
   * elsewhere it may be the other way round, so the download measures both first.
   */
  urls: [
    'https://modelscope.cn/models/Qwen/Qwen3-Embedding-0.6B-GGUF/resolve/master/Qwen3-Embedding-0.6B-Q8_0.gguf',
    'https://huggingface.co/Qwen/Qwen3-Embedding-0.6B-GGUF/resolve/main/Qwen3-Embedding-0.6B-Q8_0.gguf',
  ],
  size: 639150592,
  sha256: '06507c7b42688469c4e7298b0a1e16deff06caf291cf0a5b278c308249c3e439',
}
/** Qwen3-Embedding's retrieval instruction; documents are embedded as they are. */
const queryPrefix =
  'Instruct: Given a search query, retrieve relevant passages that answer the query\nQuery:'

const modelsDir = () => join(dataDir, 'models')
const modelPath = () => join(modelsDir(), localModel.file)
const partPath = () => `${modelPath()}.part`
const pidPath = () => join(modelsDir(), 'llama-server.pid')
const idleStop = 10 * 60_000

/** Release: beside the agent in Contents/MacOS. Development: built by `pnpm llama:build`. */
function serverPath(): string | null {
  const candidates = [
    join(dirname(process.execPath), 'llama-server'),
    fileURLToPath(
      new URL(
        '../../llama/.build/llama.cpp/build/bin/llama-server',
        import.meta.url,
      ),
    ),
  ]
  return candidates.find((p) => existsSync(p)) ?? null
}

const download: {
  controller?: AbortController
  received: number
  total: number
  error?: string
} = { received: 0, total: 0 }
let listener: ((status: LocalModelStatus) => void) | undefined
let ready = false

export function onLocalModelChanged(
  callback: (status: LocalModelStatus) => void,
): void {
  listener = callback
}
const notify = () => void localModelStatus().then((s) => listener?.(s))

/** Whether the model file is in place (checked once, then kept up to date by download/delete). */
export async function localModelReady(): Promise<boolean> {
  if (!ready)
    ready = await stat(modelPath()).then(
      (s) => s.isFile() && s.size === localModel.size,
      () => false,
    )
  return ready
}

export async function localModelStatus(): Promise<LocalModelStatus> {
  const base = {
    name: localModel.name,
    size: localModel.size,
    server: Boolean(serverPath()),
  }
  if (download.controller)
    return {
      ...base,
      state: 'downloading',
      received: download.received,
      total: download.total || localModel.size,
    }
  if (await localModelReady()) return { ...base, state: 'ready' }
  const part = await stat(partPath()).then(
    (s) => s.size,
    () => 0,
  )
  return {
    ...base,
    state: 'missing',
    ...(part ? { received: part, total: localModel.size } : {}),
    ...(download.error ? { error: download.error } : {}),
  }
}

/** Bytes per second each source gives for its first megabyte (0 when it failed), fastest first. */
async function rankSources(signal: AbortSignal): Promise<string[]> {
  const speed = await Promise.all(
    localModel.urls.map(async (url) => {
      const started = Date.now()
      try {
        const response = await systemFetch(url, {
          headers: { range: 'bytes=0-1048575' },
          signal: AbortSignal.any([signal, AbortSignal.timeout(10_000)]),
        })
        if (!response.ok) return 0
        const bytes = (await response.arrayBuffer()).byteLength
        return bytes / Math.max(1, Date.now() - started)
      } catch {
        return 0
      }
    }),
  )
  return localModel.urls
    .map((url, i) => ({ url, speed: speed[i]! }))
    .sort((a, b) => b.speed - a.speed)
    .map((s) => s.url)
}

/** One pass from where the partial file ends; gives up when no bytes come for 30 seconds. */
async function fetchRest(url: string, signal: AbortSignal): Promise<void> {
  let have = await stat(partPath()).then(
    (s) => s.size,
    () => 0,
  )
  if (have >= localModel.size) return
  const stall = new AbortController()
  let timer = setTimeout(() => stall.abort(), 30_000)
  try {
    const response = await systemFetch(url, {
      signal: AbortSignal.any([signal, stall.signal]),
      headers: have ? { range: `bytes=${have}-` } : {},
    })
    if (response.status === 200) have = 0
    else if (response.status !== 206)
      throw new Error(`下载失败（HTTP ${response.status}）`)
    download.received = have
    download.total = localModel.size
    const file = await open(partPath(), have ? 'a' : 'w')
    let last = 0
    try {
      const reader = response.body!.getReader()
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        clearTimeout(timer)
        timer = setTimeout(() => stall.abort(), 30_000)
        await file.write(value)
        download.received += value.byteLength
        if (Date.now() - last > 500) {
          last = Date.now()
          notify()
        }
      }
    } finally {
      await file.close()
    }
  } catch (error) {
    if (stall.signal.aborted && !signal.aborted)
      throw new Error('下载卡住了（30 秒没有数据）')
    throw error
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Downloads the model in the background from the faster source, resuming the partial file
 * after a dropped connection (switching source when one makes no headway), and checks its
 * SHA-256 before putting it in place. `done` runs after a successful download.
 */
export async function downloadLocalModel(done: () => void): Promise<void> {
  if (download.controller || (await localModelReady())) return
  const controller = new AbortController()
  const { signal } = controller
  download.controller = controller
  download.error = undefined
  notify()
  void (async () => {
    try {
      await mkdir(modelsDir(), { recursive: true })
      const sources = await rankSources(signal)
      let source = 0
      for (let attempt = 1; ; attempt++) {
        const before = download.received
        try {
          await fetchRest(sources[source]!, signal)
          break
        } catch (error) {
          if (signal.aborted || attempt >= 6) throw error
          console.error('Model download interrupted:', String(error))
          // Less than a megabyte since the last try: this source is not getting anywhere.
          if (download.received - before < 1024 * 1024)
            source = (source + 1) % sources.length
          await new Promise((r) => setTimeout(r, 2000 * attempt))
        }
      }
      if ((await sha256(partPath())) !== localModel.sha256) {
        await rm(partPath(), { force: true })
        throw new Error('下载的文件校验不通过，已删除，请重新下载')
      }
      await rename(partPath(), modelPath())
      ready = true
      download.controller = undefined
      notify()
      done()
    } catch (error) {
      download.controller = undefined
      if (!signal.aborted)
        download.error = error instanceof Error ? error.message : String(error)
      notify()
    }
  })()
}

export function cancelLocalModelDownload(): void {
  download.controller?.abort()
}

export async function deleteLocalModel(): Promise<void> {
  cancelLocalModelDownload()
  stopLocalServer()
  ready = false
  await rm(modelPath(), { force: true })
  await rm(partPath(), { force: true })
  notify()
}

function sha256(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256')
    createReadStream(path)
      .on('data', (chunk) => hash.update(chunk))
      .on('error', reject)
      .on('end', () => resolve(hash.digest('hex')))
  })
}

const server: {
  child?: ChildProcess
  port?: number
  starting?: Promise<number>
  timer?: ReturnType<typeof setTimeout>
  log: string
} = { log: '' }

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer()
    probe.once('error', reject)
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address()
      probe.close(() =>
        typeof address === 'object' && address
          ? resolve(address.port)
          : reject(new Error('no port')),
      )
    })
  })
}

/**
 * A server left by an agent that was killed outright (its children live on). The pid is only
 * signalled while it still names llama-server, since the system may have reused it.
 */
export async function stopLeftoverServer(): Promise<void> {
  const pid = Number(await readFile(pidPath(), 'utf8').catch(() => ''))
  if (pid > 0 && pid !== server.child?.pid) {
    const command = await new Promise<string>((resolve) =>
      execFile('/bin/ps', ['-p', String(pid), '-o', 'comm='], (_e, out) =>
        resolve(String(out ?? '').trim()),
      ),
    )
    if (basename(command) === 'llama-server')
      try {
        process.kill(pid, 'SIGTERM')
      } catch {
        /* Already gone. */
      }
  }
  await rm(pidPath(), { force: true })
}

async function start(): Promise<number> {
  const path = serverPath()
  if (!path)
    throw new Error(
      '找不到本机向量程序 llama-server（开发时先运行 pnpm llama:build）',
    )
  if (!(await localModelReady())) throw new Error('本机向量模型还没下载')
  await stopLeftoverServer()
  const port = await freePort()
  server.log = ''
  const child = spawn(
    path,
    [
      ['-m', modelPath()],
      ['--embedding'],
      ['--pooling', 'last'],
      ['--host', '127.0.0.1'],
      ['--port', String(port)],
      // Four requests at once, each up to 4096 tokens (a chunk is at most ~2000).
      ['-c', '16384'],
      ['-np', '4'],
      ['-b', '4096'],
      ['-ub', '4096'],
      ['--no-webui'],
    ].flat(),
    { stdio: ['ignore', 'ignore', 'pipe'] },
  )
  server.child = child
  await writeFile(pidPath(), String(child.pid ?? ''))
  child.stderr?.on('data', (data: Buffer) => {
    server.log = (server.log + data.toString()).slice(-4000)
  })
  child.once('exit', () => {
    if (server.child === child) {
      server.child = undefined
      server.port = undefined
      void rm(pidPath(), { force: true })
    }
  })
  const deadline = Date.now() + 60_000
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode)
      throw new Error(
        `本机向量程序启动失败：${server.log.trim().split('\n').at(-1) ?? ''}`,
      )
    try {
      const health = await fetch(`http://127.0.0.1:${port}/health`)
      if (health.ok) {
        server.port = port
        return port
      }
    } catch {
      /* Not listening yet. */
    }
    await new Promise((r) => setTimeout(r, 250))
  }
  child.kill('SIGTERM')
  throw new Error('本机向量程序启动超时')
}

async function serverPort(): Promise<number> {
  clearTimeout(server.timer)
  server.timer = setTimeout(stopLocalServer, idleStop)
  if (server.port && server.child) return server.port
  server.starting ??= start().finally(() => {
    server.starting = undefined
  })
  return server.starting
}

export function stopLocalServer(): void {
  clearTimeout(server.timer)
  if (!server.child) return
  server.child.kill('SIGTERM')
  server.child = undefined
  server.port = undefined
  void rm(pidPath(), { force: true })
}

/** OpenAI-style /v1/embeddings on the local server; vectors come back in input order. */
export async function embedLocally(
  texts: string[],
  kind: 'document' | 'query',
  signal?: AbortSignal,
): Promise<number[][]> {
  const port = await serverPort()
  const response = await fetch(`http://127.0.0.1:${port}/v1/embeddings`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: localModel.id,
      input: texts.map((t) => (kind === 'query' ? `${queryPrefix}${t}` : t)),
    }),
    signal: signal ?? AbortSignal.timeout(120_000),
  })
  if (!response.ok)
    throw new Error(
      `本机向量出错（${response.status}）：${(await response.text()).slice(0, 200)}`,
    )
  const body = (await response.json()) as {
    data: { index: number; embedding: number[] }[]
  }
  return body.data.sort((a, b) => a.index - b.index).map((d) => d.embedding)
}
