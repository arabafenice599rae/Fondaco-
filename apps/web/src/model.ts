// Pure state logic of the app (no DOM, no network): book levels, swap quote, my offers and their states, chart series,
// exact order terms. Unit-tested in test/model.test.mjs.
import { plan, priceCheck, isStale, type BookEntry as ClientEntry, type IndicativeQuote, type PriceLevel, type TakerEvent, type VerifiedQuote } from '@fondaco/client'
import { formatUnits, getAddress, parseUnits, type Address } from 'viem'
import type { TokenView } from './tokens.js'

export const FEE_DIVISOR = 10_000n

export interface Market { id: string; base: TokenView; quote: TokenView }
/** One entry of GET /book?signed=1. asks: signer gives base; bids: signer gives quote. */
export interface BookEntry { hash: string; price: number; baseAmount: string; quoteAmount: string; expiry: number; signer: string; order: ClientEntry['order'] }
export interface Level { p: number; q: number; entries: BookEntry[]; own: boolean }

const units = (v: string | bigint, d: number) => Number(formatUnits(BigInt(v), d))

/** Group book entries into price levels (best first, as served). q = sum of base amounts. Own orders are flagged. */
export function levels(entries: readonly BookEntry[], base: TokenView, me?: string | null): Level[] {
  const out: Level[] = []
  const meA = me ? getAddress(me) : null
  for (const e of entries) {
    const own = !!meA && getAddress(e.signer) === meA
    const last = out[out.length - 1]
    if (last && Math.abs(last.p - e.price) <= Math.abs(e.price) * 1e-12 && last.own === own) {
      last.q += units(e.baseAmount, base.decimals); last.entries.push(e)
    } else out.push({ p: e.price, q: units(e.baseAmount, base.decimals), entries: [e], own })
  }
  return out
}

export const midOf = (asks: readonly Level[], bids: readonly Level[]): number => {
  const a = asks.find((l) => !l.own)?.p, b = bids.find((l) => !l.own)?.p
  return a && b ? (a + b) / 2 : (a || b || 0)
}

export interface SwapQuote {
  ok: boolean
  buy: boolean
  plan: IndicativeQuote | null
  /** grouped by price, for the "from which offers" bar */
  legs: { p: number; take: number; parts: number }[]
  orders: number
  got: number
  spent: number
  left: number
  liq: number
  smallest: number
  avg: number
  amount: number
}

/**
 * Indicative quote: whole orders best-first (client plan()), own orders excluded.
 * @param buy true = pay quote, receive base (asks); false = pay base, receive quote (bids)
 */
export function quoteSwap(m: Market, book: { asks: readonly BookEntry[]; bids: readonly BookEntry[] }, buy: boolean, amount: number, me?: string | null): SwapQuote {
  const pay = buy ? m.quote : m.base, recv = buy ? m.base : m.quote
  const meA = me ? getAddress(me) : null
  const side = (buy ? book.asks : book.bids).filter((e) => !meA || getAddress(e.signer) !== meA)
  const payOf = (e: BookEntry) => units(buy ? e.quoteAmount : e.baseAmount, pay.decimals)
  const liq = side.reduce((s, e) => s + payOf(e), 0)
  const smallest = side.length ? Math.min(...side.map(payOf)) : Infinity
  const empty: SwapQuote = { ok: true, buy, plan: null, legs: [], orders: 0, got: 0, spent: 0, left: amount, liq, smallest, avg: side[0]?.price ?? 0, amount }
  if (!(amount > 0)) return empty
  const payUnits = toUnits(amount, pay.decimals)
  const p = plan(side.map((e) => ({ hash: e.hash, order: e.order })), payUnits)
  const legs: SwapQuote['legs'] = []
  for (const l of p.legs) {
    const e = side.find((x) => x.hash === l.hash) as BookEntry
    const take = units(l.order.senderAmount, pay.decimals)
    const last = legs[legs.length - 1]
    if (last && last.p === e.price) { last.take += take; last.parts++ } else legs.push({ p: e.price, take, parts: 1 })
  }
  const spent = units(p.pay, pay.decimals), got = units(p.receive, recv.decimals)
  return { ok: true, buy, plan: p, legs, orders: p.legs.length, got, spent, left: Math.max(0, amount - spent), liq, smallest, amount,
    avg: got > 0 ? (buy ? spent / got : got / spent) : (side[0]?.price ?? 0) }
}

/**
 * The shortest decimal string that round-trips to `n` (what the user typed, for typed values), never in exponent form.
 * `toFixed(18)` would expose binary noise: 0.2 → "0.200000000000000011".
 */
