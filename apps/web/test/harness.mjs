// Shared environment of the app's browser tests: anvil fork (FORK_URL, fixed block) + SwapERC20 v4.3 from the fixture +
// book servers + the static build served with gzip (config.json per instance, in memory) + Chromium pages with an injected
// EIP-6963 wallet. The wallet forwards to anvil's unlocked dev accounts (no key anywhere) and can be steered by the test:
// reject the next signature/transaction, switch chain (chainChanged), and every page records its console.
import { execFileSync } from 'node:child_process'
import { createServer } from 'node:http'
import { gzipSync } from 'node:zlib'
import { mkdtempSync, readFileSync, existsSync, readdirSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, extname, resolve } from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { createPublicClient, createTestClient, createWalletClient, http, parseAbi, getAddress, encodeAbiParameters, keccak256, toHex } from 'viem'

const require = createRequire(import.meta.url)
export const { chromium } = (() => { try { return require('playwright') } catch { return require('/opt/node-tools/node_modules/playwright') } })()
export const APP = resolve(fileURLToPath(new URL('.', import.meta.url)), '..')
export const ROOT = resolve(APP, '../..')
export const FORK_URL = process.env.FORK_URL || 'http://127.0.0.1:8545'
export const USDC = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48'
export const WETH = '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2'
export const ZERO = '0x0000000000000000000000000000000000000000'
export const FEE = 30n
export const E18 = 10n ** 18n, E6 = 10n ** 6n
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
export async function until(f, ms = 30_000, what = 'condition') { const t0 = Date.now(); for (;;) { const v = await f(); if (v) return v; if (Date.now() - t0 > ms) throw new Error('timeout: ' + what); await sleep(150) } }

// ------------------------------------------------------------------ results
export function reporter() {
  const results = []
  const check = (name, ok, detail = '') => { results.push(!!ok); console.log(`${ok ? 'PASS' : 'FAIL'} | ${name}${detail ? ' | ' + detail : ''}`) }
  const finish = () => { const p = results.filter(Boolean).length; console.log(`\n${p}/${results.length} checks passed`); return p === results.length && results.length > 0 }
  return { check, finish, results }
}

// ------------------------------------------------------------------ chain
export const chain = { id: 1, name: 'fork', nativeCurrency: { name: 'ETH', symbol: 'ETH', decimals: 18 }, rpcUrls: { default: { http: [FORK_URL] } } }
export const ERC20 = parseAbi(['function balanceOf(address) view returns (uint256)', 'function deposit() payable', 'function allowance(address,address) view returns (uint256)', 'function transfer(address,uint256) returns (bool)', 'function approve(address,uint256) returns (bool)'])
export const pub = createPublicClient({ chain, transport: http(FORK_URL, { timeout: 180_000 }) })
export const test = createTestClient({ chain, mode: 'anvil', transport: http(FORK_URL, { timeout: 180_000 }) })
export const dev = (a) => createWalletClient({ account: a, chain, transport: http(FORK_URL, { timeout: 180_000 }) })
export const bal = (t, a) => pub.readContract({ address: t, abi: ERC20, functionName: 'balanceOf', args: [a] })
export const SwapArt = JSON.parse(readFileSync(resolve(ROOT, 'packages/contracts/fixtures/SwapERC20.json'), 'utf8'))
export async function send(from, req) { const h = await dev(from).writeContract(req); const rc = await pub.waitForTransactionReceipt({ hash: h }); if (rc.status !== 'success') throw new Error('tx reverted'); return rc }
export async function setUsdc(addr, amount) {
  const slot = keccak256(encodeAbiParameters([{ type: 'address' }, { type: 'uint256' }], [addr, 9n]))
  await test.setStorageAt({ address: USDC, index: slot, value: toHex(amount, { size: 32 }) })
}
export async function setWeth(addr, amount) {
  const slot = keccak256(encodeAbiParameters([{ type: 'address' }, { type: 'uint256' }], [addr, 3n]))
  await test.setStorageAt({ address: WETH, index: slot, value: toHex(amount, { size: 32 }) })
}
export async function accounts() { return (await pub.request({ method: 'eth_accounts' })).map((a) => getAddress(a)) }
/** Deploy the fixture; `owner` deploys it (and is the owner, standing in for the test Safe). */
export async function deploySwap(owner, feeWallet) {
  const hash = await dev(owner).deployContract({ abi: SwapArt.abi, bytecode: SwapArt.bytecode, args: [FEE, FEE, feeWallet, 0n, 0n] })
  const rc = await pub.waitForTransactionReceipt({ hash })
  return { swap: getAddress(rc.contractAddress), block: rc.blockNumber }
}

