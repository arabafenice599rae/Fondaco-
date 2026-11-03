// HTTP API on node:http (no framework). JSON in/out, SSE for live updates.
// Hardening: per-client token bucket (IPv6 grouped by /64, LRU-bounded, proxy-aware only when configured),
// slow-client timeouts, strict JSON content type, body size cap, concurrency cap on order intake,
// per-client SSE cap, ETag/304 on the book. /metrics: off by default, then allowlisted networks or bearer token.
import http, { type IncomingMessage, type ServerResponse } from 'node:http'
import { timingSafeEqual, createHash } from 'node:crypto'
import { getAddress, isAddress } from 'viem'
import type { Engine } from './engine.js'
import type { Logger } from './log.js'
import { inAny } from './cidr.js'
import { PROMETHEUS_CONTENT_TYPE, type Registry, type Histogram, type Gauge } from './metrics.js'

const MAX_BODY = 256 * 1024
const MAX_BATCH = 50
const MAX_SSE = 2000
const ZERO = '0x0000000000000000000000000000000000000000'

type Limiter = (key: string, cost?: number) => boolean
/** Token bucket per client key. Bounded LRU: overflow evicts the least recently seen keys, never everyone's buckets. */
export function rateLimiter({ capacity = 60, refillPerSec = 2, maxKeys = 100_000 }: { capacity?: number; refillPerSec?: number; maxKeys?: number } = {}): Limiter {
  const buckets = new Map<string, { tokens: number; at: number }>()
  return (key, cost = 1) => {
    const now = Date.now()
    const b = buckets.get(key) || { tokens: capacity, at: now }
    b.tokens = Math.min(capacity, b.tokens + ((now - b.at) / 1000) * refillPerSec)
    b.at = now
    buckets.delete(key) // re-insert = most recently used
    const ok = b.tokens >= cost
    if (ok) b.tokens -= cost
    buckets.set(key, b)
    while (buckets.size > maxKeys) buckets.delete(buckets.keys().next().value as string)
    return ok
  }
}

type ReqLike = { socket: { remoteAddress?: string | undefined }; headers: Record<string, string | string[] | undefined> }
/**
 * Client keys for limits. X-Forwarded-For is trusted only with `trustProxy: N` (N proxies in front, each appending):
 * the client is the N-th address from the right. Anything a client writes further left is ignored.
 * IPv6 clients are grouped by /64 (one host usually controls a whole /64) and also limited per /48 (16× budget),
 * so one allocation cannot mint thousands of fresh /64 buckets.
 * @returns [primary, wider?]
 */
export function clientKeys(req: ReqLike, trustProxy = 0): string[] {
  let ip = req.socket.remoteAddress || 'unknown'
  if (trustProxy > 0) {
    const xff = String(req.headers['x-forwarded-for'] || '').split(',').map((s) => s.trim()).filter(Boolean)
    if (xff.length >= trustProxy) ip = xff[xff.length - trustProxy] as string
  }
  if (ip.startsWith('::ffff:')) ip = ip.slice(7)
  if (ip.includes(':')) {
    const g = expand6(ip)
    if (g) return [g.slice(0, 4).join(':') + '::/64', g.slice(0, 3).join(':') + '::/48']
  }
  return [ip]
}
function expand6(ip: string): string[] | null {
  const [head, tail] = (ip.split('%')[0] as string).split('::')
  const h = head ? head.split(':') : [], t = tail != null && tail !== '' ? tail.split(':') : []
  if (tail == null && h.length !== 8) return null
  const g = [...h, ...Array<string>(Math.max(0, 8 - h.length - t.length)).fill('0'), ...t].map((x) => (x || '0').toLowerCase().replace(/^0+(?=.)/, ''))
  return g.length === 8 ? g : null
}

