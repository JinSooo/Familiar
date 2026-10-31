import {
  createHash,
  createPublicKey,
  randomBytes,
  randomUUID,
  verify,
  type JsonWebKeyInput,
} from 'node:crypto'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { dataDir, readKey, writeKey } from '../system'
import { systemFetch } from './fetch'

/**
 * Sign in with ChatGPT for a local app (docs: developers.openai.com/siwc, open-source flow):
 * OAuth with PKCE in the system browser, a loopback callback, a dynamically registered client.
 * Only the refresh token goes to the Keychain (long values do not fit there); the access token
 * lives in memory; the rest is a 0600 JSON file.
 */
const issuer = 'https://auth.openai.com'
export const chatGptResource = 'https://api.openai.com/v1'
const planScope = 'chatgpt.tokens.use.direct'
const scope = `openid profile email offline_access resource.invoke ${planScope}`
const refreshAccount = 'chatgpt-refresh-token'
/** The Keychain command line takes about 3000 characters reliably, not 6000. */
const keychainLimit = 3500

export interface ChatGptProfile {
  email: string
  subject: string
  /** The client id OpenAI issued at registration; reused for every later sign-in. */
  clientId: string
  scopes: string[]
}
export interface ChatGptStatus {
  signedIn: boolean
  email?: string
  /** Whether the user granted use of the ChatGPT plan, not just identity. */
  planUsage?: boolean
}

const profileFile = () => join(dataDir, 'chatgpt-auth.json')
const hostFile = () => join(dataDir, 'chatgpt-host.json')

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(dataDir, { recursive: true })
  await writeFile(`${path}.tmp`, JSON.stringify(value, null, 2), {
    mode: 0o600,
  })
  await rename(`${path}.tmp`, path)
}
async function readJson<T>(path: string): Promise<T | undefined> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as T
  } catch {
    return undefined
  }
}
const text = (value: unknown) => (typeof value === 'string' ? value : '')

/** One opaque id for this installation, chosen before the first sign-in and never changed. */
async function hostId(): Promise<string> {
  const saved = await readJson<{ id?: string }>(hostFile())
  if (saved?.id) return saved.id
  const id = `urn:uuid:${randomUUID()}`
  await writeJson(hostFile(), { id })
  return id
}

interface Tokens {
  access: string
  refresh: string
  idToken: string
  expiresIn: number
  scopes: string[]
}