// ------------------------------------------------------------------ books
export async function startBooks(n, swap, startBlock, { pollMs = 600 } = {}) {
  const { start } = await import(resolve(ROOT, 'packages/book-server/dist/index.js'))
  const out = []
  for (let i = 0; i < n; i++) {
    const app = await start({
      port: 0, db: ':memory:', rateLimit: { capacity: 2000, refillPerSec: 200 },
      chains: { 1: { rpc: FORK_URL, swap, startBlock: startBlock.toString(), pollMs, minExpirySec: 60, maxExpirySec: 7 * 86400,
        tokens: { [USDC]: { symbol: 'USDC', decimals: 6 }, [WETH]: { symbol: 'WETH', decimals: 18 } } } },
    }, { log: () => {} })
    const url = `http://127.0.0.1:${app.server.address().port}`
    const api = async (path, init) => { const r = await fetch(url + path, init); return { status: r.status, body: r.headers.get('content-type')?.includes('json') ? await r.json() : null } }
    out.push({ app, url, api, sync: () => app.engine.tick(1), stop: () => app.stop() })
  }
  return out
}

// ------------------------------------------------------------------ the static build, served like a real host (gzip)
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.woff2': 'font/woff2', '.svg': 'image/svg+xml', '.png': 'image/png' }
export function buildApp({ demo = false } = {}) {
  const out = mkdtempSync(join(tmpdir(), demo ? 'fondaco-demo-' : 'fondaco-prod-'))
  execFileSync(process.execPath, [resolve(APP, 'node_modules/vite/bin/vite.js'), 'build', '--outDir', out, '--emptyOutDir', '--logLevel', 'error'], { cwd: APP, env: { ...process.env, DEMO: demo ? 'true' : '' }, stdio: 'inherit' })
  return out
}
export const files = (dir) => readdirSync(dir).flatMap((f) => { const p = join(dir, f); return statSync(p).isDirectory() ? files(p) : [p] })
/** Serve `dir`; `config` (object) replaces config.json. Compressible types are gzipped when the client accepts it. */
export async function serve(dir, config = null, { delayMs = 0 } = {}) {
  const cache = new Map()
  const web = createServer(async (req, res) => {
    const p = decodeURIComponent(new URL(req.url, 'http://x').pathname)
    if (delayMs) await sleep(delayMs)
    let body, type, version
    if (p === '/config.json' && config) { body = Buffer.from(JSON.stringify(config)); type = TYPES['.json']; version = body.toString() } else {
      const f = join(dir, p === '/' ? 'index.html' : p)
      if (!f.startsWith(dir) || !existsSync(f) || statSync(f).isDirectory()) { res.writeHead(404).end(); return }
      body = readFileSync(f); type = TYPES[extname(f)] ?? 'application/octet-stream'; version = String(statSync(f).mtimeMs)
    }
    const gz = /gzip/.test(req.headers['accept-encoding'] ?? '') && !/woff2|png/.test(type)
    if (gz) { const k = p + '|' + version; if (!cache.has(k)) cache.set(k, gzipSync(body, { level: 9 })); body = cache.get(k) }
    res.writeHead(200, { 'content-type': type, 'cache-control': p.startsWith('/assets/') ? 'public, max-age=31536000, immutable' : 'no-cache', ...(gz ? { 'content-encoding': 'gzip' } : {}), 'content-length': body.length }).end(body)
  })
  await new Promise((r) => web.listen(0, '127.0.0.1', r))
  return { url: `http://127.0.0.1:${web.address().port}/`, close: () => new Promise((r) => web.close(r)) }
}
export function appConfig({ book, swap, rpc = FORK_URL, txTimeoutSec = 300 }) {
  const c = JSON.parse(readFileSync(resolve(APP, 'public/config.json'), 'utf8'))
  c.book = book; c.chains['1'].rpc = rpc; c.chains['1'].swap = swap; c.txTimeoutSec = txTimeoutSec
  return c
}

