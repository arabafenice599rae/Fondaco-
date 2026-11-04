// Smoke e2e of the web app: anvil fork + our SwapERC20 + TWO book-server instances + the production build served as static
// files + an EIP-6963 wallet injected into the page (it forwards to anvil's unlocked dev accounts: no key anywhere).
//   1. alice publishes an offer from the app (approve + EIP-712 signature + POST), bob buys it from the app, balances exact
//   2. the fill is indexed: /trades and /candles (ETag/304) serve it, the app shows it in "Ultimi scambi"
//   3. a second, non-official book: Impostazioni → other URL → offer published and taken there, invisible on the first one;
//      Ripristina returns to the configured book
// Run by tools/testkit/run-suites.mjs (suite web-e2e), which provides FORK_URL. Screenshots: SHOTS=dir.
import { execFileSync } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdtempSync, readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, extname, resolve } from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { createPublicClient, createTestClient, createWalletClient, http, parseAbi, getAddress, encodeAbiParameters, keccak256, toHex, parseUnits, formatUnits } from 'viem'

const require = createRequire(import.meta.url)
const { chromium } = (() => { try { return require('playwright') } catch { return require('/opt/node-tools/node_modules/playwright') } })()
const HERE = fileURLToPath(new URL('.', import.meta.url))
const APP = resolve(HERE, '..')
const ROOT = resolve(APP, '../..')
const { start } = await import(resolve(ROOT, 'packages/book-server/dist/index.js'))
const SwapArt = JSON.parse(readFileSync(resolve(ROOT, 'packages/contracts/fixtures/SwapERC20.json'), 'utf8'))

const FORK_URL = process.env.FORK_URL || 'http://127.0.0.1:8545'
const USDC = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48'
const WETH = '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2'
const FEE = 30n
const chain = { id: 1, name: 'fork', nativeCurrency: { name: 'ETH', symbol: 'ETH', decimals: 18 }, rpcUrls: { default: { http: [FORK_URL] } } }
const ERC20 = parseAbi(['function balanceOf(address) view returns (uint256)', 'function deposit() payable', 'function allowance(address,address) view returns (uint256)'])
const pub = createPublicClient({ chain, transport: http(FORK_URL, { timeout: 180_000 }) })
const test = createTestClient({ chain, mode: 'anvil', transport: http(FORK_URL, { timeout: 180_000 }) })