export function plainDecimal(n: number): string {
  const s = String(n)
  const m = /^(-?)(\d+)(?:\.(\d+))?e([+-]\d+)$/i.exec(s)
  if (!m) return s
  const [, sign, i = '', f = '', e] = m, exp = Number(e), digits = i + f
  if (exp >= 0) { const point = i.length + exp; return sign + (digits.padEnd(point, '0').slice(0, point) + (digits.length > point ? '.' + digits.slice(point) : '')) }
  return sign + '0.' + '0'.repeat(-exp - i.length) + digits
}
/** Float amount → base units, from its shortest decimal form (rounded to the token's decimals by parseUnits). */
export function toUnits(amount: number, decimals: number): bigint {
  if (!(amount > 0) || !Number.isFinite(amount)) return 0n
  return parseUnits(plainDecimal(amount), decimals)
}

// ------------------------------------------------------------------ proposing a price

/** `nonce`: only to re-sign an invalid_fee order (same nonce → the old and the new order can never both fill) */
export interface OrderTerms { signerToken: Address; signerAmount: bigint; senderToken: Address; senderAmount: bigint; nonce?: bigint }

/**
 * Exact terms of a ladder: `amount` of the token given, split in `parts` equal slices (the last takes the remainder),
 * at `price` quote per base. sell: give base, ask quote; buy: give quote, ask base. Amounts the counterpart pays are
 * rounded DOWN (the signer never asks more than the price it wrote).
 */
export function ladderTerms(m: Market, sell: boolean, amount: number, price: number, parts: number): OrderTerms[] {
  const give = sell ? m.base : m.quote, want = sell ? m.quote : m.base
  const total = toUnits(amount, give.decimals)
  if (total <= 0n || !(price > 0) || parts < 1) return []
  // price as an exact rational from its shortest decimal representation
  const [ip = '0', fpart = ''] = plainDecimal(price).split('.')
  const den = 10n ** BigInt(fpart.length), pnum = BigInt(ip + fpart)
  const slice = total / BigInt(parts)
  const out: OrderTerms[] = []
  for (let i = 0; i < parts; i++) {
    const s = i === parts - 1 ? total - slice * BigInt(parts - 1) : slice
    // sell: want(quote) = s(base) × price, rescaled base→quote decimals; buy: want(base) = s(quote) / price, quote→base decimals
    const w = sell
      ? (s * pnum * 10n ** BigInt(want.decimals)) / (den * 10n ** BigInt(give.decimals))
      : (s * den * 10n ** BigInt(want.decimals)) / (pnum * 10n ** BigInt(give.decimals))
    out.push({ signerToken: give.address, signerAmount: s, senderToken: want.address, senderAmount: w })
  }
  return out
}
export const feeOf = (signerAmount: bigint, protocolFee: bigint): bigint => (signerAmount * protocolFee) / FEE_DIVISOR

/** Same rule as client protect.priceCheck (thresholds from 2 % and from 10 %). */
export const guard = (sell: boolean, price: number, mid: number): { level: PriceLevel; deviationBps: number } => priceCheck({ side: sell ? 'sell' : 'buy', price, mid })

// ------------------------------------------------------------------ my offers

/** One entry of GET /orders?chainId&signer. */
export interface MyOrder {
  hash: string
  chainId: number
  status: 'open' | 'unfunded' | 'filled' | 'cancelled' | 'used' | 'expired' | 'invalid_fee' | 'invalid_signer'
  order: { nonce: string; expiry: string; signerWallet: string; signerToken: string; signerAmount: string; senderToken: string; senderAmount: string; protocolFee: string; senderWallet: string }
  createdAt: number
  updatedAt: number
  executableOnChain: boolean
}
export type OfferStatus = 'active' | 'paused' | 'resign' | 'exec'
export interface OfferView {
  key: string
  market: Market
  side: 'sell' | 'buy'
  baseAmt: number
  price: number
  parts: number
  filled: number
  /** live parts currently funded (open) */
  funded: number
  status: OfferStatus
  expiry: number
  /** nonces a cancel must include: every order that can still execute on-chain */
  cancelNonces: string[]
  orders: MyOrder[]
  stale: boolean
  /** private offer: the only address that can take it */
  privateFor: string | null
}
export interface HistoryItem { t: string; s: string; at: number }

const findMarket = (markets: readonly Market[], a: string, b: string) => {
  const A = getAddress(a), B = getAddress(b)
  return markets.find((m) => (m.base.address === A && m.quote.address === B) || (m.base.address === B && m.quote.address === A)) ?? null
}