const SEC_HEADERS = { 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer', 'cross-origin-resource-policy': 'cross-origin' }
const bigintSafe = (_: string, v: unknown) => (typeof v === 'bigint' ? v.toString() : v)
const json = (res: ServerResponse, code: number, body: unknown, extra: Record<string, string> = {}) => {
  const s = JSON.stringify(body, bigintSafe)
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...SEC_HEADERS, ...extra })
  res.end(s)
}

type HttpError = Error & { status?: number; code?: string }
function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const len = Number(req.headers['content-length'] || 0)
    if (len > MAX_BODY) return reject(Object.assign(new Error('body too large'), { status: 413 }))
    let size = 0
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => {
      size += c.length
      if (size > MAX_BODY) { reject(Object.assign(new Error('body too large'), { status: 413 })); req.destroy() }
      else chunks.push(c)
    })
    req.on('end', () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')) } catch { reject(Object.assign(new Error('invalid JSON'), { status: 400 })) }
    })
    req.on('error', reject)
  })
}

/** Route label for metrics: bounded cardinality (never the raw path). */
const routeOf = (method: string, path: string) =>
  ['/book', '/books', '/config', '/health', '/stream', '/metrics', '/orders', '/trades', '/candles'].includes(path) ? `${method} ${path}`
    : /^\/orders\/0x[0-9a-fA-F]{64}$/.test(path) ? `${method} /orders/:hash` : 'other'

export interface ServerOptions {
  corsOrigin?: string
  rate?: { capacity: number; refillPerSec: number } | undefined
  trustProxy?: number
  maxConcurrentSubmits?: number
  ssePerClient?: number
  log?: Logger
  metrics?: { enabled: boolean; token?: string | undefined; allow: string[]; registry: Registry; httpDuration: Histogram; sseClients: Gauge }
}
export type BookServer = http.Server & { sseClients: Set<ServerResponse> }

