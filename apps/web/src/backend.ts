// The UI talks only to a Backend: the live one (book server + wallet) or, in a DEMO=true build, the simulated one.
import type { Address } from 'viem'
import type { ExecuteResult, IndicativeQuote, TakerEvent, VerifiedQuote, ProtectionStatus, CancelResult } from '@fondaco/client'
import type { BookEntry, CandleResponse, Market, MyOrder, OrderTerms } from './model.js'
import type { Trade } from './api.js'
import type { DiscoveredWallet } from '@fondaco/client'

export interface TakerLike {
  verify(p: IndicativeQuote): Promise<VerifiedQuote>
  execute(q: VerifiedQuote, opts: { approval: 'exact' | 'max' }): Promise<ExecuteResult>
}
export interface Notice { id: string; level: 'warn' | 'danger' | 'info'; title: string; text: string; blocksTrading: boolean }
/** `available`: the chain has a contract configured, so the user can select it (D-61) */
export interface ChainOption { id: number; name: string; available: boolean }
export interface PublishResult { ok: number; errors: string[]; hashes: string[] }
export interface SignedOrderView { hash: string; status: string; executableOnChain: boolean; order: Record<string, string | number> }

export interface Backend {
  readonly demo: boolean
  chainId(): number
  chains(): ChainOption[]
  swapAddress(): Address | null
  protocolFee(): bigint
  markets(): Market[]
  bookOf(id: string): { asks: BookEntry[]; bids: BookEntry[] } | undefined
  tradesOf(id: string): Trade[]
  candlesOf(id: string): CandleResponse | undefined
  myOrders(): MyOrder[]
  /** balances/allowances by token address; null = no wallet connected */
  funds(): Record<Address, { balance: bigint; allowance: bigint }> | null
  account(): Address | null
  nowSec(): number
  /** banners: stale book, book unreachable, contract mismatch, governance changes, not deployed, no markets */
  notices(): Notice[]
  /** live: what the UI must still say about the book connection */
  ready(): boolean
  focus(marketId: string): void
  refreshAll(): Promise<void>
  onChange(f: (what: string) => void): void
  // wallet & protection
  wallets(): DiscoveredWallet[]
  selectedWallet(): DiscoveredWallet | null
  connect(w: DiscoveredWallet): Promise<void>
  switchChain(id: number): Promise<void>
  protection(): ProtectionStatus
  setRpcConfirmed(on: boolean): void
  rpcConfirmed(): boolean
  // actions
  taker(onUpdate: (e: TakerEvent) => void): TakerLike
  estimateGasWei(q: VerifiedQuote): Promise<bigint | null>
  approveFor(token: Address, amount: bigint): Promise<void>
  /** amount + fee that my live orders of `token` already require (the allowance must cover them too) */
  liveNeed(token: Address): bigint
  /** sign and post; `counterparty` = private offer: only that address can take it (signed as senderWallet), never in the public book */
  publish(terms: OrderTerms[], expirySec: number, counterparty?: Address | null): Promise<PublishResult>
  /** a private offer by hash (GET /orders/:hash, signature included), or null */
  privateOrder(hash: string): Promise<SignedOrderView | null>
  cancel(nonces: string[]): Promise<CancelResult | { status: 'unavailable'; error: string }>
}