/**
 * Group my orders into offers (a ladder = same market, side, price and expiry) and derive the offer state:
 *   exec    — an order the book considers dead (invalid_signer) can still be executed on-chain: cancel it now
 *   resign  — the fee changed (invalid_fee): re-sign at no cost
 *   paused  — some parts are not funded (unfunded)
 *   active  — every live part is funded
 * Groups with nothing live go to the history.
 */
export function groupOffers(orders: readonly MyOrder[], markets: readonly Market[], mids: Record<string, number>, nowSec: number): { live: OfferView[]; history: HistoryItem[] } {
  const groups = new Map<string, { m: Market; side: 'sell' | 'buy'; price: number; expiry: number; list: MyOrder[]; privateFor: string | null }>()
  for (const o of orders) {
    const m = findMarket(markets, o.order.signerToken, o.order.senderToken)
    if (!m) continue
    const side = getAddress(o.order.signerToken) === m.base.address ? 'sell' : 'buy'
    const baseAmt = units(side === 'sell' ? o.order.signerAmount : o.order.senderAmount, m.base.decimals)
    const quoteAmt = units(side === 'sell' ? o.order.senderAmount : o.order.signerAmount, m.quote.decimals)
    const price = quoteAmt / baseAmt
    const sw = o.order.senderWallet && !/^0x0{40}$/i.test(o.order.senderWallet) ? getAddress(o.order.senderWallet) : null
    const key = `${m.id}|${side}|${price.toPrecision(10)}|${o.order.expiry}|${sw ?? ''}`
    const g = groups.get(key)
    if (g) g.list.push(o); else groups.set(key, { m, side, price, expiry: Number(o.order.expiry), list: [o], privateFor: sw })
  }
  const live: OfferView[] = [], history: HistoryItem[] = []
  for (const [key, g] of groups) {
    const { m, side, list } = g
    const by = (s: MyOrder['status']) => list.filter((o) => o.status === s)
    const expired = g.expiry <= nowSec
    const exec = list.filter((o) => o.status === 'invalid_signer' && o.executableOnChain)
    const liveOrders = list.filter((o) => !expired && (o.status === 'open' || o.status === 'unfunded' || o.status === 'invalid_fee' || o.status === 'used'))
    const baseAmt = list.reduce((s, o) => s + units(side === 'sell' ? o.order.signerAmount : o.order.senderAmount, m.base.decimals), 0)
    const filled = by('filled').length
    if (liveOrders.length === 0 && exec.length === 0) {
      const verb = side === 'sell' ? 'Venduti' : 'Comprati'
      if (filled) history.push({ t: `${verb} ${fmtQ(units(sumAmt(by('filled'), side === 'sell' ? 'signer' : 'sender'), m.base.decimals))} ${m.base.symbol}`, s: `${filled} parti su ${list.length} eseguite`, at: maxUpdated(list) })
      const cancelled = by('cancelled').length
      if (cancelled) history.push({ t: `Annullata: ${side === 'sell' ? 'vendita' : 'acquisto'} di ${fmtQ(baseAmt)} ${m.base.symbol}`, s: `${cancelled} parti annullate`, at: maxUpdated(list) })
      if (!filled && !cancelled) history.push({ t: `Scaduta: ${side === 'sell' ? 'vendita' : 'acquisto'} di ${fmtQ(baseAmt)} ${m.base.symbol}`, s: `${list.length} parti`, at: maxUpdated(list) })
      continue
    }
    const status: OfferStatus = exec.length ? 'exec' : by('invalid_fee').length ? 'resign' : by('unfunded').length ? 'paused' : 'active'
    const mid = mids[m.id] ?? 0
    live.push({
      key, market: m, side, baseAmt, price: g.price, parts: list.length, filled, funded: by('open').length, status, expiry: g.expiry, orders: list,
      cancelNonces: [...liveOrders, ...exec].filter((o) => o.status !== 'used').map((o) => o.order.nonce),
      privateFor: g.privateFor,
      stale: status === 'active' && mid > 0 && isStale({ side: side === 'sell' ? 'sell' : 'buy', price: g.price, mid }),
    })
  }
  live.sort((a, b) => b.expiry - a.expiry)
  history.sort((a, b) => b.at - a.at)
  return { live, history }
}
const sumAmt = (os: MyOrder[], who: 'signer' | 'sender') => os.reduce((s, o) => s + BigInt(who === 'signer' ? o.order.signerAmount : o.order.senderAmount), 0n)
const maxUpdated = (os: MyOrder[]) => Math.max(...os.map((o) => o.updatedAt))
const fmtQ = (q: number) => q.toLocaleString('it-IT', { maximumFractionDigits: 4 })

// ------------------------------------------------------------------ chart series and 24 h stats