// ------------------------------------------------------------------ browser + injected wallet
let browser = null
export async function launch() { browser ??= await chromium.launch(); return browser }
export async function closeBrowser() { await browser?.close(); browser = null }

/**
 * A page of the app with a wallet for `account`. Returns { page, ctx, wallet, logs }:
 *   wallet.rejectNext('sign' | 'tx')   the next request of that kind fails with 4001 (user rejected)
 *   wallet.setChain(id)                the wallet moves to `id` and emits chainChanged
 *   logs                               console errors/warnings and page errors of this page
 */
export async function session(url, account, { label = 'w', viewport = { width: 1440, height: 900 }, splash = false, connect = true, chainId = 1, rdns = 'test.fondaco.e2e' } = {}) {
  const b = await launch()
  const ctx = await b.newContext({ viewport })
  const state = { account, chainId, reject: { sign: 0, tx: 0 }, sent: [] }
  const logs = []
  await ctx.exposeBinding('__walletRpc', async (_src, method, params) => {
    const err = (code, message) => ({ __error: { code, message } })
    if (method === 'eth_requestAccounts' || method === 'eth_accounts') return [state.account]
    if (method === 'eth_chainId') return '0x' + state.chainId.toString(16)
    if (method === 'wallet_switchEthereumChain') { state.chainId = parseInt(params?.[0]?.chainId, 16); setTimeout(() => emit('chainChanged', '0x' + state.chainId.toString(16)), 0); return null }
    if (/^eth_signTypedData/.test(method) && state.reject.sign > 0) { state.reject.sign--; return err(4001, 'User rejected the request.') }
    if (method === 'eth_sendTransaction') {
      if (state.reject.tx > 0) { state.reject.tx--; return err(4001, 'User rejected the request.') }
      state.sent.push(params?.[0])
    }
    try { return await pub.request({ method, params }) } catch (e) { return err(e?.code ?? -32603, e?.details ?? e?.shortMessage ?? String(e)) }
  })
  await ctx.addInitScript(({ label, splash, rdns }) => {
    if (!splash) try { sessionStorage.setItem('fondaco-splash', '1') } catch {}
    const listeners = {}
    const provider = {
      async request({ method, params }) { const r = await window.__walletRpc(method, params ?? []); if (r && typeof r === 'object' && r.__error) { const e = new Error(r.__error.message); e.code = r.__error.code; throw e } return r },
      on(ev, f) { (listeners[ev] ??= []).push(f) }, removeListener(ev, f) { listeners[ev] = (listeners[ev] ?? []).filter((x) => x !== f) },
    }
    window.__walletEmit = (ev, arg) => { for (const f of listeners[ev] ?? []) f(arg) }
    const info = { uuid: 'e2e-' + label, name: 'Wallet di test (' + label + ')', icon: 'data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22/%3E', rdns }
    const announce = () => window.dispatchEvent(new CustomEvent('eip6963:announceProvider', { detail: Object.freeze({ info, provider }) }))
    window.addEventListener('eip6963:requestProvider', announce)
    announce()
  }, { label, splash, rdns })
  const page = await ctx.newPage()
  page.on('pageerror', (e) => logs.push({ type: 'pageerror', text: e.message }))
  page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') logs.push({ type: m.type(), text: m.text(), url: m.location()?.url ?? '' }) })
  const emit = (ev, arg) => page.evaluate(([e, a]) => window.__walletEmit?.(e, a), [ev, arg]).catch(() => {})
  const wallet = {
    state,
    rejectNext(kind, n = 1) { state.reject[kind] += n },
    async setChain(id) { state.chainId = id; await emit('chainChanged', '0x' + id.toString(16)) },
  }
  await page.goto(url)
  if (connect) await connectWallet(page)
  return { page, ctx, wallet, logs, close: () => ctx.close() }
}
export async function connectWallet(page) {
  await page.waitForSelector('#wal-chip')
  await page.click('#wal-chip')
  await page.locator('#w-list input[name="wsel"]').first().check()
  await until(async () => (await page.textContent('#wal-addr'))?.includes('…'), 15_000, 'wallet connected')
  await page.click('#w-close'); await sleep(350)
}
/** Console entries that are not in `allowed` (regexes): an empty list = a clean console. */
export const unexpectedLogs = (logs, allowed = []) => logs.filter((l) => !allowed.some((re) => re.test(l.text)))

