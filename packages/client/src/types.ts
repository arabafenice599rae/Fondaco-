// Public types of @fondaco/client. No dependency but viem (types only from viem).
import type { Address, Hex, TransactionReceipt } from 'viem'

/** A signed SwapERC20 v4.3 order, normalized (BigInt amounts, checksummed addresses). The recipient is NOT signed. */
export interface Order {
  nonce: bigint
  expiry: bigint
  signerWallet: Address
  signerToken: Address
  signerAmount: bigint
  protocolFee: bigint
  /** 0x0 = public order (swapAnySender); otherwise only this address can take it (swap) */
  senderWallet: Address
  senderToken: Address
  senderAmount: bigint
  v: number
  r: Hex
  s: Hex
}
/** Order as served by the book (`GET /book?signed=1`, `GET /orders/:hash`): integers as decimal strings. */
export type OrderInput = { [K in keyof Order]: K extends 'senderWallet' ? string | null | undefined : K extends 'v' ? number | string : string | number | bigint }
/** One side of the book, best first. */
export interface BookEntry { hash: string; order: OrderInput }
export interface Leg { hash: string; order: Order }

/** Reasons a leg is dropped, skipped, failed or a run stops; Italian copy in REASONS. */
export type Reason =
  | 'taken' | 'expired' | 'signature' | 'signer_funds' | 'taker_balance' | 'taker_allowance' | 'private' | 'rejected' | 'cancelled'
  | 'replaced' | 'timeout' | 'reverted' | 'not_included' | 'unknown' | 'recipient_guard' | 'private_unavailable'

export interface DroppedLeg extends Leg { reason: Reason; message: string }

/** plan(): whole orders, best first, nothing checked on-chain yet. */
export interface IndicativeQuote {
  kind: 'indicative'
  legs: Leg[]
  /** senderToken the taker would pay (base units) */
  pay: bigint
  /** signerToken the taker would receive (base units) */
  receive: bigint
  /** part of the requested amount the whole orders cannot use */
  left: bigint
  at: number
}

/** verify(): one batched read at `block`; legs still fillable, dropped legs with their reason. */
export interface VerifiedQuote {
  kind: 'verified'
  ok: boolean
  block?: bigint
  legs: Leg[]
  dropped: DroppedLeg[]
  pay: bigint
  receive: bigint
  left: bigint
  balance?: bigint
  allowance?: bigint
  needsApproval?: boolean
  problems: ('empty' | 'taker_balance')[]
  at?: number
  /** always the connected account: the recipient is never a parameter */
  recipient?: Address
}
export type Quote = IndicativeQuote | VerifiedQuote

export interface FilledLeg extends Leg { txHash: Hex; received: bigint }
export interface SkippedLeg extends Leg { reason: Reason; message: string; costsGas?: false; txHash?: Hex }
export interface FailedLeg extends Leg { reason: Reason | 'cancelled' | 'replaced' | 'timeout'; message: string; costsGas: boolean; txHash: Hex }

export type StopReason = Reason | 'empty'
export interface ExecuteResult {
  filled: FilledLeg[]
  skipped: (SkippedLeg | DroppedLeg)[]
  failed: FailedLeg[]
  /** why the run stopped early (null = every leg was attempted) */
  stopped: StopReason | null
  paid: bigint
  received: bigint
  gasCostWei: bigint
  /** how the legs were submitted; 'wallet' after an opt-in downgrade from private */
  protection: SubmitMode
  /** true if the private endpoints were unreachable and the caller allowed the wallet fallback (onUnavailable: 'wallet') */
  downgraded?: boolean
}

export type SubmitMode = 'private' | 'wallet'
export type SubmitWhy = 'private_rpc' | 'sequencer' | 'no_private_rpc' | 'browser_wallet' | 'not_configured'

/** Context of a leg in events: index, total, order hash. */
export interface LegCtx { leg: number; of: number; orderHash: string }

/** Every event passed to onUpdate. Discriminated by `type`. */
export type TakerEvent =
  | { type: 'verified'; quote: VerifiedQuote }
  | { type: 'protection'; mode: SubmitMode; why: SubmitWhy }
  | { type: 'approval_reset'; token: Address }
  | { type: 'approving'; token: Address; amount: bigint }
  | ({ type: 'simulating' } & LegCtx)
  | ({ type: 'awaiting_signature' } & LegCtx)
  | ({ type: 'pending'; hash: Hex; private: boolean; step?: 'approve' | 'approve_reset' } & Partial<LegCtx>)
  | ({ type: 'sped_up'; hash: Hex; previous: Hex; step?: 'approve' | 'approve_reset' } & Partial<LegCtx>)
  | ({ type: 'filled'; txHash: Hex; received: bigint } & LegCtx)
  | ({ type: 'skipped'; reason: Reason; message: string; txHash?: Hex } & LegCtx)
  | ({ type: 'failed'; txHash: Hex; reason: Reason; message: string; costsGas: true } & LegCtx)
  | ({ type: 'cancelled' | 'replaced' | 'timeout'; txHash: Hex } & LegCtx)
  | ({ type: 'rejected' } & LegCtx)
  | ({ type: 'blocked'; reason: 'recipient_guard'; message: string } & LegCtx)
  | { type: 'private_unavailable'; error: string }
  | { type: 'protection_downgraded'; from: 'private'; to: 'wallet'; error: string }
  | { type: 'done'; result: ExecuteResult }

/** Outcome of tracking one transaction. */
export type Tracked =
  | { status: 'mined'; hash: Hex; receipt: TransactionReceipt; previous?: Hex }
  | { status: 'reverted'; hash: Hex; receipt: TransactionReceipt }
  | { status: 'cancelled' | 'replaced'; hash: Hex; previous: Hex; reason: 'cancelled' | 'replaced'; receipt: TransactionReceipt }
  | { status: 'timeout'; hash: Hex; reason: 'timeout' }

/** What a submitter returns for one send. */
export type SendResult =
  /** sent; `downgraded` = the private endpoints were unreachable and the transaction went through the wallet instead (opt-in) */
  | { hash: Hex; downgraded?: string }
  | { rejected: true }
  /** the private endpoints were unreachable: nothing was sent anywhere */
  | { unavailable: true; error: string }