export interface Candle { t: number; o: number; h: number; l: number; c: number; v: number; vq: number; n: number }
export interface CandleResponse { interval: number; from: number; to: number; now: number; prev: number | null; candles: Candle[] }
export interface Stats { last: number | null; change: number | null; hi: number | null; lo: number | null; volQuote: number; trades: number }

/** One point per bucket (close), forward-filled from `prev` or the first trade; empty if no trade ever. */
export function series(r: CandleResponse): { t: number; p: number }[] {
  const by = new Map(r.candles.map((c) => [c.t, c]))
  const out: { t: number; p: number }[] = []
  let p = r.prev ?? r.candles[0]?.o ?? null
  if (p == null) return []
  for (let t = r.from; t <= r.to; t += r.interval) {
    const c = by.get(t)
    if (c) p = c.c
    out.push({ t: t * 1000, p })
  }
  return out
}
export function stats(r: CandleResponse): Stats {
  const s = series(r)
  if (!s.length) return { last: null, change: null, hi: null, lo: null, volQuote: 0, trades: 0 }
  const first = r.prev ?? (r.candles[0] as Candle).o, last = (s[s.length - 1] as { p: number }).p
  const hs = r.candles.map((c) => c.h), ls = r.candles.map((c) => c.l)
  return { last, change: first > 0 ? last / first - 1 : null, hi: hs.length ? Math.max(...hs) : last, lo: ls.length ? Math.min(...ls) : last,
    volQuote: r.candles.reduce((x, c) => x + c.vq, 0), trades: r.candles.reduce((x, c) => x + c.n, 0) }
}

// ------------------------------------------------------------------ banners

export interface ChainNotice { contractMismatch: boolean; feeLightDiffers: boolean; notDeployed: boolean }
/** Book /config vs the app's own configuration: the app trusts ITS contract address, never the book's. */
export function chainNotice(appSwap: string | null, book: { swap?: string; protocolFee?: string; protocolFeeLight?: string } | undefined): ChainNotice {
  return {
    notDeployed: !appSwap,
    contractMismatch: !!appSwap && !!book?.swap && getAddress(book.swap) !== getAddress(appSwap),
    feeLightDiffers: !!book && book.protocolFeeLight != null && book.protocolFee != null && book.protocolFeeLight !== book.protocolFee,
  }
}

// ------------------------------------------------------------------ confirmation: quote state and per-order state

export interface QuoteState { cls: 'ind' | 'ok'; label: string; text: string; verifyStep: { done: boolean; text: string }; go: { disabled: boolean; label: string }; needsApproval: boolean }
/** What the confirmation says about the quote: indicative (from the book) until verify() answers, then verified at a block. */
export function quoteState(v: VerifiedQuote | null, orders: number, blockFmt: (b: bigint) => string = (b) => b.toString()): QuoteState {
  if (!v) return { cls: 'ind', label: 'Indicativo', text: 'Stima dal libro offerte', verifyStep: { done: false, text: 'Controllo che le offerte siano ancora valide…' }, go: { disabled: true, label: 'Verifica in corso…' }, needsApproval: false }
  const b = blockFmt(v.block ?? 0n), d = v.dropped.length, live = v.legs.length
  const text = d ? `${d === 1 ? '1 offerta non è più disponibile' : d + ' offerte non sono più disponibili'}: importi aggiornati · blocco #${b}` : `Importi definitivi · blocco #${b}`
  const step = v.ok ? (d ? `${live} offerte su ${orders} ancora valide` : 'Tutte le offerte sono valide') : v.problems.includes('taker_balance') ? 'Saldo insufficiente' : 'Nessuna offerta ancora valida'
  const appr = !!v.needsApproval
  return { cls: 'ok', label: 'Verificato', text, verifyStep: { done: v.ok, text: step }, go: { disabled: !v.ok, label: !v.ok ? 'Non eseguibile' : appr ? 'Autorizza e scambia' : 'Scambia' }, needsApproval: appr }
}

export type LegStatus = 'wait' | 'verify' | 'sign' | 'pending' | 'done' | 'skipped' | 'dropped' | 'failed'
/** New status of the order an execute() event refers to (undefined = the event is not about one order). */
export function legStatus(e: TakerEvent): LegStatus | undefined {
  switch (e.type) {
    case 'simulating': return 'verify'
    case 'awaiting_signature': return 'sign'
    case 'pending': return e.orderHash ? 'pending' : undefined
    case 'filled': return 'done'
    case 'skipped': return e.reason === 'not_included' ? 'dropped' : 'skipped'
    case 'failed': return 'failed'
    default: return undefined
  }
}
