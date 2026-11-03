// Strict types shared by the book server: order states, normalized orders, DB rows, engine events.
import type { Address, Hex } from 'viem'

/** Lifecycle of an order in the book (spec §3.1). */
export const ORDER_STATUSES = ['open', 'unfunded', 'filled', 'cancelled', 'used', 'expired', 'invalid_fee', 'invalid_signer'] as const
export type OrderStatus = (typeof ORDER_STATUSES)[number]
/** Statuses an order can still leave by revalidation (the "live" set). */
export type LiveStatus = Extract<OrderStatus, 'open' | 'unfunded'>

/** A canonical order: BigInt amounts, checksummed addresses, v 27|28, lowercase r/s. */
export interface NormalizedOrder {
  nonce: bigint
  expiry: bigint
  signerWallet: Address
  signerToken: Address
  signerAmount: bigint
  protocolFee: bigint
  senderWallet: Address
  senderToken: Address
  senderAmount: bigint
  v: number
  r: Hex
  s: Hex
}

/** One row of the `orders` table (schema v4). Amounts are exact decimal strings; `price` is for sorting only. */
export interface OrderRow {
  hash: Hex
  chain_id: number
  nonce: string
  expiry: number
  signer: Address
  signer_token: Address
  signer_amount: string
  sender_wallet: Address
  sender_token: Address
  sender_amount: string
  protocol_fee: number
  v: number
  r: Hex
  s: Hex
  price: number
  status: OrderStatus
  created_at: number
  updated_at: number
  status_block: number | null
  contract_signer: 0 | 1
  signer_revoked: 0 | 1
  onchain_live: 0 | 1 | null
}

/** Insert parameters (named, as in the INSERT statement). */
export interface OrderInsert {
  hash: Hex; chain_id: number; nonce: string; expiry: number; signer: Address; signer_token: Address; signer_amount: string
  sender_wallet: Address; sender_token: Address; sender_amount: string; protocol_fee: number; v: number; r: Hex; s: Hex
  price: number; status: OrderStatus; now: number; contract_signer: 0 | 1
}

export interface TokenCfg { symbol: string; decimals: number; min?: bigint }

/** Engine-side view of a chain's configuration (after validation and normalization). */
export interface ChainCfg {
  id: number
  rpc: string | string[]
  rpcTimeoutMs: number
  swap: Address
  multicall: Address
  tokens: Record<Address, TokenCfg>
  startBlock: bigint
  logChunk: bigint
  reorgDepth: bigint
  signalMaxBlocks: bigint
  logSignerChunk: number
  fullSweepMs: number
  expiryBufferSec: number
  minExpirySec: number
  maxExpirySec: number
  maxOpenPerSigner: number
  maxLiveOrders: number
  maxStalenessMs: number
  /** markets offered to the app: [base, quote] token pairs (from config, or derived from the whitelist) */
  markets: { base: Address; quote: Address }[]
}

/** One fill of an order of this book, indexed from SwapERC20 events (amounts as exact decimal strings). */
export interface FillRow {
  id: number
  chain_id: number
  order_hash: Hex
  block: number
  tx: Hex
  log_index: number
  ts: number
  signer: Address
  signer_token: Address
  signer_amount: string
  sender_token: Address
  sender_amount: string
}

// ---------------------------------------------------------------- events (EventEmitter + SSE)
export interface OrderEvent { chainId: number; hash: Hex; status: OrderStatus; executableOnChain?: boolean }
export interface FeeEvent { chainId: number; protocolFee: string }
export interface ReorgEvent { chainId: number; rewoundTo: bigint; rolledBack: number }
export interface TradeEvent { chainId: number; orderHash: Hex; tx: Hex; block: number; ts: number }
/** Any administrative change on the contract (owner, fees, fee wallet, staking, bonus): the app shows a banner. */
export interface GovernanceEvent { chainId: number; event: string; args: Record<string, string>; block: number; tx: Hex }
export interface EngineEvents { order: [OrderEvent]; fee: [FeeEvent]; reorg: [ReorgEvent]; trade: [TradeEvent]; governance: [GovernanceEvent] }

/** Result of one submitted order: either accepted (hash + status) or rejected (error code + message). */
export type SubmitResult = { hash: Hex; status: OrderStatus | 'pending' } | { error: string; message: string }

export type TickResult = { skipped: true } | { checked: number; full?: boolean }