// ------------------------------------------------------------------ app actions
export async function publish(page, { sell = true, amount, price, parts4 = false, counterparty = null, exp = null }) {
  await page.click('[data-m="make"]')
  // give/get: WETH ↔ USDC; the default market gives the base (WETH): switch when buying
  const give = (await page.textContent('#mk-give'))?.includes('WETH')
  if (sell !== !!give) { await page.click('#flip').catch(() => {}) }
  await page.fill('#mk-in', amount)
  await page.click('[data-mode="custom"]')
  await page.fill('#custom-in', price)
  const partial = await page.isChecked('#partial')
  if (partial !== parts4) await page.locator('label[for="partial"]').click()
  if (exp) await page.click(`[data-exp="${exp}"]`)
  if (counterparty) { if (!(await page.isChecked('#mk-private'))) await page.locator('label[for="mk-private"]').click(); await page.fill('#mk-cp', counterparty) }
  await until(async () => !(await page.isDisabled('#publish')), 10_000, 'publish enabled')
  await page.click('#publish')
  const toastOk = async () => /pubblicat/i.test((await page.textContent('#toast-t')) ?? '') && (await page.locator('#toast.show').count()) > 0
  const failed = async () => { const t = (await page.isVisible('#mk-error')) ? (await page.textContent('#mk-error')) ?? '' : ''; return t && !/^Scrivi quanto/.test(t) && !(await page.isDisabled('#publish')) ? t : '' }
  await until(async () => (await toastOk()) || (await failed()), 60_000, 'publish')
  return (await toastOk()) ? null : await failed()
}
/** Fill the swap ticket (pay USDC → receive WETH by default) and open the confirmation, waiting for the verified quote. */
export async function review(page, payAmount) {
  await page.click('[data-m="swap"]')
  await page.fill('#pay-in', payAmount)
  await until(async () => !(await page.isDisabled('#review')), 15_000, 'review enabled')
  await page.click('#review')
  await until(async () => (await page.textContent('#c-qs'))?.trim() === 'Verificato', 20_000, 'verified')
}
export async function confirmAndWait(page, ms = 90_000) {
  await until(async () => !(await page.isDisabled('#c-go')), 10_000, 'go enabled')
  await page.click('#c-go')
  await until(async () => (await page.isVisible('#c-done')) && (await page.textContent('#c-done-h')), ms, 'swap done')
  return { title: (await page.textContent('#c-done-h'))?.trim(), sub: (await page.textContent('#c-done-sub'))?.trim(), lines: (await page.textContent('#c-done-list'))?.replace(/\s+/g, ' ').trim(), amt: (await page.textContent('#c-done-amt'))?.trim() }
}
export async function offersText(page) {
  const mobile = (page.viewportSize()?.width ?? 1440) < 860
  if (mobile) await page.click('[data-tab="offers"]')
  return ((await page.textContent(mobile ? '#offers-m-list' : '#offers-d')) ?? '').replace(/\s+/g, ' ')
}
