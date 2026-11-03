// HTTP hardening, end to end against a running server on the fork (all requests come from 127.0.0.1; with trustProxy the
// test plays the reverse proxy and sets X-Forwarded-For).
import net from 'node:net'
import { createPublicClient, createTestClient, http, parseEther } from 'viem'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import { deploy } from '@fondaco/contracts/deploy'
import { start } from '../dist/index.js'

const FORK_URL = process.env.FORK_URL || 'http://127.0.0.1:8545'
const USDC = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', WETH = '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2'
const chain = { id: 1, name: 'fork', nativeCurrency: { name: 'ETH', symbol: 'ETH', decimals: 18 }, rpcUrls: { default: { http: [FORK_URL] } } }
const pub = createPublicClient({ chain, transport: http(FORK_URL) })
const test = createTestClient({ chain, mode: 'anvil', transport: http(FORK_URL) })
const results = []
const check = (n, ok, d = '') => { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'} | ${n}${d ? ' | ' + d : ''}`) }

const pk = generatePrivateKey()
await test.setBalance({ address: privateKeyToAccount(pk).address, value: parseEther('10') })
const startBlock = await pub.getBlockNumber()
const { swap: SWAP } = await deploy({ rpc: FORK_URL, privateKey: pk, feeBps: 30, feeWallet: privateKeyToAccount(generatePrivateKey()).address, owner: privateKeyToAccount(generatePrivateKey()).address, log: () => {} })
const cfg = (extra = {}) => ({ port: 0, db: ':memory:', corsOrigin: 'https://app.fondaco.example', ...extra,
  chains: { 1: { rpc: FORK_URL, swap: SWAP, startBlock: startBlock.toString(), pollMs: 3_600_000, tokens: { [USDC]: { symbol: 'USDC', decimals: 6 }, [WETH]: { symbol: 'WETH', decimals: 18 } } } } })
const app = await start(cfg({ rateLimit: { capacity: 100000, refillPerSec: 10000 } }), { log: () => {} })
const port = app.server.address().port, base = `http://127.0.0.1:${port}`
const BOOK = `/book?chainId=1&base=${WETH}&quote=${USDC}`

/** raw socket: write `parts` with pauses, collect the status line and how long the server took to close */
const rawReq = (parts, pauseMs, limitMs = 40_000) => new Promise((resolve) => {
  const t0 = Date.now(); let got = ''
  const s = net.connect(port, '127.0.0.1', async () => { for (const p of parts) { if (s.destroyed) break; s.write(p); await new Promise((r) => setTimeout(r, pauseMs)) } })
  s.on('data', (d) => { got += d })
  const done = () => resolve({ status: got.split('\r\n')[0], secs: (Date.now() - t0) / 1000 })
  s.on('close', done); s.on('error', done)
  setTimeout(() => { s.destroy() }, limitMs)
})

// S1 slow body (headers sent, body trickles): cut off by requestTimeout (20 s), with 408
const slowBody = await rawReq(['POST /orders HTTP/1.1\r\nHost: x\r\nContent-Type: application/json\r\nContent-Length: 100000\r\n\r\n', ...Array(60).fill('{')], 1000)
check('S1: slow body (slowloris on the body) → closed by the 20 s request timeout', slowBody.secs >= 19 && slowBody.secs < 30 && /408/.test(slowBody.status), `${slowBody.status} after ${slowBody.secs.toFixed(0)} s`)
// S2 slow headers: cut by headersTimeout (10 s)
const slowHead = await rawReq(['GET /health HTTP/1.1\r\n', ...Array(30).fill('X-A: b\r\n')], 1000)
check('S2: slow headers → closed by the 10 s headers timeout', slowHead.secs >= 9 && slowHead.secs < 15, `${slowHead.status} after ${slowHead.secs.toFixed(0)} s`)

const post = (body, headers = { 'content-type': 'application/json' }) => fetch(`${base}/orders`, { method: 'POST', headers, body })
// S3 bodies over 256 KB: declared (413 before reading) and streamed without length (413 while reading)
const big = JSON.stringify({ chainId: 1, orders: [{ pad: 'x'.repeat(300 * 1024) }] })
const r3a = await post(big)
const r3b = await fetch(`${base}/orders`, { method: 'POST', headers: { 'content-type': 'application/json' }, duplex: 'half',
  body: new ReadableStream({ start(c) { for (let i = 0; i < 40; i++) c.enqueue(new TextEncoder().encode('x'.repeat(10 * 1024))); c.close() } }) }).then((r) => r.status, () => 'closed')
check('S3: body > 256 KB → 413, with Content-Length and when streamed (chunked)', r3a.status === 413 && (r3b === 413 || r3b === 'closed'), `${r3a.status} / ${r3b}`)

// S4 malformed and hostile JSON
const r4 = await Promise.all([post('{"chainId":1,'), post('['.repeat(100_000) + ']'.repeat(100_000)), post(JSON.stringify({ chainId: 1, orders: [JSON.parse('{"a":'.repeat(500) + '1' + '}'.repeat(500))] })),
  post(JSON.stringify({ chainId: 1, orders: 'nope' })), post(JSON.stringify({ chainId: 1, orders: [null, 1, 'x'] })), post(JSON.stringify({ chainId: 1, orders: [{ __proto__: { v: 27 }, nonce: '1' }] }))])
const bodies4 = await Promise.all(r4.map((r) => r.json()))
const health = (await fetch(`${base}/health`)).status
check('S4: malformed, 100 000-deep, 500-deep, wrong-type and prototype-polluting JSON → 4xx, server alive', r4.every((r) => r.status >= 400 && r.status < 500) && health === 200 && ({}).v === undefined,
  r4.map((r, i) => `${r.status}:${bodies4[i].error ?? bodies4[i].results?.map((x) => x.error).join('+')}`).join(' '))

// S5 content types
const ct = ['text/plain', 'application/x-www-form-urlencoded', 'multipart/form-data; boundary=x', '', 'application/json; charset=utf-8', 'APPLICATION/JSON']
const r5 = await Promise.all(ct.map((c) => post(JSON.stringify({ chainId: 1, orders: [{}] }), c ? { 'content-type': c } : {}).then((r) => r.status)))
check('S5: CORS-simple content types (text/plain, form, multipart) and none → 415; application/json (any case, with charset) → processed', r5.slice(0, 4).every((s) => s === 415) && r5.slice(4).every((s) => s === 422),
  ct.map((c, i) => `${c || '∅'}=${r5[i]}`).join(', '))

// S6 oversized URL/headers → 431; unknown method/path → 404
const r6a = await fetch(`${base}/book?x=${'a'.repeat(20_000)}`).then((r) => r.status, () => 'closed')
const r6b = await fetch(`${base}/orders`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: '{}' })
check('S6: header section over 16 KB → 431; PUT /orders → 404', r6a === 431 && r6b.status === 404, `${r6a} / ${r6b.status}`)

