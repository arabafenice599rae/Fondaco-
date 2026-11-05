// Simulated backend, loaded ONLY in a DEMO=true build (dynamic import from main.ts; absent from the production bundle).
// Same markets, levels and offers as the prototype; every value is invented and the "Demo" label stays visible.
// No network, no wallet, no signatures: fills are applied to the in-memory book.
import { getAddress, parseUnits, formatUnits, type Address, type Hex } from 'viem'
import { protectionStatus, type DiscoveredWallet, type ExecuteResult, type IndicativeQuote, type ProtectionStatus, type TakerEvent, type VerifiedQuote } from '@fondaco/client'
import type { Backend, Notice, PublishResult, TakerLike } from './backend.js'
import type { Trade } from './api.js'
import type { BookEntry, Candle, CandleResponse, Market, MyOrder, OrderTerms } from './model.js'
import type { Effective } from './config.js'
import type { TokenView } from './tokens.js'
import { roundP, qdec } from './fmt.js'

let seed = 20261030
const rnd = () => { seed = (seed + 0x6D2B79F5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296 }
const hex = (n: number) => '0x' + Array.from({ length: n }, () => Math.floor(rnd() * 16).toString(16)).join('')
const fakeAddr = (i: number) => getAddress('0x' + 'de' + '0'.repeat(34) + i.toString(16).padStart(4, '0'))
const ZERO = '0x0000000000000000000000000000000000000000'
const ME: Address = getAddress('0xde000000000000000000000000000000000d3e00')
const FEE = 30n // as configured on the real deployment (spec v1.1)

const TOK: Record<string, { name: string; dec: number; usd: number; stable: boolean }> = {
  WETH: { name: 'Wrapped Ether', dec: 18, usd: 2490, stable: false },
  WBTC: { name: 'Wrapped Bitcoin', dec: 8, usd: 67400, stable: false },
  USDC: { name: 'USD Coin', dec: 6, usd: 1, stable: true },
  USDT: { name: 'Tether USD', dec: 6, usd: 1, stable: true },
  DAI: { name: 'Dai', dec: 18, usd: 1, stable: true },
  LINK: { name: 'Chainlink', dec: 18, usd: 14.2, stable: false },
  UNI: { name: 'Uniswap', dec: 18, usd: 8.1, stable: false },
  ARB: { name: 'Arbitrum', dec: 18, usd: 0.82, stable: false },
}
const PAIRS: [string, string][] = [['WETH', 'USDC'], ['WETH', 'USDT'], ['WBTC', 'USDC'], ['WBTC', 'WETH'], ['LINK', 'USDC'], ['LINK', 'WETH'], ['UNI', 'USDC'], ['ARB', 'USDC'], ['DAI', 'USDC'], ['USDT', 'USDC']]
const BAL: Record<string, number> = { WETH: 3.2, WBTC: 0.15, USDC: 12400, USDT: 3000, DAI: 800, LINK: 120, UNI: 60, ARB: 2500 }
const tokens: Record<string, TokenView> = Object.fromEntries(Object.entries(TOK).map(([s, t], i) => [s, { address: fakeAddr(i + 1), symbol: s, decimals: t.dec, name: t.name, stable: t.stable }]))
const bySym = (s: string) => tokens[s] as TokenView
const roundQ = (sym: string, q: number) => { const k = 10 ** qdec(sym); return Math.max(1 / k, Math.round(q * k) / k) }
const u = (v: number, d: number) => parseUnits(v.toFixed(Math.min(d, 12)), d)

interface Sim { m: Market; asks: BookEntry[]; bids: BookEntry[]; trades: Trade[]; candles: Candle[]; prev: number }

export class DemoBackend implements Backend {
  readonly demo = true
  private sims: Sim[] = []
  private my: MyOrder[] = []
  private bal: Record<Address, { balance: bigint; allowance: bigint }> = {}
  private listeners = new Set<(w: string) => void>()
  private connected = true
  private rpcSet = false
  private wallet: DiscoveredWallet = { info: { uuid: 'demo', name: 'Wallet demo', icon: '', rdns: 'app.fondaco.demo' }, provider: { request: async () => null } }

  constructor(readonly cfg: Effective) {
    const now = Math.floor(Date.now() / 1000)
    for (const [b, q] of PAIRS) this.sims.push(this.makeMarket(bySym(b), bySym(q), now))
    for (const [s, v] of Object.entries(BAL)) this.bal[bySym(s).address] = { balance: u(v, bySym(s).decimals), allowance: 0n }
    // the prototype's offers: a ladder half filled, one partly unfunded, one waiting for a re-sign
    const wm = this.sim('WETH-USDC'), lm = this.sim('LINK-USDC')
    this.seedOffer(wm.m, 'sell', 0.4, roundP(this.midOf(wm) * 1.004), 4, now + 23 * 3600, (i) => (i < 2 ? 'filled' : 'open'))
    this.seedOffer(wm.m, 'buy', 0.6, roundP(this.midOf(wm) * 0.995), 3, now + 6 * 86400, (i) => (i < 1 ? 'unfunded' : 'open'))
    this.seedOffer(lm.m, 'buy', 40, roundP(this.midOf(lm) * 0.99), 1, now + 2 * 86400, () => 'invalid_fee')
    // live market: prices drift and levels change, like the prototype's ticker
    setInterval(() => this.tick(), 1600)
  }

  // ------------------------------------------------------------------ simulated data
  private entry(m: Market, ask: boolean, price: number, qBase: number, signer: string, expiry: number): BookEntry {
    const baseAmt = u(qBase, m.base.decimals), quoteAmt = u(qBase * price, m.quote.decimals)
    const order = { nonce: String(Math.floor(rnd() * 2 ** 48)), expiry: String(expiry), signerWallet: signer, signerToken: ask ? m.base.address : m.quote.address,
      signerAmount: String(ask ? baseAmt : quoteAmt), protocolFee: String(FEE), senderWallet: ZERO, senderToken: ask ? m.quote.address : m.base.address,
      senderAmount: String(ask ? quoteAmt : baseAmt), v: 27, r: hex(64), s: hex(64) }
    return { hash: hex(64), price, baseAmount: String(baseAmt), quoteAmount: String(quoteAmt), expiry, signer, order }
  }
  private makeMarket(base: TokenView, quote: TokenView, now: number): Sim {
    const m: Market = { id: `${base.symbol}-${quote.symbol}`, base, quote }
    const ref = (TOK[base.symbol]?.usd ?? 1) / (TOK[quote.symbol]?.usd ?? 1), st = base.stable && quote.stable
    const half = ref * (st ? 0.00015 : 0.0015 + rnd() * 0.002), step = ref * (st ? 0.0001 : 0.0012)
    const sim: Sim = { m, asks: [], bids: [], trades: [], candles: [], prev: 0 }
    let pa = ref + half, pb = ref - half
    for (let i = 0; i < 6; i++) {
      for (const [ask, p] of [[true, roundP(pa)], [false, roundP(pb)]] as const) {
        const q = roundQ(base.symbol, (300 + rnd() * 6500) / (TOK[base.symbol]?.usd ?? 1)), parts = 2 + Math.floor(rnd() * 3), signer = fakeAddr(0x100 + Math.floor(rnd() * 4000))
        for (let k = 0; k < parts; k++) (ask ? sim.asks : sim.bids).push(this.entry(m, ask, p, roundQ(base.symbol, q / parts), signer, now + 3600 * (1 + Math.floor(rnd() * 160))))
      }
      pa += step * (0.6 + rnd()); pb -= step * (0.6 + rnd())
    }
    const chg = st ? (rnd() - 0.5) * 0.001 : (rnd() - 0.42) * 0.08, open = ref / (1 + chg)
    const N = 288, sig = ref * (st ? 0.0001 : 0.0016), w = [0]
    let v = 0
    for (let i = 1; i <= N; i++) { v = 0.82 * v + (rnd() - 0.5) * 1.1; w.push((w[i - 1] as number) + v) }
    const t0 = Math.floor(now / 300) * 300 - N * 300
    sim.prev = open
    let last = open
    for (let i = 1; i <= N; i++) {
      const p = open + (ref - open) * (i / N) + ((w[i] as number) - ((w[N] as number) * i) / N) * sig
      const vq = (200 + rnd() * 9000)
      sim.candles.push({ t: t0 + i * 300, o: last, h: Math.max(last, p), l: Math.min(last, p), c: p, v: vq / p, vq, n: 1 + Math.floor(rnd() * 4) })
      last = p
    }
    let t = now
    for (let i = 0; i < 14; i++) {
      t -= Math.round(4 + rnd() * 70)
      const buy = rnd() > 0.5, p = roundP(((buy ? sim.asks[0] : sim.bids[0]) as BookEntry).price * (1 + (rnd() - 0.5) * 0.001)), q = roundQ(base.symbol, (50 + rnd() * 2500) / (TOK[base.symbol]?.usd ?? 1))
      sim.trades.push({ price: p, base: q, quote: q * p, side: buy ? 'buy' : 'sell', ts: t, tx: hex(64) })
    }
    return sim
  }
  private seedOffer(m: Market, side: 'sell' | 'buy', baseAmt: number, price: number, parts: number, expiry: number, status: (i: number) => MyOrder['status']): void {
    const nowMs = Date.now()
    for (let i = 0; i < parts; i++) {
      const e = this.entry(m, side === 'sell', price, baseAmt / parts, ME, expiry)
      const st = status(i)
      this.my.push({ hash: e.hash, chainId: this.chainId(), status: st, order: { ...e.order, signerWallet: ME, v: undefined } as unknown as MyOrder['order'], createdAt: nowMs - 3600_000, updatedAt: nowMs - (st === 'filled' ? 600_000 : 3600_000), executableOnChain: st !== 'filled' })
      if (st === 'open') this.insert(this.sim(m.id), side === 'sell', e)
    }
  }
  private insert(s: Sim, ask: boolean, e: BookEntry): void {
    const list = ask ? s.asks : s.bids
    list.push(e)
    list.sort((a, b) => (ask ? a.price - b.price : b.price - a.price))
  }
  private sim(id: string): Sim { return this.sims.find((s) => s.m.id === id) as Sim }
  private midOf(s: Sim): number { const a = s.asks.find((e) => e.signer !== ME)?.price, b = s.bids.find((e) => e.signer !== ME)?.price; return a && b ? (a + b) / 2 : (a || b || 0) }
  private tick(): void {
    if (typeof document !== 'undefined' && document.hidden) return
    const s = this.sims[Math.floor(Math.random() * this.sims.length)] as Sim
    const others = [...s.asks, ...s.bids].filter((e) => e.signer !== ME)
    const e = others[Math.floor(Math.random() * others.length)]
    if (e) { // a counterparty re-posts a level with a different size
      const ask = s.asks.includes(e), list = ask ? s.asks : s.bids
      list.splice(list.indexOf(e), 1)
      const q = Number(formatUnits(BigInt(e.baseAmount), s.m.base.decimals)) * (0.8 + Math.random() * 0.4)
      this.insert(s, ask, this.entry(s.m, ask, e.price, roundQ(s.m.base.symbol, q), e.signer, e.expiry))
    }
    if (Math.random() < 0.35) { // and someone trades at the best level
      const buy = Math.random() > 0.5, best = (buy ? s.asks : s.bids).find((x) => x.signer !== ME)
      if (best) this.trade(s, buy, best.price, roundQ(s.m.base.symbol, (50 + Math.random() * 1800) / (TOK[s.m.base.symbol]?.usd ?? 1)))
    }
    this.emit('book')
  }
  private trade(s: Sim, buy: boolean, p: number, q: number): void {
    const now = this.nowSec()
    s.trades.unshift({ price: p, base: q, quote: q * p, side: buy ? 'buy' : 'sell', ts: now, tx: hex(64) })
    s.trades.length = Math.min(s.trades.length, 40)
    const t = Math.floor(now / 300) * 300, last = s.candles[s.candles.length - 1]
    if (last && last.t === t) { last.c = p; last.h = Math.max(last.h, p); last.l = Math.min(last.l, p); last.vq += q * p; last.v += q; last.n++ }
    else { s.candles.push({ t, o: last?.c ?? p, h: p, l: p, c: p, v: q, vq: q * p, n: 1 }); if (s.candles.length > 288) { s.prev = (s.candles.shift() as Candle).c } }
    this.emit('trades')
  }

  // ------------------------------------------------------------------ Backend
  private emit(w: string) { for (const f of this.listeners) try { f(w) } catch (e) { console.error(e) } }
  onChange(f: (what: string) => void): void { this.listeners.add(f) }
  chainId(): number { return 1 }
  chains() { return [{ id: 1, name: 'Ethereum', available: true }, { id: 8453, name: 'Base', available: true }] }
  swapAddress(): Address { return fakeAddr(0xfee) }
  protocolFee(): bigint { return FEE }
  markets(): Market[] { return this.sims.map((s) => s.m) }
  bookOf(id: string) { const s = this.sim(id); return s ? { asks: s.asks, bids: s.bids } : undefined }
  tradesOf(id: string): Trade[] { return this.sim(id)?.trades ?? [] }
  candlesOf(id: string): CandleResponse | undefined {
    const s = this.sim(id); if (!s) return undefined
    const to = Math.floor(this.nowSec() / 300) * 300
    return { interval: 300, from: to - 287 * 300, to, now: this.nowSec(), prev: s.prev, candles: s.candles.filter((c) => c.t >= to - 287 * 300) }
  }
  myOrders(): MyOrder[] { return this.my }
  funds() { return this.connected ? this.bal : null }
  account(): Address | null { return this.connected ? ME : null }
  nowSec(): number { return Math.floor(Date.now() / 1000) }
  notices(): Notice[] { return [] }
  ready(): boolean { return true }
  focus(): void { /* everything is in memory */ }
  async refreshAll(): Promise<void> { this.emit('all') }
  wallets(): DiscoveredWallet[] { return [this.wallet] }
  selectedWallet(): DiscoveredWallet | null { return this.connected ? this.wallet : null }
  async connect(): Promise<void> { this.connected = true; this.emit('wallet') }
  async switchChain(): Promise<void> { this.emit('wallet') }
  protection(): ProtectionStatus { return protectionStatus({ rdns: this.wallet.info.rdns, chainId: 1, userSetRpc: this.rpcSet }) }
  setRpcConfirmed(on: boolean): void { this.rpcSet = on; this.emit('wallet') }
  rpcConfirmed(): boolean { return this.rpcSet }

  taker(onUpdate: (e: TakerEvent) => void): TakerLike {
    const findSide = (hash: string) => { for (const s of this.sims) { if (s.asks.some((e) => e.hash === hash)) return { s, ask: true }; if (s.bids.some((e) => e.hash === hash)) return { s, ask: false } } return null }
    const verify = async (p: IndicativeQuote): Promise<VerifiedQuote> => {
      await wait(450)
      const legs = p.legs.filter((l) => findSide(l.hash))
      const pay = legs.reduce((x, l) => x + l.order.senderAmount, 0n), receive = legs.reduce((x, l) => x + l.order.signerAmount, 0n)
      const tok = legs[0]?.order.senderToken
      const f = tok ? this.bal[tok] : undefined
      const q: VerifiedQuote = { kind: 'verified', ok: legs.length > 0 && (f?.balance ?? 0n) >= pay, block: 23700000n, legs, dropped: [], pay, receive, left: p.left + (p.pay - pay),
        balance: f?.balance ?? 0n, allowance: f?.allowance ?? 0n, needsApproval: (f?.allowance ?? 0n) < pay, problems: legs.length ? ((f?.balance ?? 0n) < pay ? ['taker_balance'] : []) : ['empty'], at: Date.now(), recipient: ME }
      onUpdate({ type: 'verified', quote: q })
      return q
    }
    const execute = async (q: VerifiedQuote): Promise<ExecuteResult> => {
      const res: ExecuteResult = { filled: [], skipped: [], failed: [], stopped: null, paid: 0n, received: 0n, gasCostWei: 0n, protection: 'wallet' }
      onUpdate({ type: 'protection', mode: 'wallet', why: 'browser_wallet' })
      const tok = q.legs[0]?.order.senderToken
      if (tok && q.needsApproval) {
        onUpdate({ type: 'approving', token: tok, amount: q.pay }); await wait(500)
        onUpdate({ type: 'pending', hash: hex(64) as Hex, private: false, step: 'approve' }); await wait(700)
        ;(this.bal[tok] as { allowance: bigint }).allowance = q.pay
      }
      for (const [i, l] of q.legs.entries()) {
        const ctx = { leg: i, of: q.legs.length, orderHash: l.hash }
        onUpdate({ type: 'simulating', ...ctx }); await wait(250)
        onUpdate({ type: 'awaiting_signature', ...ctx }); await wait(450)
        const txHash = hex(64) as Hex
        onUpdate({ type: 'pending', hash: txHash, private: false, ...ctx }); await wait(800)
        const where = findSide(l.hash)
        if (!where) { const r = { ...l, reason: 'taken' as const, message: 'Già presa da qualcun altro' }; res.skipped.push(r); onUpdate({ type: 'skipped', reason: 'taken', message: r.message, ...ctx }); continue }
        const list = where.ask ? where.s.asks : where.s.bids, e = list.find((x) => x.hash === l.hash) as BookEntry
        list.splice(list.indexOf(e), 1)
        this.move(l.order.senderToken, -l.order.senderAmount); this.move(l.order.signerToken, l.order.signerAmount)
        const fa = this.bal[l.order.senderToken]; if (fa) fa.allowance = fa.allowance > l.order.senderAmount ? fa.allowance - l.order.senderAmount : 0n
        this.trade(where.s, where.ask, e.price, Number(formatUnits(BigInt(e.baseAmount), where.s.m.base.decimals)))
        res.filled.push({ ...l, txHash, received: l.order.signerAmount }); res.paid += l.order.senderAmount; res.received += l.order.signerAmount; res.gasCostWei += 2_400_000_000_000_000n
        onUpdate({ type: 'filled', txHash, received: l.order.signerAmount, ...ctx })
        this.emit('book')
      }
      onUpdate({ type: 'done', result: res })
      this.emit('funds')
      return res
    }
    return { verify, execute }
  }
  private move(t: Address, d: bigint) { const f = this.bal[t]; if (f) f.balance = f.balance + d > 0n ? f.balance + d : 0n }
  async estimateGasWei(q: VerifiedQuote): Promise<bigint> { return BigInt(q.legs.length) * 2_400_000_000_000_000n }
  async approveFor(token: Address, amount: bigint): Promise<void> { await wait(600); const f = this.bal[token]; if (f) f.allowance = amount; this.emit('funds') }
  liveNeed(token: Address): bigint {
    return this.my.filter((o) => (o.status === 'open' || o.status === 'unfunded') && getAddress(o.order.signerToken) === token)
      .reduce((s, o) => s + BigInt(o.order.signerAmount) + (BigInt(o.order.signerAmount) * FEE) / 10_000n, 0n)
  }
  async privateOrder(): Promise<null> { return null }
  async publish(terms: OrderTerms[], expirySec: number, counterparty: Address | null = null): Promise<PublishResult> {
    await wait(500)
    const nowMs = Date.now()
    for (const t of terms) {
      const s = this.sims.find((x) => (x.m.base.address === t.signerToken && x.m.quote.address === t.senderToken) || (x.m.quote.address === t.signerToken && x.m.base.address === t.senderToken))
      if (!s) continue
      const ask = t.signerToken === s.m.base.address
      const baseAmt = ask ? t.signerAmount : t.senderAmount, quoteAmt = ask ? t.senderAmount : t.signerAmount
      const price = Number(formatUnits(quoteAmt, s.m.quote.decimals)) / Number(formatUnits(baseAmt, s.m.base.decimals))
      const order = { nonce: t.nonce != null ? String(t.nonce) : String(Math.floor(Math.random() * 2 ** 48)), expiry: String(expirySec), signerWallet: ME, signerToken: t.signerToken, signerAmount: String(t.signerAmount), protocolFee: String(FEE), senderWallet: counterparty ?? ZERO, senderToken: t.senderToken, senderAmount: String(t.senderAmount) }
      const e: BookEntry = { hash: hex(64), price, baseAmount: String(baseAmt), quoteAmount: String(quoteAmt), expiry: expirySec, signer: ME, order: { ...order, v: 27, r: hex(64), s: hex(64) } }
      if (!counterparty) this.insert(s, ask, e)
      if (t.nonce != null) this.my = this.my.filter((x) => !(x.status === 'invalid_fee' && x.order.nonce === String(t.nonce)))
      this.my.push({ hash: e.hash, chainId: 1, status: 'open', order, createdAt: nowMs, updatedAt: nowMs, executableOnChain: true })
    }
    this.emit('mine'); this.emit('book')
    return { ok: terms.length, errors: [], hashes: this.my.slice(-terms.length).map((o) => o.hash) }
  }
  async cancel(nonces: string[]) {
    await wait(700)
    const set = new Set(nonces), nowMs = Date.now()
    for (const o of this.my) if (set.has(o.order.nonce) && o.status !== 'filled') { o.status = 'cancelled'; o.updatedAt = nowMs; o.executableOnChain = false }
    for (const s of this.sims) { s.asks = s.asks.filter((e) => !(e.signer === ME && set.has(String(e.order.nonce)))); s.bids = s.bids.filter((e) => !(e.signer === ME && set.has(String(e.order.nonce)))) }
    this.emit('mine'); this.emit('book')
    return { status: 'cancelled' as const, hash: hex(64) as Hex, receipt: {} as never, taken: [] as bigint[] }
  }
}
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))
