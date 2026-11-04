// Pure, dependency-light part of the taker: order normalization and the indicative plan (no clients, no RPC). Kept in
// its own module so an app can show quotes without bundling the execution code (viem actions) on its first screen.
import { getAddress, zeroAddress, type Hex } from 'viem'
import type { BookEntry, IndicativeQuote, Leg, Order, OrderInput } from './types.js'

const big = (x: unknown) => BigInt(x as string | number | bigint)
export const norm = (o: OrderInput): Order => ({
  nonce: big(o.nonce), expiry: big(o.expiry), signerWallet: getAddress(String(o.signerWallet)), signerToken: getAddress(String(o.signerToken)),
  signerAmount: big(o.signerAmount), protocolFee: big(o.protocolFee), senderWallet: getAddress((o.senderWallet as string) || zeroAddress),
  senderToken: getAddress(String(o.senderToken)), senderAmount: big(o.senderAmount), v: Number(o.v), r: o.r as Hex, s: o.s as Hex,
})

/**
 * Indicative plan: take whole orders best-first while the cumulative payment stays ≤ `pay`.
 * @param entries book side, best first: [{ hash, order }] (GET /book?signed=1 → asks to buy base, bids to sell base)
 * @param pay amount of senderToken the taker wants to spend (bigint, base units)
 */
export function plan(entries: readonly BookEntry[], pay: bigint): IndicativeQuote {
  const legs: Leg[] = []
  let paid = 0n, got = 0n
  for (const e of entries) {
    const o = norm(e.order)
    if (o.senderWallet !== zeroAddress) continue // private orders never come from the public book
    const first = legs[0]?.order
    if (first && (o.senderToken !== first.senderToken || o.signerToken !== first.signerToken)) continue
    if (paid + o.senderAmount > pay) continue // all-or-nothing: a bigger order further down may not fit either, a smaller one may
    legs.push({ hash: e.hash, order: o })
    paid += o.senderAmount
    got += o.signerAmount
  }
  return { kind: 'indicative', legs, pay: paid, receive: got, left: pay - paid, at: Date.now() }
}