// S7 ETag / 304, CORS
const b7 = await fetch(base + BOOK)
const etag = b7.headers.get('etag')
const r7 = [(await fetch(base + BOOK, { headers: { 'if-none-match': etag } })).status, (await fetch(base + BOOK, { headers: { 'if-none-match': 'W/"1-0-0"' } })).status]
const pre = await fetch(`${base}/orders`, { method: 'OPTIONS', headers: { origin: 'https://evil.example', 'access-control-request-method': 'POST', 'access-control-request-headers': 'content-type' } })
check('S7: ETag → 304 when it matches, 200 otherwise; CORS: configured origin only, preflight 204, etag exposed',
  /^W\/"1-\d+-\d+"$/.test(etag) && r7.join() === '304,200' && pre.status === 204 && pre.headers.get('access-control-allow-origin') === 'https://app.fondaco.example' &&
  b7.headers.get('access-control-expose-headers') === 'etag' && /content-type/.test(pre.headers.get('access-control-allow-headers')), `${etag} → ${r7}; preflight ${pre.status} allow-origin ${pre.headers.get('access-control-allow-origin')}`)
await app.stop()

// rate limiting on dedicated servers (capacity 5, no refill)
const limited = async (extra) => { const a = await start(cfg({ rateLimit: { capacity: 5, refillPerSec: 0 }, ...extra }), { log: () => {} }); return { a, url: `http://127.0.0.1:${a.server.address().port}` } }
const hit = async (url, xff) => (await fetch(url + BOOK, { headers: xff ? { 'x-forwarded-for': xff } : {} })).status
const burst = async (url, xffs) => { const out = []; for (const x of xffs) out.push(await hit(url, x)); return out }