export function createServer(engine: Engine, { corsOrigin = '*', rate, trustProxy = 0, maxConcurrentSubmits = 8, ssePerClient = 4, log, metrics }: ServerOptions = {}): BookServer {
  const lim = rateLimiter(rate)
  const limWide = rateLimiter({ capacity: (rate?.capacity ?? 60) * 16, refillPerSec: (rate?.refillPerSec ?? 2) * 16 })
  const allow = (keys: string[], cost = 1) => lim(keys[0] as string, cost) && (keys.length < 2 || limWide(keys[1] as string, cost))
  const clients = new Set<ServerResponse>()
  const ssePer = new Map<string, number>()
  let submitting = 0
  const broadcast = (event: string, e: unknown) => { const line = `event: ${event}\ndata: ${JSON.stringify(e, bigintSafe)}\n\n`; for (const c of clients) c.write(line) }
  engine.on('order', (e) => broadcast('order', e))
  engine.on('fee', (e) => broadcast('fee', e))
  engine.on('reorg', (e) => broadcast('reorg', e))
  engine.on('trade', (e) => broadcast('trade', e))
  engine.on('governance', (e) => broadcast('governance', e))
  const tokenHash = metrics?.token ? createHash('sha256').update(metrics.token).digest() : null
  const metricsAllowed = (req: IncomingMessage) => {
    const auth = String(req.headers.authorization || '')
    if (tokenHash && auth.startsWith('Bearer ') && timingSafeEqual(createHash('sha256').update(auth.slice(7)).digest(), tokenHash)) return true
    // the direct peer only: X-Forwarded-For can be forged
    return inAny(req.socket.remoteAddress || '', metrics?.allow ?? [])
  }

  // slow clients (slowloris): bounded time to send headers and the whole request (checked every 2 s), idle keep-alive.
  // These must be constructor options: the periodic connection check is configured at creation.
  const server = http.createServer({ headersTimeout: 10_000, requestTimeout: 20_000, connectionsCheckingInterval: 2_000, keepAliveTimeout: 5_000 }, async (req, res) => {
    const t0 = performance.now()
    const url = new URL(req.url || '/', 'http://x')
    const path = url.pathname
    const route = routeOf(req.method || 'GET', path)
    if (metrics && route !== 'GET /stream') {
      res.once('finish', () => metrics.httpDuration.observe({ route, code: res.statusCode }, (performance.now() - t0) / 1000))
    }
    res.setHeader('access-control-allow-origin', corsOrigin)
    res.setHeader('access-control-allow-headers', 'content-type, if-none-match')
    res.setHeader('access-control-expose-headers', 'etag')
    if (req.method === 'OPTIONS') return void res.writeHead(204).end()
    const keys = clientKeys(req, trustProxy), key = keys[0] as string
    try {
      if (req.method === 'GET' && path === '/health') return json(res, 200, { ok: true })

      if (req.method === 'GET' && path === '/metrics') {
        if (!metrics?.enabled) return json(res, 404, { error: 'not_found' })
        if (!metricsAllowed(req)) return json(res, 401, { error: 'unauthorized' }, { 'www-authenticate': 'Bearer' })
        metrics.sseClients.set({}, clients.size)
        res.writeHead(200, { 'content-type': PROMETHEUS_CONTENT_TYPE, 'cache-control': 'no-store', ...SEC_HEADERS })
        return void res.end(metrics.registry.render())
      }

      if (req.method === 'POST' && path === '/orders') {
        // a simple-request content type would let any web page post cross-origin without a preflight
        if (!String(req.headers['content-type'] || '').toLowerCase().startsWith('application/json')) return json(res, 415, { error: 'unsupported_media_type' })
        const body = await readBody(req)
        const list = Array.isArray(body.orders) ? body.orders : body.order ? [body.order] : []
        if (list.length === 0 || list.length > MAX_BATCH) return json(res, 400, { error: 'bad_request', message: `send 1..${MAX_BATCH} orders` })
        if (!allow(keys, list.length)) return json(res, 429, { error: 'rate_limited' }, { 'retry-after': '5' })
        if (submitting >= maxConcurrentSubmits) return json(res, 503, { error: 'busy' }, { 'retry-after': '1' })
        submitting++
        try {
          const results = await engine.submit(body.chainId as number, list)
          return json(res, results.some((r) => 'hash' in r) ? 201 : 422, { results })
        } finally {
          submitting--
        }
      }

      if (!allow(keys)) return json(res, 429, { error: 'rate_limited' }, { 'retry-after': '5' })

      if (req.method === 'GET' && path === '/config') return json(res, 200, engine.publicConfig())

      if (req.method === 'GET' && path === '/book') {
        const chainId = Number(url.searchParams.get('chainId'))
        const base = url.searchParams.get('base'), quote = url.searchParams.get('quote')
        const limit = Math.max(1, Math.min(Number(url.searchParams.get('limit') || 50) || 50, 200))
        if (!isAddress(base || '') || !isAddress(quote || '')) return json(res, 400, { error: 'bad_request', message: 'base/quote required' })
        // signed=1 adds the full signed order to each entry, so a taker can verify and execute without N extra requests
        const { etag, ...book } = engine.book(chainId, base as string, quote as string, limit, { signed: url.searchParams.get('signed') === '1' })
        if (req.headers['if-none-match'] === etag) { res.writeHead(304, { etag, ...SEC_HEADERS }); return void res.end() }
        return json(res, 200, book, { etag, 'cache-control': 'no-cache' })
      }

      // several books in one request (the app's first screen): one entry per pair, a pair outside the whitelist is reported
      // in its entry (no HTTP error); a stale chain fails the whole request, like /book (fail closed)
      if (req.method === 'GET' && path === '/books') {
        const chainId = Number(url.searchParams.get('chainId'))
        const pairs = (url.searchParams.get('pairs') || '').split(',').filter(Boolean)
        const limit = Math.max(1, Math.min(Number(url.searchParams.get('limit') || 50) || 50, 200))
        if (!pairs.length || pairs.length > 10) return json(res, 400, { error: 'bad_request', message: '1 to 10 pairs (base:quote) required' })
        const books: Record<string, unknown> = {}
        for (const p of pairs) {
          const [base, quote] = p.split(':')
          if (!isAddress(base || '') || !isAddress(quote || '')) return json(res, 400, { error: 'bad_request', message: `pair ${p}: base:quote addresses required` })
          try {
            const { etag: _e, ...book } = engine.book(chainId, base as string, quote as string, limit, { signed: url.searchParams.get('signed') === '1' })
            books[p] = book
          } catch (e) {
            if ((e as HttpError).code !== 'token_not_allowed') throw e
            books[p] = { error: 'token_not_allowed' }
          }
        }
        return json(res, 200, { books }, { 'cache-control': 'no-cache' })
      }

      if (req.method === 'GET' && (path === '/trades' || path === '/candles')) {
        const chainId = Number(url.searchParams.get('chainId'))
        const base = url.searchParams.get('base'), quote = url.searchParams.get('quote')
        if (!isAddress(base || '') || !isAddress(quote || '')) return json(res, 400, { error: 'bad_request', message: 'base/quote required' })
        const num = (k: string, d: number) => { const v = Number(url.searchParams.get(k) || d); return Number.isFinite(v) ? v : d }
        const { etag, ...body } = path === '/trades'
          ? engine.trades(chainId, base as string, quote as string, num('limit', 50))
          : engine.candles(chainId, base as string, quote as string, num('interval', 300), num('limit', 288))
        if (req.headers['if-none-match'] === etag) { res.writeHead(304, { etag, ...SEC_HEADERS }); return void res.end() }
        return json(res, 200, body, { etag, 'cache-control': 'no-cache' })
      }

      const m = path.match(/^\/orders\/(0x[0-9a-fA-F]{64})$/)
      if (req.method === 'GET' && m) {
        const row = engine.db.byHash((m[1] as string).toLowerCase())
        return row ? json(res, 200, engine.orderJson(row)) : json(res, 404, { error: 'not_found' })
      }

      if (req.method === 'GET' && path === '/orders') {
        const chainId = Number(url.searchParams.get('chainId'))
        const signer = url.searchParams.get('signer')
        if (!isAddress(signer || '')) return json(res, 400, { error: 'bad_request', message: 'signer required' })
        // private (OTC) orders: terms shown, signature withheld — the counterparty gets the full order by hash
        return json(res, 200, { orders: engine.db.bySigner(chainId, getAddress(signer as string)).map((r) => engine.orderJson(r, r.sender_wallet === ZERO)) })
      }

      if (req.method === 'GET' && path === '/stream') {
        const n = ssePer.get(key) || 0
        if (clients.size >= MAX_SSE || n >= ssePerClient) return json(res, 503, { error: 'too_many_streams' })
        ssePer.set(key, n + 1)
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive', ...SEC_HEADERS })
        res.write(': connected\n\n')
        clients.add(res)
        const ping = setInterval(() => res.write(': ping\n\n'), 25_000)
        req.on('close', () => {
          clearInterval(ping)
          clients.delete(res)
          const left = (ssePer.get(key) || 1) - 1
          if (left > 0) ssePer.set(key, left); else ssePer.delete(key)
        })
        return
      }

      return json(res, 404, { error: 'not_found' })
    } catch (err) {
      const e = err as HttpError
      const status = e.status || (e.code === 'unknown_chain' || e.code === 'token_not_allowed' ? 400 : e.code === 'stale' ? 503 : 500)
      if (status === 500) (log ? log.error('request failed', { route, error: e }) : console.error(e))
      return json(res, status, { error: e.code || 'error', message: status === 500 ? 'internal error' : e.message })
    }
  }) as BookServer
  server.maxHeadersCount = 64
  server.maxRequestsPerSocket = 1_000
  server.sseClients = clients
  return server
}