const results = []
function check(name, ok, detail = '') { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'} | ${name}${detail ? ' | ' + detail : ''}`) }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
async function until(f, ms = 30_000, what = 'condition') { const t0 = Date.now(); for (;;) { const v = await f(); if (v) return v; if (Date.now() - t0 > ms) throw new Error('timeout: ' + what); await sleep(200) } }
const bal = (t, a) => pub.readContract({ address: t, abi: ERC20, functionName: 'balanceOf', args: [a] })
async function giveUsdc(addr, amount) {
  const slot = keccak256(encodeAbiParameters([{ type: 'address' }, { type: 'uint256' }], [addr, 9n]))
  await test.setStorageAt({ address: USDC, index: slot, value: toHex(amount, { size: 32 }) })
}

// ------------------------------------------------------------------ chain: dev accounts, contract
const [deployer, alice, bob, carol, feeWallet] = (await pub.request({ method: 'eth_accounts' })).slice(0, 5).map((a) => getAddress(a))
const dev = (a) => createWalletClient({ account: a, chain, transport: http(FORK_URL, { timeout: 180_000 }) })
const dh = await dev(deployer).deployContract({ abi: SwapArt.abi, bytecode: SwapArt.bytecode, args: [FEE, FEE, feeWallet, 0n, 0n] })
const drc = await pub.waitForTransactionReceipt({ hash: dh })
const SWAP = getAddress(drc.contractAddress)
for (const w of [alice, carol]) await pub.waitForTransactionReceipt({ hash: await dev(w).writeContract({ address: WETH, abi: ERC20, functionName: 'deposit', value: 10n ** 19n }) })
await giveUsdc(bob, 10_000n * 10n ** 6n)

// ------------------------------------------------------------------ two books (same contract, separate databases)
const bookCfg = () => ({
  port: 0, db: ':memory:', rateLimit: { capacity: 1000, refillPerSec: 100 },
  chains: { 1: { rpc: FORK_URL, swap: SWAP, startBlock: drc.blockNumber.toString(), pollMs: 700, minExpirySec: 60, maxExpirySec: 7 * 86400,
    tokens: { [USDC]: { symbol: 'USDC', decimals: 6 }, [WETH]: { symbol: 'WETH', decimals: 18 } } } },
})
const quiet = { log: () => {} }
const bookA = await start(bookCfg(), quiet), bookB = await start(bookCfg(), quiet)
const A = `http://127.0.0.1:${bookA.server.address().port}`, Bk = `http://127.0.0.1:${bookB.server.address().port}`
const api = async (base, path, headers = {}) => { const r = await fetch(base + path, { headers }); return { status: r.status, etag: r.headers.get('etag'), body: r.status === 304 ? null : await r.json() } }

// ------------------------------------------------------------------ the app: production build + config.json for this fork
const out = mkdtempSync(join(tmpdir(), 'fondaco-web-'))
execFileSync(process.execPath, [resolve(APP, 'node_modules/vite/bin/vite.js'), 'build', '--outDir', out, '--emptyOutDir', '--logLevel', 'error'], { cwd: APP, env: { ...process.env, DEMO: '' }, stdio: 'inherit' })
const appCfg = JSON.parse(readFileSync(resolve(APP, 'public/config.json'), 'utf8'))
appCfg.book = A
appCfg.chains['1'].rpc = FORK_URL
appCfg.chains['1'].swap = SWAP
writeFileSync(join(out, 'config.json'), JSON.stringify(appCfg, null, 2))
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.woff2': 'font/woff2', '.svg': 'image/svg+xml', '.map': 'application/json' }
const web = createServer((req, res) => {
  const p = decodeURIComponent(new URL(req.url, 'http://x').pathname)
  const f = join(out, p === '/' ? 'index.html' : p)
  if (!f.startsWith(out) || !existsSync(f)) { res.writeHead(404).end(); return }
  res.writeHead(200, { 'content-type': TYPES[extname(f)] ?? 'application/octet-stream', 'cache-control': 'no-store' }).end(readFileSync(f))
})
await new Promise((r) => web.listen(0, '127.0.0.1', r))
const URL_APP = `http://127.0.0.1:${web.address().port}/`

// ------------------------------------------------------------------ browser with an injected wallet per account
const browser = await chromium.launch()
const shots = process.env.SHOTS ? resolve(process.env.SHOTS) : null
if (shots) mkdirSync(shots, { recursive: true })
const pageErrors = []
async function session(account, label, viewport = { width: 1440, height: 900 }) {
  const ctx = await browser.newContext({ viewport })
  await ctx.exposeBinding('__walletRpc', async (_src, method, params) => {
    if (method === 'eth_requestAccounts' || method === 'eth_accounts') return [account]
    if (method === 'wallet_switchEthereumChain') return null
    try { return await pub.request({ method, params }) } catch (e) { return { __error: { code: e?.code ?? -32603, message: e?.details ?? e?.shortMessage ?? String(e) } } }
  })
  await ctx.addInitScript(({ label }) => {
    sessionStorage.setItem('fondaco-splash', '1')
    const provider = {
      async request({ method, params }) { const r = await window.__walletRpc(method, params ?? []); if (r && typeof r === 'object' && r.__error) { const e = new Error(r.__error.message); e.code = r.__error.code; throw e } return r },
      on() {}, removeListener() {},
    }
    const info = { uuid: 'e2e-' + label, name: 'Wallet di test (' + label + ')', icon: 'data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22/%3E', rdns: 'test.fondaco.e2e' }
    const announce = () => window.dispatchEvent(new CustomEvent('eip6963:announceProvider', { detail: Object.freeze({ info, provider }) }))
    window.addEventListener('eip6963:requestProvider', announce)
    announce()
  }, { label })
  const page = await ctx.newPage()
  page.on('pageerror', (e) => pageErrors.push(`${label}: ${e.message}`))
  page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') pageErrors.push(`${label} console ${m.type()}: ${m.text()}`) })
  await page.goto(URL_APP)
  await page.waitForSelector('#m-list .mrow, #m-list [data-mkt]', { timeout: 20_000 })
  return page
}
async function connect(page) {
  await page.click('#wal-chip')
  await page.locator('#w-list input[name="wsel"]').first().check()
  await until(async () => (await page.textContent('#wal-addr'))?.includes('…'), 10_000, 'wallet connected')
  await page.click('#w-close'); await sleep(400)
}
async function publishSell(page, amount, price) {
  await page.click('[data-m="make"]')
  await page.fill('#mk-in', amount)
  await page.click('[data-mode="custom"]')
  await page.fill('#custom-in', price)
  if (await page.isChecked('#partial')) await page.click('label:has(#partial), #partial', { force: true }).catch(() => page.uncheck('#partial'))
  if (await page.isChecked('#partial')) await page.uncheck('#partial', { force: true })
  await page.click('#publish')
  // success = the toast; failure = an error shown while the button is idle again (the empty-amount hint after a success is not one)
  const toastOk = async () => /Offerta pubblicata/.test((await page.textContent('#toast-t')) ?? '') && (await page.locator('#toast.show').count()) > 0
  const failed = async () => { const t = (await page.isVisible('#mk-error')) ? (await page.textContent('#mk-error')) ?? '' : ''; return t && !/^Scrivi quanto/.test(t) && !(await page.isDisabled('#publish')) ? t : '' }
  await until(async () => (await toastOk()) || (await failed()), 60_000, 'publish')
  return (await toastOk()) ? null : await failed()
}
let lastConfirm = null
async function buy(page, usdc) {
  await page.click('[data-m="swap"]')
  await until(async () => !(await page.isDisabled('#review').catch(() => true)) || true, 2000)
  await page.fill('#pay-in', usdc)
  await until(async () => !(await page.isDisabled('#review')), 15_000, 'review enabled')
  await page.click('#review')
  await until(async () => !(await page.isDisabled('#c-go')), 20_000, 'confirm ready (verified)')
  lastConfirm = { qs: (await page.textContent('#c-qs'))?.trim(), mev: (await page.textContent('#c-mev'))?.replace(/\s+/g, ' ').trim(), contract: await page.getAttribute('#c-contract', 'title') }
  await page.click('#c-go')
  await until(async () => (await page.isVisible('#c-done')) && (await page.textContent('#c-done-h')), 90_000, 'swap done')
  return (await page.textContent('#c-done-h'))?.trim()
}
const shot = async (page, name) => { if (shots) await page.screenshot({ path: join(shots, name + '.png') }) }

try {
  // ================================================================ 1. publish on the official book, buy from a second account
  const pa = await session(alice, 'alice')
  check('W0: app loads with markets from /config of the configured book', (await pa.locator('#m-list [data-mkt]').count()) === 1, 'WETH/USDC')
  await connect(pa)
  const fee0 = await bal(WETH, feeWallet)
  const aW0 = await bal(WETH, alice), aU0 = await bal(USDC, alice), bW0 = await bal(WETH, bob), bU0 = await bal(USDC, bob)
  const err1 = await publishSell(pa, '0,5', '2500')
  const bookA1 = (await api(A, `/book?chainId=1&base=${WETH}&quote=${USDC}`)).body
  const ask = bookA1.asks?.[0]
  check('W1: offer published from the app (approve exact + EIP-712 + POST) and open on the book', !err1 && bookA1.asks.length === 1 && ask.price === 2500 && ask.baseAmount === String(5n * 10n ** 17n),
    err1 ?? `ask ${ask?.price} × ${ask && formatUnits(BigInt(ask.baseAmount), 18)} WETH`)
  const allowA = await pub.readContract({ address: WETH, abi: ERC20, functionName: 'allowance', args: [alice, SWAP] })
  check('W2: maker approval is exact (amount + fee), not unlimited', allowA === 5n * 10n ** 17n + (5n * 10n ** 17n * FEE) / 10_000n, formatUnits(allowA, 18) + ' WETH')
  await shot(pa, 'e2e-maker-offer')

  const pb = await session(bob, 'bob')
  await connect(pb)
  await until(async () => (await pb.locator('#asks .lvl').count()) > 0, 15_000, 'book visible to bob')
  const done = await buy(pb, '1250')
  await shot(pb, 'e2e-taker-done')
  const aW1 = await bal(WETH, alice), aU1 = await bal(USDC, alice), bW1 = await bal(WETH, bob), bU1 = await bal(USDC, bob)
  const feeW = (5n * 10n ** 17n * FEE) / 10_000n
  check('W3: bob bought it from the app: done screen', done === 'Scambio completato', done)
  check('W3b: confirmation showed the verified quote, the real MEV status of this wallet and the app’s own contract',
    lastConfirm.qs === 'Verificato' && /Mempool pubblica/.test(lastConfirm.mev) && lastConfirm.contract === SWAP, `${lastConfirm.qs} · MEV "${lastConfirm.mev}" · ${lastConfirm.contract}`)
  check('W4: balances exact — bob +0,5 WETH −1250 USDC; alice +1250 USDC −(0,5 + fee) WETH',
    bW1 - bW0 === 5n * 10n ** 17n && bU0 - bU1 === 1250n * 10n ** 6n && aU1 - aU0 === 1250n * 10n ** 6n && aW0 - aW1 === 5n * 10n ** 17n + feeW,
    `bob ΔWETH ${formatUnits(bW1 - bW0, 18)}, ΔUSDC −${formatUnits(bU0 - bU1, 6)}; alice ΔUSDC ${formatUnits(aU1 - aU0, 6)}, ΔWETH −${formatUnits(aW0 - aW1, 18)}`)
  const feeBal = (await bal(WETH, feeWallet)) - fee0
  check('W5: protocol fee paid by the signer, in the signer token, to the fee wallet', feeBal === feeW, formatUnits(feeBal, 18) + ' WETH')

  // ================================================================ 2. indexed fill → /trades, /candles with ETag, app shows it
  const tr = await until(async () => { const r = await api(A, `/trades?chainId=1&base=${WETH}&quote=${USDC}`); return r.body?.trades?.length ? r.body.trades : null }, 20_000, 'trade indexed')
  check('W6: fill indexed on the book (/trades)', tr.length === 1 && tr[0].price === 2500 && tr[0].side === 'buy', JSON.stringify(tr[0]).slice(0, 120))
  const c1 = await api(A, `/candles?chainId=1&base=${WETH}&quote=${USDC}`)
  const c2 = await api(A, `/candles?chainId=1&base=${WETH}&quote=${USDC}`, { 'if-none-match': c1.etag })
  check('W7: /candles has the candle, ETag revalidates with 304', c1.status === 200 && c1.body.candles.length === 1 && c1.body.candles[0].c === 2500 && c2.status === 304, `etag ${c1.etag}`)
  await pb.reload(); await pb.waitForSelector('#m-list [data-mkt]')
  await until(async () => (await pb.textContent('#trades'))?.includes('2.500'), 20_000, 'trade in the app')
  check('W8: app shows the fill in Ultimi scambi and the chart is drawn', (await pb.textContent('#trades')).includes('2.500') && (await pb.locator('#ch-svg path').count()) > 0)
  await until(async () => { await pa.click('[data-tab="offers"]').catch(() => {}); return (await pa.textContent('#offers-d, #offers-m-list'))?.length > 0 }, 5000).catch(() => {})
  const offersTxt = (await pa.textContent('#offers-d')) + (await pa.textContent('#offers-m-list'))
  check('W9: maker sees no live offer left (filled, moved to history)', /Attive · 0/.test(offersTxt) && /Nessuna offerta attiva/.test(offersTxt), offersTxt.replace(/\s+/g, ' ').slice(0, 100))

  // ================================================================ 3. a different, non-official book
  const pc = await session(carol, 'carol')
  const toBook = async (page, url) => {
    await page.click('#set-chip'); await page.fill('#s-book', url); await page.click('#s-save')
    await page.waitForLoadState('load'); await page.waitForSelector('#m-list [data-mkt]', { timeout: 20_000 })
  }
  await toBook(pc, Bk)
  await connect(pc)
  await pc.click('#set-chip')
  const origin = await pc.textContent('#s-origin'); await pc.click('#s-close'); await sleep(400)
  check('W10: Impostazioni → other book URL, persisted in the browser, marked as custom', /personalizzate/.test(origin), origin)
  const err2 = await publishSell(pc, '0,2', '2400')
  const onB = (await api(Bk, `/book?chainId=1&base=${WETH}&quote=${USDC}`)).body, onA = (await api(A, `/book?chainId=1&base=${WETH}&quote=${USDC}`)).body
  check('W11: offer published on the second book only', !err2 && onB.asks.length === 1 && onB.asks[0].price === 2400 && onA.asks.length === 0, err2 ?? `book B asks ${onB.asks.length}, book A asks ${onA.asks.length}`)
  await toBook(pb, Bk)
  await connect(pb)
  const cU0 = await bal(USDC, carol), bW2 = await bal(WETH, bob)
  const done2 = await buy(pb, '480')
  const cU1 = await bal(USDC, carol), bW3 = await bal(WETH, bob)
  check('W12: bought on the second book from the app, balances exact', done2 === 'Scambio completato' && cU1 - cU0 === 480n * 10n ** 6n && bW3 - bW2 === 2n * 10n ** 17n,
    `carol ΔUSDC ${formatUnits(cU1 - cU0, 6)}, bob ΔWETH ${formatUnits(bW3 - bW2, 18)}`)
  await pb.click('#c-done-btn').catch(() => {})
  await pb.click('#set-chip'); await pb.click('#s-reset'); await pb.waitForLoadState('load'); await pb.waitForSelector('#m-list [data-mkt]')
  await pb.click('#set-chip')
  const back = await pb.textContent('#s-origin'), field = await pb.inputValue('#s-book')
  check('W13: Ripristina returns to the configured book', /predefinite/.test(back) && field === '' && back.includes(A), back)
  await pb.click('#s-close')

  // ================================================================ governance: the owner changes protocolFeeLight on-chain
  await pub.waitForTransactionReceipt({ hash: await dev(deployer).writeContract({ address: SWAP, abi: parseAbi(['function setProtocolFeeLight(uint256)']), functionName: 'setProtocolFeeLight', args: [7n] }) })
  const gov = await until(async () => { const t = await pb.textContent('#banners'); return /Parametri del contratto modificati/.test(t) ? t : null }, 20_000, 'governance banner').catch(() => '')
  const cfgA = (await api(A, '/config')).body[1]
  check('W14: on-chain SetProtocolFeeLight → SSE governance event → banner in the open app; /config shows feeLight ≠ fee', /Parametri del contratto modificati/.test(gov) && cfgA.protocolFeeLight === '7' && cfgA.protocolFee === '30', gov.replace(/\s+/g, ' ').slice(0, 110))
  await shot(pb, 'e2e-governance-banner')

  const errorsBeforeStale = pageErrors.slice()

  // ================================================================ 4. stale book → banner and swap blocked
  const prevMax = bookA.engine.chain(1).cfg.maxStalenessMs
  bookA.engine.chain(1).cfg.maxStalenessMs = 1
  await sleep(50)
  await pb.reload(); await pb.waitForSelector('#m-list [data-mkt]')
  await until(async () => (await pb.textContent('#banners'))?.includes('Dati non aggiornati'), 20_000, 'stale banner').catch(() => null)
  const banner = await pb.textContent('#banners')
  await pb.fill('#pay-in', '10')
  await shot(pb, 'e2e-stale-banner')
  check('W15: 503 stale → "Dati non aggiornati" banner and the swap button blocked', banner.includes('Dati non aggiornati') && (await pb.isDisabled('#review')), banner.replace(/\s+/g, ' ').slice(0, 90))
  bookA.engine.chain(1).cfg.maxStalenessMs = prevMax

  // the 503 of the stale phase is logged by the browser as a failed resource: expected, everything else is an error
  const unexpected = errorsBeforeStale.concat(pageErrors.slice(errorsBeforeStale.length).filter((e) => !/status of 503/.test(e)))
  check('W16: no page errors in any session', unexpected.length === 0, unexpected.slice(0, 3).join(' | '))
} catch (e) {
  console.error(e)
  check('W!: unexpected error', false, String(e?.message ?? e))
} finally {
  await browser.close()
  web.close(); await bookA.stop?.(); await bookB.stop?.()
}
const passed = results.filter(Boolean).length
console.log(`\n${passed}/${results.length} checks passed`)
process.exit(passed === results.length ? 0 : 1)