// S8 without trustProxy, X-Forwarded-For is ignored: rotating it does not mint new buckets
const { a: a8, url: u8 } = await limited({})
const s8 = await burst(u8, Array.from({ length: 10 }, (_, i) => `10.0.0.${i}`))
await a8.stop()
check('S8: no trustProxy → X-Forwarded-For ignored; 10 requests with 10 forged addresses: 5 served, then 429', s8.filter((s) => s === 200).length === 5 && s8.slice(5).every((s) => s === 429), s8.join(','))

// S9 trustProxy = 1: the client's own prefix is ignored, the address appended by the proxy counts
const { a: a9, url: u9 } = await limited({ trustProxy: 1 })
const s9 = await burst(u9, Array.from({ length: 10 }, (_, i) => `6.6.6.${i}, 203.0.113.7`))
const other = await hit(u9, '198.51.100.1')
await a9.stop()
check('S9: trustProxy=1 → forged left-hand X-Forwarded-For entries do not help (same client 203.0.113.7: 5 then 429); another client has its own bucket',
  s9.filter((s) => s === 200).length === 5 && s9.slice(5).every((s) => s === 429) && other === 200, `${s9.join(',')}; other client ${other}`)

// S10 IPv6: one /64 is one client; different /64s inside one /48 share the 16× /48 budget (80 here)
const { a: a10, url: u10 } = await limited({ trustProxy: 1 })
const same64 = await burst(u10, Array.from({ length: 8 }, (_, i) => `2001:db8:aa:1::${i + 1}`))
const many64 = await burst(u10, Array.from({ length: 120 }, (_, i) => `2001:db8:aa:${(i + 2).toString(16)}::1`))
const other48 = await hit(u10, '2001:db8:bb:1::1')
await a10.stop()
check('S10: IPv6 — addresses of one /64 share a bucket (5 then 429); fresh /64s in one /48 are capped by the /48 bucket; another /48 is unaffected',
  same64.filter((s) => s === 200).length === 5 && many64.filter((s) => s === 200).length === 80 - 5 && other48 === 200,
  `same /64: ${same64.filter((s) => s === 200).length}/8; 120 fresh /64s: ${many64.filter((s) => s === 200).length} served; other /48: ${other48}`)

// S11 SSE: 4 streams per client key (IPv6 /64 via the proxy header), the 5th → 503; another client still connects
const { a: a11, url: u11 } = await limited({ trustProxy: 1, rateLimit: { capacity: 1000, refillPerSec: 0 } })
const ctrls = [], codes = []
for (let i = 0; i < 6; i++) { const c = new AbortController(); ctrls.push(c); codes.push((await fetch(`${u11}/stream`, { signal: c.signal, headers: { 'x-forwarded-for': i < 5 ? `2001:db8:cc:1::${i + 1}` : '2001:db8:dd:1::1' } })).status) }
ctrls.forEach((c) => c.abort())
await a11.stop()
check('S11: SSE limit per client (IPv6 /64): 4 streams, the 5th → 503, another client → 200', codes.join() === '200,200,200,200,503,200', codes.join(','))

const failed = results.filter((x) => !x).length
console.log(`\n${results.length - failed}/${results.length} checks passed`)
process.exit(failed ? 1 : 0)