async function tokenRequest(params: Record<string, string>): Promise<Tokens> {
  const response = await systemFetch(`${issuer}/api/accounts/oauth/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(params).toString(),
    signal: AbortSignal.timeout(30_000),
  })
  const raw = await response.text()
  let body: Record<string, unknown> = {}
  try {
    body = JSON.parse(raw) as Record<string, unknown>
  } catch {
    /* Not JSON: the status line below says what happened. */
  }
  if (!response.ok)
    throw Object.assign(
      new Error(text(body.error_description) || `HTTP ${response.status}`),
      { code: text(body.error) },
    )
  return {
    access: text(body.access_token),
    refresh: text(body.refresh_token),
    idToken: text(body.id_token),
    expiresIn: typeof body.expires_in === 'number' ? body.expires_in : 3600,
    scopes: text(body.scope).split(' ').filter(Boolean),
  }
}

/** Checks signature, issuer, audience, expiry and nonce of an ID token; returns its claims. */
async function verifyIdToken(
  idToken: string,
  clientId: string,
  nonce: string,
): Promise<{ sub: string; email: string }> {
  const [head, body, signature] = idToken.split('.')
  if (!head || !body || !signature) throw new Error('ID token 格式不对')
  const header = JSON.parse(Buffer.from(head, 'base64url').toString()) as {
    alg?: string
    kid?: string
  }
  const claims = JSON.parse(Buffer.from(body, 'base64url').toString()) as {
    iss?: string
    aud?: string | string[]
    exp?: number
    nonce?: string
    sub?: string
    email?: string
  }
  if (header.alg !== 'RS256') throw new Error('ID token 的签名算法不受支持')
  const response = await systemFetch(`${issuer}/.well-known/jwks.json`, {
    signal: AbortSignal.timeout(20_000),
  })
  const jwks = (await response.json()) as {
    keys?: (JsonWebKeyInput['key'] & { kid?: string })[]
  }
  const jwk = jwks.keys?.find((k) => k.kid === header.kid)
  if (!jwk) throw new Error('找不到验证 ID token 的公钥')
  const key = createPublicKey({ key: jwk, format: 'jwk' })
  if (
    !verify(
      'RSA-SHA256',
      Buffer.from(`${head}.${body}`),
      key,
      Buffer.from(signature, 'base64url'),
    )
  )
    throw new Error('ID token 签名校验失败')
  const audience = [claims.aud ?? []].flat()
  if (claims.iss !== issuer) throw new Error('ID token 的签发方不对')
  if (!audience.includes(clientId)) throw new Error('ID token 不是给本应用的')
  if (typeof claims.exp !== 'number' || claims.exp * 1000 < Date.now())
    throw new Error('ID token 已过期')
  if (claims.nonce !== nonce) throw new Error('ID token 的 nonce 不匹配')
  if (!claims.sub) throw new Error('ID token 没有账号标识')
  return { sub: claims.sub, email: claims.email ?? '' }
}

let cached: { token: string; expiresAt: number } | undefined
let cancel: (() => void) | undefined

async function keepRefreshToken(token: string): Promise<void> {
  if (token.length > keychainLimit) throw new Error('令牌太长，存不进钥匙串')
  await writeKey(token, refreshAccount)
}

/** The loopback listener; the registration wants port 1455, any free port is the fallback. */
function listen(): Promise<{ server: Server; port: number }> {
  const attempt = (port: number) =>
    new Promise<{ server: Server; port: number }>((resolve, reject) => {
      const server = createServer()
      server.once('error', reject)
      server.listen(port, '127.0.0.1', () => {
        server.removeListener('error', reject)
        resolve({ server, port: (server.address() as AddressInfo).port })
      })
    })
  return attempt(1455).catch(() => attempt(0))
}

export function cancelSignIn(): void {
  cancel?.()
}

/** Opens the browser for sign-in and waits for the user to finish there. */
export async function signIn(
  openBrowser: (url: string) => Promise<void>,
): Promise<ChatGptStatus> {
  cancelSignIn()
  const profile = await readJson<ChatGptProfile>(profileFile())
  const host = await hostId()
  const verifier = randomBytes(32).toString('base64url')
  const challenge = createHash('sha256').update(verifier).digest('base64url')
  const state = randomBytes(16).toString('base64url')
  const nonce = randomBytes(16).toString('base64url')
  const { server, port } = await listen()
  const redirect = `http://127.0.0.1:${port}/auth/callback`
  let timer: ReturnType<typeof setTimeout> | undefined
  const callback = new Promise<URLSearchParams>((resolve, reject) => {
    timer = setTimeout(() => reject(new Error('登录超时，请重试')), 300_000)
    cancel = () => reject(new Error('登录已取消'))
    server.on('request', (req, res) => {
      const url = new URL(req.url ?? '/', redirect)
      if (url.pathname !== '/auth/callback') {
        res.writeHead(404, { connection: 'close' }).end()
        return
      }
      res.writeHead(200, {
        'content-type': 'text/html; charset=utf-8',
        connection: 'close',
      })
      res.end(
        '<!doctype html><meta charset=utf-8><title>Familiar</title><style>body{font:16px system-ui;margin:4em;text-align:center}</style><p>登录完成，可以回到 Familiar 了。</p>',
      )
      resolve(url.searchParams)
    })
  })
  // A failure before anyone awaits it (the browser would not open) must not go unhandled.
  callback.catch(() => undefined)
  try {
    const url = new URL(`${issuer}/api/accounts/authorize`)
    const query: Record<string, string> = {
      client_id: profile?.clientId ?? 'dynamic_agent_client',
      ...(profile ? {} : { agent_name_hint: 'Familiar' }),
      ext_agent_host_id: host,
      ...(profile?.email ? { login_hint: profile.email } : {}),
      response_type: 'code',
      redirect_uri: redirect,
      scope,
      resource: chatGptResource,
      state,
      nonce,
      code_challenge_method: 'S256',
      code_challenge: challenge,
    }
    for (const [name, value] of Object.entries(query))
      url.searchParams.set(name, value)
    await openBrowser(url.toString())
    const params = await callback
    if (params.get('state') !== state)
      throw new Error('登录回调的 state 不匹配')
    const error = params.get('error')
    if (error)
      throw new Error(
        error === 'access_denied'
          ? '你在浏览器里拒绝了授权'
          : `登录失败：${error}`,
      )
    const code = params.get('code')
    if (!code) throw new Error('登录回调里没有授权码')
    const issued = params.get('client_id')
    if (profile && issued && issued !== profile.clientId)
      throw new Error('登录回调的 client_id 和已注册的不一致')
    const clientId = profile?.clientId ?? issued
    if (!clientId) throw new Error('注册没有完成：回调里没有 client_id')
    const tokens = await tokenRequest({
      grant_type: 'authorization_code',
      client_id: clientId,
      code,
      code_verifier: verifier,
      redirect_uri: redirect,
      resource: chatGptResource,
    })
    if (!tokens.access || !tokens.refresh || !tokens.idToken)
      throw new Error('令牌响应不完整')
    const claims = await verifyIdToken(tokens.idToken, clientId, nonce)
    await keepRefreshToken(tokens.refresh)
    await writeJson(profileFile(), {
      email: claims.email,
      subject: claims.sub,
      clientId,
      scopes: tokens.scopes,
    } satisfies ChatGptProfile)
    cached = {
      token: tokens.access,
      expiresAt: Date.now() + tokens.expiresIn * 1000,
    }
    return {
      signedIn: true,
      email: claims.email,
      planUsage: tokens.scopes.includes(planScope),
    }
  } finally {
    clearTimeout(timer)
    cancel = undefined
    server.close()
    server.closeAllConnections()
  }
}

let refreshing: Promise<string> | undefined

/** A valid access token, refreshed when it is about to expire; refreshes never overlap. */
export function chatGptAccessToken(): Promise<string> {
  if (cached && cached.expiresAt - 60_000 > Date.now())
    return Promise.resolve(cached.token)
  refreshing ??= refresh().finally(() => {
    refreshing = undefined
  })
  return refreshing
}

async function refresh(): Promise<string> {
  const profile = await readJson<ChatGptProfile>(profileFile())
  const saved = await readKey(refreshAccount)
  if (!profile || !saved) throw new Error('请先在设置里用 ChatGPT 登录')
  let tokens: Tokens
  try {
    tokens = await tokenRequest({
      grant_type: 'refresh_token',
      client_id: profile.clientId,
      refresh_token: saved,
      resource: chatGptResource,
    })
  } catch (error) {
    if ((error as { code?: string }).code === 'invalid_grant') {
      cached = undefined
      await writeKey('', refreshAccount)
      throw new Error('ChatGPT 登录已失效，请在设置里重新登录')
    }
    throw error
  }
  if (!tokens.access) throw new Error('令牌响应不完整')
  // The refresh token rotates: the old one is dead once the new one is issued.
  if (tokens.refresh) await keepRefreshToken(tokens.refresh)
  if (tokens.scopes.length)
    await writeJson(profileFile(), { ...profile, scopes: tokens.scopes })
  cached = {
    token: tokens.access,
    expiresAt: Date.now() + tokens.expiresIn * 1000,
  }
  return tokens.access
}

export async function chatGptStatus(): Promise<ChatGptStatus> {
  const profile = await readJson<ChatGptProfile>(profileFile())
  if (!profile || !(await readKey(refreshAccount))) return { signedIn: false }
  return {
    signedIn: true,
    email: profile.email,
    planUsage: profile.scopes.includes(planScope),
  }
}

/** Revokes the session at OpenAI as far as possible, then forgets the tokens; the registration stays. */
export async function signOut(): Promise<void> {
  const profile = await readJson<ChatGptProfile>(profileFile())
  const saved = await readKey(refreshAccount)
  if (profile && saved)
    await systemFetch(`${issuer}/api/accounts/oauth/revoke`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        token: saved,
        token_type_hint: 'refresh_token',
        client_id: profile.clientId,
      }).toString(),
      signal: AbortSignal.timeout(15_000),
    }).catch(() => undefined)
  cached = undefined
  await writeKey('', refreshAccount)
}
