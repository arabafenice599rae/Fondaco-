// Unit tests of the app's state logic (no DOM, no chain): the TS sources are bundled once with Vite (library mode) into
// a temp dir and imported. Covers: indicative/verified quote, offer states, exact ladder terms, float→units, chart series,
// banners (contract mismatch, governance), config + settings, the book API client (stale 503, ETag, SSE reconnection).
import { build } from 'vite'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const APP = resolve(fileURLToPath(new URL('.', import.meta.url)), '..')
const out = mkdtempSync(join(tmpdir(), 'fondaco-web-unit-'))
const entry = join(out, 'entry.ts')
writeFileSync(entry, ['model', 'config', 'api', 'fmt'].map((m) => `export * from ${JSON.stringify(resolve(APP, 'src', m + '.ts'))}`).join('\n'))
await build({ configFile: false, logLevel: 'error', root: APP, build: { outDir: out, emptyOutDir: false, lib: { entry, formats: ['es'], fileName: 'bundle' }, minify: false } })
const M = await import(pathToFileURL(join(out, 'bundle.js')).href)

const results = []
const check = (n, ok, d = '') => { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'} | ${n}${d ? ' | ' + d : ''}`) }

// ------------------------------------------------------------------ fixtures
const WETH = { address: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2', symbol: 'WETH', decimals: 18, name: 'Wrapped Ether', stable: false }
const USDC = { address: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', symbol: 'USDC', decimals: 6, name: 'USD Coin', stable: true }
const mkt = { id: 'WETH-USDC', base: WETH, quote: USDC }
const ME = '0x1111111111111111111111111111111111111111', OTHER = '0x2222222222222222222222222222222222222222'
const ZERO = '0x0000000000000000000000000000000000000000'
let n = 1
/** ask: signer gives `base` WETH for `base × price` USDC */
const askE = (price, base, signer = OTHER) => {
  const b = M.toUnits(base, 18), q = M.toUnits(base * price, 6)
  return { hash: '0x' + (n++).toString(16).padStart(64, '0'), price, baseAmount: String(b), quoteAmount: String(q), expiry: 2e9, signer,
    order: { nonce: String(n), expiry: '2000000000', signerWallet: signer, signerToken: WETH.address, signerAmount: String(b), protocolFee: '30', senderWallet: ZERO, senderToken: USDC.address, senderAmount: String(q), v: 27, r: '0x' + '1'.repeat(64), s: '0x' + '2'.repeat(64) } }
}

// ------------------------------------------------------------------ U1–U3 indicative quote
{
  const book = { asks: [askE(2500, 0.2), askE(2500, 0.2, ME), askE(2510, 0.5), askE(2520, 0.1)], bids: [] }
  const q = M.quoteSwap(mkt, book, true, 800, ME)
  check('U1: indicative quote takes whole orders best-first, skips what does not fit, never my own', q.plan.legs.length === 2 && q.orders === 2 && Math.abs(q.spent - 752) < 1e-9 && Math.abs(q.got - 0.3) < 1e-12 && q.legs.map((l) => l.p).join() === '2500,2520',
    `legs at ${q.legs.map((l) => l.p)}; spent ${q.spent} got ${q.got}; left ${q.left}`)
  check('U2: liquidity and smallest order exclude my own orders', Math.abs(q.liq - (500 + 1255 + 252)) < 1e-6 && q.smallest === 252, `liq ${q.liq}, smallest ${q.smallest}`)
  const z = M.quoteSwap(mkt, book, true, 0, ME)
  check('U3: zero amount → empty plan, no legs', z.plan === null && z.orders === 0 && z.left === 0)
}

// ------------------------------------------------------------------ U4–U7 verified quote state and per-order state
{
  const ind = M.quoteState(null, 3)
  check('U4: before verify the quote is "Indicativo" and the swap button is disabled', ind.cls === 'ind' && ind.label === 'Indicativo' && ind.go.disabled)
  const base = { kind: 'verified', ok: true, block: 23700000n, legs: [{}, {}], dropped: [], pay: 1n, receive: 1n, left: 0n, problems: [], needsApproval: true }
  const v1 = M.quoteState(base, 2, (b) => b.toString())
  check('U5: verified, all valid, approval needed → "Verificato", block shown, "Autorizza e scambia"', v1.cls === 'ok' && v1.label === 'Verificato' && v1.text === 'Importi definitivi · blocco #23700000' && v1.go.label === 'Autorizza e scambia' && !v1.go.disabled && v1.verifyStep.text === 'Tutte le offerte sono valide')
  const v2 = M.quoteState({ ...base, legs: [{}], dropped: [{ hash: 'x' }], needsApproval: false }, 2)
  check('U6: verified with a dropped offer → amounts updated, "1 offerte su 2 ancora valide", plain "Scambia"', /^1 offerta non è più disponibile: importi aggiornati/.test(v2.text) && v2.verifyStep.text === '1 offerte su 2 ancora valide' && v2.go.label === 'Scambia', v2.text)
  const v3 = M.quoteState({ ...base, ok: false, problems: ['taker_balance'] }, 2), v4 = M.quoteState({ ...base, ok: false, legs: [], problems: ['empty'] }, 2)
  check('U7: not executable → button disabled with the reason (balance / no offer left)', v3.go.disabled && v3.go.label === 'Non eseguibile' && v3.verifyStep.text === 'Saldo insufficiente' && v4.verifyStep.text === 'Nessuna offerta ancora valida')
  const ctx = { leg: 0, of: 1, orderHash: '0xab' }
  const map = [['simulating', 'verify'], ['awaiting_signature', 'sign'], ['filled', 'done'], ['failed', 'failed']].map(([type, want]) => M.legStatus({ type, ...ctx }) === want)
  check('U8: execute events → order states (verify, sign, pending, done, skipped, dropped when not included, failed)', map.every(Boolean) &&
    M.legStatus({ type: 'pending', hash: '0x1', private: true, ...ctx }) === 'pending' && M.legStatus({ type: 'pending', hash: '0x1', private: false, step: 'approve' }) === undefined &&
    M.legStatus({ type: 'skipped', reason: 'taken', message: '', ...ctx }) === 'skipped' && M.legStatus({ type: 'skipped', reason: 'not_included', message: '', ...ctx }) === 'dropped' && M.legStatus({ type: 'done', result: {} }) === undefined)
}

// ------------------------------------------------------------------ U9–U13 my offers: states
{
  const now = 1_800_000_000
  const order = (status, { nonce = String(n++), exp = now + 3600, price = 2500, base = 0.1, side = 'sell', exec = status !== 'filled' && status !== 'cancelled' && status !== 'expired' } = {}) => {
    const b = M.toUnits(base, 18), q = M.toUnits(base * price, 6)
    return { hash: '0x' + nonce, chainId: 1, status, executableOnChain: exec, createdAt: 1, updatedAt: 2,
      order: { nonce, expiry: String(exp), signerWallet: ME, signerToken: side === 'sell' ? WETH.address : USDC.address, signerAmount: String(side === 'sell' ? b : q), senderToken: side === 'sell' ? USDC.address : WETH.address, senderAmount: String(side === 'sell' ? q : b), protocolFee: '30', senderWallet: ZERO } }
  }
  const g = (os, mid = 2500) => M.groupOffers(os, [mkt], { 'WETH-USDC': mid }, now)
  const a = g([order('open'), order('open'), order('filled'), order('filled')])
  check('U9: a 4-part ladder, 2 filled → one "active" offer, 2/4 filled, cancel covers the 2 open parts only', a.live.length === 1 && a.live[0].status === 'active' && a.live[0].parts === 4 && a.live[0].filled === 2 && a.live[0].cancelNonces.length === 2)
  const p = g([order('open', { price: 2400 }), order('unfunded', { price: 2400 })])
  check('U10: an unfunded part → "paused"; the cancel still includes it (it can be revived by funds)', p.live[0].status === 'paused' && p.live[0].funded === 1 && p.live[0].cancelNonces.length === 2)
  const r = g([order('invalid_fee', { price: 2300 })])
  check('U11: fee changed → "resign"', r.live[0].status === 'resign')
  const e = g([order('invalid_signer', { price: 2200, exec: true }), order('open', { price: 2200 })])
  const e2 = g([order('invalid_signer', { price: 2100, exec: false })])
  check('U12: invalid_signer still executable on-chain → "exec" (annulla ora), its nonce in the cancel; not executable → history only',
    e.live[0].status === 'exec' && e.live[0].cancelNonces.length === 2 && e2.live.length === 0, `exec cancel ${e.live[0]?.cancelNonces.length}`)
  const h = g([order('filled', { price: 2000, base: 0.25 }), order('cancelled', { price: 1900 }), order('open', { price: 1800, exp: now - 1 })])
  check('U13: dead groups go to history: sold, cancelled, expired (expiry ≤ chain time)', h.live.length === 0 && h.history.length === 3 && h.history.some((x) => /^Venduti 0,25 WETH/.test(x.t)) && h.history.some((x) => /^Annullata/.test(x.t)) && h.history.some((x) => /^Scaduta/.test(x.t)), h.history.map((x) => x.t).join(' | '))
  // stale = the market moved past my price: a sell ≥ 1 % BELOW the mid is now a gift (client isStale, inclusive)
  const st = g([order('open', { price: 2475 })], 2500), notSt = g([order('open', { price: 2480 })], 2500), above = g([order('open', { price: 2600 })], 2500)
  check('U14: an active sell offer ≥ 1 % below the market is flagged stale; 0,8 % below or above the market is not', st.live[0].stale === true && notSt.live[0].stale === false && above.live[0].stale === false)
}

// ------------------------------------------------------------------ U15–U18 exact terms and float→units
{
  check('U15: toUnits uses the shortest decimal form (0.2 → exactly 2e17, 1e-7, 2498.12, 1e21)', M.toUnits(0.2, 18) === 2n * 10n ** 17n && M.toUnits(1e-7, 18) === 10n ** 11n && M.toUnits(2498.12, 6) === 2_498_120_000n && M.toUnits(1e21, 6) === 10n ** 27n && M.toUnits(0.1 + 0.2, 6) === 300_000n,
    `0.2 → ${M.toUnits(0.2, 18)}; plain(1e-7) = ${M.plainDecimal(1e-7)}; plain(1.5e21) = ${M.plainDecimal(1.5e21)}`)
  const t1 = M.ladderTerms(mkt, true, 0.2, 2400, 1)
  check('U16: sell 0,2 WETH at 2400 → exactly 2e17 WETH for 480 USDC', t1.length === 1 && t1[0].signerAmount === 2n * 10n ** 17n && t1[0].senderAmount === 480_000_000n && t1[0].signerToken === WETH.address)
  const t4 = M.ladderTerms(mkt, true, 1, 2498.12, 3)
  const sum = t4.reduce((s, t) => s + t.signerAmount, 0n)
  check('U17: ladder in 3 parts: slices sum exactly to the amount, the last takes the remainder, price exact (2498.12 not 2498.1199…)', sum === 10n ** 18n && t4[2].signerAmount === 10n ** 18n - 2n * (10n ** 18n / 3n) && t4[0].senderAmount === (333333333333333333n * 249812n) / (100n * 10n ** 12n),
    t4.map((t) => `${t.signerAmount}→${t.senderAmount}`).join(', '))
  const tb = M.ladderTerms(mkt, false, 1000, 2500.5, 1)
  check('U18: buy: the base asked is rounded DOWN (never more than the written price allows)', tb[0].signerToken === USDC.address && tb[0].senderAmount === (1000_000_000n * 10n * 10n ** 18n) / (25005n * 10n ** 6n) && Number(tb[0].senderAmount) / 1e18 <= 1000 / 2500.5,
    `${tb[0].senderAmount} wei WETH`)
  check('U19: fee of the signer = amount × fee / 10 000 (0,30 % of 0,5 WETH = 0,0015)', M.feeOf(5n * 10n ** 17n, 30n) === 15n * 10n ** 14n)
}

// ------------------------------------------------------------------ U20–U22 chart series and stats
{
  const r = { interval: 300, from: 1000 * 300, to: 1003 * 300, now: 1003 * 300 + 10, prev: 2400, candles: [{ t: 1001 * 300, o: 2400, h: 2520, l: 2390, c: 2500, v: 1, vq: 2500, n: 2 }, { t: 1003 * 300, o: 2500, h: 2510, l: 2450, c: 2460, v: 1, vq: 2460, n: 1 }] }
  const s = M.series(r), st = M.stats(r)
  check('U20: series is forward-filled from prev, one point per bucket, ms timestamps', s.map((x) => x.p).join() === '2400,2500,2500,2460' && s[0].t === 1000 * 300 * 1000)
  check('U21: 24 h stats: change vs prev, high/low from candles, volume and trade count', Math.abs(st.change - (2460 / 2400 - 1)) < 1e-12 && st.hi === 2520 && st.lo === 2390 && st.volQuote === 4960 && st.trades === 3)
  check('U22: no trade ever → empty series and null stats (empty state, nothing invented)', M.series({ ...r, prev: null, candles: [] }).length === 0 && M.stats({ ...r, prev: null, candles: [] }).last === null)
}

// ------------------------------------------------------------------ U23–U24 banners
{
  const S1 = '0x' + 'a'.repeat(40), S2 = '0x' + 'b'.repeat(40)
  const same = M.chainNotice(S1, { swap: S1, protocolFee: '30', protocolFeeLight: '30' })
  const mis = M.chainNotice(S1, { swap: S2, protocolFee: '30', protocolFeeLight: '30' })
  const gov = M.chainNotice(S1, { swap: S1.toUpperCase().replace('0X', '0x'), protocolFee: '30', protocolFeeLight: '7' })
  const nd = M.chainNotice(null, { swap: S1 })
  check('U23: contract mismatch (case-insensitive compare) and not-deployed are detected', !same.contractMismatch && !same.notDeployed && mis.contractMismatch && !gov.contractMismatch && nd.notDeployed && !nd.contractMismatch)
  check('U24: governance banner when protocolFeeLight ≠ protocolFee', gov.feeLightDiffers && !same.feeLightDiffers)
  const lv = M.levels([askE(2500, 0.1), askE(2500, 0.2), askE(2500, 0.3, ME), askE(2510, 0.1)], WETH, ME)
  check('U25: book levels group equal prices, own orders as a separate flagged level, cumulative-ready sizes', lv.length === 3 && Math.abs(lv[0].q - 0.3) < 1e-12 && lv[1].own && !lv[0].own && M.midOf(lv, [{ p: 2490, q: 1, entries: [], own: false }]) === 2495)
}

// ------------------------------------------------------------------ U26–U30 config and settings
{
  const raw = { book: 'https://book.example/', defaultChain: 1, chains: { 1: { name: 'Ethereum', rpc: '', swap: null, tokens: { [USDC.address.toLowerCase()]: { symbol: 'USDC', decimals: 6 } } } } }
  const cfg = M.parseAppConfig(raw)
  check('U26: config.json normalized (trailing slash, checksum, stable flag)', cfg.book === 'https://book.example' && cfg.chains[1].tokens[USDC.address].stable === true && cfg.chains[1].swap === null)
  let err = ''
  try { M.parseAppConfig({ book: 'ftp://x', defaultChain: 5, chains: { 1: { swap: 'nope', tokens: { '0x12': {} } } } }) } catch (e) { err = e.message }
  check('U27: invalid config → every problem listed at once', ['book:', 'swap: not an address', 'not an address', 'defaultChain 5'].every((s) => err.includes(s)), err.split('\n').length - 1 + ' problems')
  const S1 = '0x' + 'c'.repeat(40)
  const eff = M.effective(cfg, { book: 'http://127.0.0.1:9000/', chains: { 1: { rpc: 'https://rpc.example', swap: S1 } } })
  check('U28: settings override book, RPC and (if stored) contract, each flagged as overridden', eff.book === 'http://127.0.0.1:9000' && eff.overridden.book && eff.chains[1].rpc === 'https://rpc.example' && eff.overridden.rpc[1] && eff.chains[1].swap.toLowerCase() === S1 && eff.overridden.swap[1])
  const bad = M.effective(cfg, { book: 'javascript:alert(1)', chains: { 1: { rpc: 'file:///etc', swap: 'x' } } })
  check('U29: invalid overrides are ignored (never a javascript:/file: URL, never a non-address contract)', bad.book === cfg.book && bad.chains[1].rpc === '' && bad.chains[1].swap === null && !bad.overridden.book)
  check('U30: validateSettings reports the problems in Italian', M.validateSettings({ book: 'x', chains: { 1: { rpc: 'y', swap: 'z' } } }, cfg).length === 3)
  const mem = new Map(), store = { getItem: (k) => mem.get(k) ?? null, setItem: (k, v) => mem.set(k, v), removeItem: (k) => mem.delete(k) }
  M.writeSettings(store, { book: 'https://other.example' })
  const back = M.readSettings(store); M.clearSettings(store)
  check('U31: settings persisted under fondaco-settings; Ripristina clears them; corrupt storage reads as {}', back.book === 'https://other.example' && M.readSettings(store).book === undefined && mem.size === 0 &&
    M.readSettings({ getItem: () => '{broken', setItem() {}, removeItem() {} }) && Object.keys(M.readSettings({ getItem: () => '[1]', setItem() {}, removeItem() {} })).length === 0 && M.SETTINGS_KEY === 'fondaco-settings')
}

// ------------------------------------------------------------------ U32–U35 book API client
{
  const calls = []
  const res = (status, body, headers = {}) => new Response(body == null ? null : JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } })
  let mode = 'ok'
  const fake = async (url, init) => {
    calls.push({ url, h: init?.headers ?? {} })
    if (mode === 'stale') return res(503, { error: 'stale', message: 'chain 1 not verified for 130 s' })
    if (mode === 'down') throw new TypeError('fetch failed')
    if (init?.headers?.['if-none-match'] === 'W/"b1"') return new Response(null, { status: 304 })
    return res(200, { asks: [{ hash: 'a' }], bids: [] }, { etag: 'W/"b1"' })
  }
  const api = new M.BookApi('http://book', fake)
  const b1 = await api.book(1, 'B', 'Q'), b2 = await api.book(1, 'B', 'Q')
  check('U32: /book with ETag: second call revalidates (If-None-Match) and a 304 serves the cached body', b1.status === 'ok' && b2.status === 'ok' && b2.asks[0].hash === 'a' && calls[1].h['if-none-match'] === 'W/"b1"')
  mode = 'stale'; const b3 = await api.book(1, 'B', 'Q')
  mode = 'down'; const b4 = await api.book(1, 'B', 'Q')
  check('U33: 503 stale → status "stale" (never cached data); network down → "error", no throw', b3.status === 'stale' && /130 s/.test(b3.message) && b4.status === 'error')

  // SSE: a fake EventSource that fails twice, then opens; backoff 1 s → 2 s, state reported each time
  const timers = []
  const realST = globalThis.setTimeout
  globalThis.setTimeout = (f, ms) => { timers.push(ms); return realST(f, 0) }
  let made = 0
  class FakeES { constructor(url) { this.url = url; made++; const k = made; this.l = {}; realST(() => (k <= 2 ? this.onerror?.() : this.onopen?.()), 0); if (k === 3) realST(() => this.l.trade?.({ data: '{"chainId":1,"price":2500}' }), 5) } addEventListener(t, f) { this.l[t] = f } close() {} }
  const states = [], events = []
  const stop = api.stream((e) => events.push(e), (up) => states.push(up), FakeES)
  await new Promise((r) => realST(r, 60))
  stop(); globalThis.setTimeout = realST
  check('U34: SSE reconnects with exponential backoff (1 s, 2 s) and reports down/up; events parsed', made === 3 && timers.slice(0, 2).join() === '1000,2000' && states.join() === 'false,false,true' && events[0]?.type === 'trade' && events[0].data.price === 2500,
    `connections ${made}, delays ${timers.slice(0, 2)}, states ${states}`)
  const posted = []
  const api2 = new M.BookApi('http://book', async (url, init) => { posted.push(JSON.parse(init.body)); return res(400, { error: 'bad_request', message: 'chainId mancante' }) })
  const sub = await api2.submit(1, [{}, {}])
  check('U35: a rejected batch gives one error per order (the UI can say which and why)', sub.length === 2 && sub.every((x) => x.error === 'bad_request' && x.message === 'chainId mancante') && posted[0].chainId === 1)
}

const passed = results.filter(Boolean).length
console.log(`\n${passed}/${results.length} checks passed`)
process.exit(passed === results.length ? 0 : 1)
