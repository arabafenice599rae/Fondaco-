// HTTP API on node:http (no framework). JSON in/out, SSE for live updates.
// Hardening: per-client token bucket (IPv6 grouped by /64, LRU-bounded, proxy-aware only when configured),
// slow-client timeouts, strict JSON content type, body size cap, concurrency cap on order intake,
// per-client SSE cap, ETag/304 on the book.
import http from 'node:http'
import { getAddress, isAddress } from 'viem'

const MAX_BODY = 256 * 1024
const MAX_BATCH = 50
const MAX_SSE = 2000
const ZERO = '0x0000000000000000000000000000000000000000'

/** Token bucket per client key. Bounded LRU: overflow evicts the least recently seen keys, never everyone's buckets. */
export function rateLimiter({ capacity = 60, refillPerSec = 2, maxKeys = 100_000 } = {}) {
  const buckets = new Map()
  return (key, cost = 1) => {
    const now = Date.now()
    const b = buckets.get(key) || { tokens: capacity, at: now }
    b.tokens = Math.min(capacity, b.tokens + ((now - b.at) / 1000) * refillPerSec)
    b.at = now
    buckets.delete(key) // re-insert = most recently used
    const ok = b.tokens >= cost
    if (ok) b.tokens -= cost
    buckets.set(key, b)
    while (buckets.size > maxKeys) buckets.delete(buckets.keys().next().value)
    return ok
  }
}

/**
 * Client keys for limits. X-Forwarded-For is trusted only with `trustProxy: N` (N proxies in front, each appending):
 * the client is the N-th address from the right. Anything a client writes further left is ignored.
 * IPv6 clients are grouped by /64 (one host usually controls a whole /64) and also limited per /48 (16× budget),
 * so one allocation cannot mint thousands of fresh /64 buckets.
 * @returns [primary, wider?]
 */
export function clientKeys(req, trustProxy = 0) {
  let ip = req.socket.remoteAddress || 'unknown'
  if (trustProxy > 0) {
    const xff = String(req.headers['x-forwarded-for'] || '').split(',').map((s) => s.trim()).filter(Boolean)
    if (xff.length >= trustProxy) ip = xff[xff.length - trustProxy]
  }
  if (ip.startsWith('::ffff:')) ip = ip.slice(7)
  if (ip.includes(':')) {
    const g = expand6(ip)
    if (g) return [g.slice(0, 4).join(':') + '::/64', g.slice(0, 3).join(':') + '::/48']
  }
  return [ip]
}
function expand6(ip) {
  const [head, tail] = ip.split('%')[0].split('::')
  const h = head ? head.split(':') : [], t = tail != null && tail !== '' ? tail.split(':') : []
  if (tail == null && h.length !== 8) return null
  const g = [...h, ...Array(8 - h.length - t.length).fill('0'), ...t].map((x) => (x || '0').toLowerCase().replace(/^0+(?=.)/, ''))
  return g.length === 8 ? g : null
}

const SEC_HEADERS = { 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer', 'cross-origin-resource-policy': 'cross-origin' }
const json = (res, code, body, extra = {}) => {
  const s = JSON.stringify(body, (_, v) => (typeof v === 'bigint' ? v.toString() : v))
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...SEC_HEADERS, ...extra })
  res.end(s)
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const len = Number(req.headers['content-length'] || 0)
    if (len > MAX_BODY) return reject(Object.assign(new Error('body too large'), { status: 413 }))
    let size = 0
    const chunks = []
    req.on('data', (c) => {
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

export function createServer(engine, { corsOrigin = '*', rate, trustProxy = 0, maxConcurrentSubmits = 8, ssePerClient = 4 } = {}) {
  const lim = rateLimiter(rate)
  const limWide = rateLimiter({ capacity: (rate?.capacity ?? 60) * 16, refillPerSec: (rate?.refillPerSec ?? 2) * 16 })
  const allow = (keys, cost = 1) => lim(keys[0], cost) && (keys.length < 2 || limWide(keys[1], cost))
  const clients = new Set()
  const ssePer = new Map()
  let submitting = 0
  engine.on('order', (e) => { const line = `event: order\ndata: ${JSON.stringify(e)}\n\n`; for (const c of clients) c.write(line) })
  engine.on('fee', (e) => { const line = `event: fee\ndata: ${JSON.stringify(e)}\n\n`; for (const c of clients) c.write(line) })
  engine.on('reorg', (e) => { const line = `event: reorg\ndata: ${JSON.stringify(e, (_, v) => (typeof v === 'bigint' ? v.toString() : v))}\n\n`; for (const c of clients) c.write(line) })

  // slow clients (slowloris): bounded time to send headers and the whole request (checked every 2 s), idle keep-alive.
  // These must be constructor options: the periodic connection check is configured at creation.
  const server = http.createServer({ headersTimeout: 10_000, requestTimeout: 20_000, connectionsCheckingInterval: 2_000, keepAliveTimeout: 5_000 }, async (req, res) => {
    res.setHeader('access-control-allow-origin', corsOrigin)
    res.setHeader('access-control-allow-headers', 'content-type, if-none-match')
    res.setHeader('access-control-expose-headers', 'etag')
    if (req.method === 'OPTIONS') return res.writeHead(204).end()
    const keys = clientKeys(req, trustProxy), key = keys[0]
    const url = new URL(req.url, 'http://x')
    const path = url.pathname
    try {
      if (req.method === 'GET' && path === '/health') return json(res, 200, { ok: true })

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
          const results = await engine.submit(body.chainId, list)
          return json(res, results.some((r) => r.hash) ? 201 : 422, { results })
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
        const { etag, ...book } = engine.book(chainId, base, quote, limit, { signed: url.searchParams.get('signed') === '1' })
        if (req.headers['if-none-match'] === etag) { res.writeHead(304, { etag, ...SEC_HEADERS }); return res.end() }
        return json(res, 200, book, { etag, 'cache-control': 'no-cache' })
      }

      const m = path.match(/^\/orders\/(0x[0-9a-fA-F]{64})$/)
      if (req.method === 'GET' && m) {
        const row = engine.db.byHash(m[1].toLowerCase())
        return row ? json(res, 200, engine.orderJson(row)) : json(res, 404, { error: 'not_found' })
      }

      if (req.method === 'GET' && path === '/orders') {
        const chainId = Number(url.searchParams.get('chainId'))
        const signer = url.searchParams.get('signer')
        if (!isAddress(signer || '')) return json(res, 400, { error: 'bad_request', message: 'signer required' })
        // private (OTC) orders: terms shown, signature withheld — the counterparty gets the full order by hash
        return json(res, 200, { orders: engine.db.bySigner(chainId, getAddress(signer)).map((r) => engine.orderJson(r, r.sender_wallet === ZERO)) })
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
    } catch (e) {
      const status = e.status || (e.code === 'unknown_chain' || e.code === 'token_not_allowed' ? 400 : 500)
      if (status === 500) console.error(e)
      return json(res, status, { error: e.code || 'error', message: status === 500 ? 'internal error' : e.message })
    }
  })
  server.maxHeadersCount = 64
  server.maxRequestsPerSocket = 1_000
  server.sseClients = clients
  return server
}
