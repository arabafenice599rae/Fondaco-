// MEV protection on the user's side: private submission and price guards. No server involvement.
//
// Private submission: the signed transaction goes to a protected RPC instead of the public mempool, so a bot cannot
// copy a fill (or a cancel) and land it first. The endpoints below also have revert protection: a transaction that
// would fail (offer already taken) is not included, so it costs no gas — it simply never lands.
//
// It works when this code signs the transaction itself (local account: bots, scripts, embedded wallets). A browser
// wallet (json-rpc account) broadcasts through its own RPC: we cannot redirect it, so mode = 'wallet' and the UI
// explains how to turn protection on in the wallet.
import { createClient, http, fallback, encodeFunctionData, getAddress, parseAbi, BaseError, UserRejectedRequestError,
  type Address, type Client, type Hex, type PublicClient, type Transport, type WalletClient, type TransactionReceipt } from 'viem'
import { prepareTransactionRequest } from 'viem/actions'
import type { ContractRequest, Submitter } from './taker.js'
import type { SendResult, SubmitMode, SubmitWhy } from './types.js'

/** Protected endpoints with revert protection, per chain. L2s with a sequencer have no public mempool to protect from. */
export const PROTECTED_RPC: Readonly<Record<number, readonly string[]>> = {
  1: ['https://rpc.mevblocker.io/noreverts', 'https://rpc.flashbots.net/fast'],
}
export const SEQUENCER_CHAINS: ReadonlySet<number> = new Set([8453, 10, 42161]) // Base, OP Mainnet, Arbitrum One

export type SubmitterEvent = { type: 'sent_private'; hash: Hex } | { type: 'private_unavailable'; error: string } | { type: 'protection_downgraded'; error: string; hash: Hex }

/** Transport-level failure (unreachable, timeout, HTTP error): the endpoint did not answer. A JSON-RPC error IS an answer. */
export function isUnreachable(e: unknown): boolean {
  const walk = (x: unknown, d = 0): boolean => {
    if (!x || typeof x !== 'object' || d > 6) return false
    const err = x as { name?: string; cause?: unknown }
    if (err.name === 'RpcRequestError') return false
    if (err.name === 'HttpRequestError' || err.name === 'TimeoutError' || err.name === 'TypeError') return true
    return walk(err.cause, d + 1)
  }
  return walk(e)
}
export interface SubmitterOptions {
  publicClient: PublicClient
  walletClient: WalletClient
  chainId: number
  /** a viem transport to use instead of PROTECTED_RPC[chainId] (tests, a paid endpoint, your own relay) */
  privateTransport?: Transport
  onUpdate?: (e: SubmitterEvent) => void
  /**
   * When every protected endpoint is unreachable: 'stop' (default) sends nothing and reports `unavailable`;
   * 'wallet' sends through the wallet's own RPC (public mempool on mainnet) and reports the downgrade. Never silent.
   */
  onUnavailable?: 'stop' | 'wallet'
}

export function createSubmitter({ publicClient, walletClient, chainId, privateTransport, onUpdate = () => {}, onUnavailable = 'stop' }: SubmitterOptions): Submitter {
  const account = walletClient.account
  const local = !!account && account.type === 'local' && typeof (account as { signTransaction?: unknown }).signTransaction === 'function'
  const urls = PROTECTED_RPC[chainId] || []
  const transport = privateTransport || (urls.length ? fallback(urls.map((u) => http(u, { retryCount: 1, timeout: 10_000 })), { rank: false }) : null)
  const mode: SubmitMode = local && transport ? 'private' : 'wallet'
  const why: SubmitWhy = mode === 'private' ? 'private_rpc'
    : SEQUENCER_CHAINS.has(Number(chainId)) ? 'sequencer' // no public mempool on this chain
    : !transport ? 'no_private_rpc' : 'browser_wallet' // the wallet's own RPC decides
  const priv: Client | null = transport ? createClient({ transport, chain: walletClient.chain }) : null

  const rejected = (e: unknown) => (e instanceof BaseError && !!e.walk((x) => x instanceof UserRejectedRequestError)) || (e as { code?: number })?.code === 4001

  async function send(request: ContractRequest): Promise<SendResult> {
    try {
      if (mode === 'wallet') return { hash: await walletClient.writeContract(request as never) }
      const data = encodeFunctionData({ abi: request.abi, functionName: request.functionName, args: request.args } as never)
      // 'latest', not 'pending': a private transaction that was never included (revert protection) frees its nonce,
      // and the next one must take it over instead of queueing behind it
      const nonce = await publicClient.getTransactionCount({ address: (account as { address: Address }).address, blockTag: 'latest' })
      const tx = await prepareTransactionRequest(publicClient, { account: account as never, chain: walletClient.chain, to: getAddress(request.address), data, value: request.value ?? 0n, nonce } as never)
      const raw = await (account as unknown as { signTransaction(t: unknown): Promise<Hex> }).signTransaction(tx)
      let hash: Hex
      try {
        hash = await (priv as Client).request({ method: 'eth_sendRawTransaction', params: [raw] } as never) as Hex
      } catch (e) {
        if (!isUnreachable(e)) throw e
        const error = (e as { shortMessage?: string; message: string }).shortMessage ?? (e as Error).message
        if (onUnavailable !== 'wallet') { onUpdate({ type: 'private_unavailable', error }); return { unavailable: true, error } }
        // explicit, reported downgrade: the caller opted in to the wallet's own (public) route
        const h = await walletClient.writeContract(request as never)
        onUpdate({ type: 'protection_downgraded', error, hash: h })
        return { hash: h, downgraded: error }
      }
      onUpdate({ type: 'sent_private', hash })
      return { hash }
    } catch (e) {
      if (rejected(e)) return { rejected: true }
      throw e
    }
  }
  return { mode, why, private: mode === 'private', send }
}

const CANCEL_ABI = parseAbi(['function cancel(uint256[] nonces)', 'function nonceUsed(address signer, uint256 nonce) view returns (bool)'])
const CANCEL_TOPIC = '0x8dd3c361eb2366ff27c2db0eb07b9261f1d052570742ab8c9a0c326f37aa576d' // Cancel(uint256,address)

export type CancelResult =
  | { status: 'cancelled' | 'partly_taken'; hash: Hex; receipt: TransactionReceipt; taken: bigint[]; downgraded?: string }
  | { status: 'private_unavailable'; error: string; taken: [] }
  | { status: 'rejected'; taken: [] }
  | { status: 'timeout' | 'reverted'; hash: Hex; taken: [] }

/**
 * Cancel offers through the submitter (private when possible): a public cancel can be seen in the mempool and
 * front-run by a fill. Resolves cancelled | partly_taken (with the nonces already filled) | rejected | timeout | reverted.
 */
export async function cancelOrders({ publicClient, walletClient, submitter, swap, nonces, timeoutMs = 180_000 }:
  { publicClient: PublicClient; walletClient: WalletClient; submitter: Submitter; swap: Address; nonces: readonly (bigint | number | string)[]; timeoutMs?: number }): Promise<CancelResult> {
  const swapAddr = getAddress(swap)
  const list = nonces.map((n) => BigInt(n))
  const { request } = await publicClient.simulateContract({ account: walletClient.account as never, chain: walletClient.chain, address: swapAddr, abi: CANCEL_ABI, functionName: 'cancel', args: [list] })
  const s = await submitter.send(request as unknown as ContractRequest)
  if ('rejected' in s) return { status: 'rejected', taken: [] }
  if ('unavailable' in s) return { status: 'private_unavailable', error: s.error, taken: [] }
  let receipt: TransactionReceipt | null = null
  try { receipt = await publicClient.waitForTransactionReceipt({ hash: s.hash, timeout: timeoutMs }) } catch (e) {
    if ((e as { name?: string })?.name !== 'WaitForTransactionReceiptTimeoutError') throw e
  }
  if (receipt && receipt.status !== 'success') return { status: 'reverted', hash: s.hash, taken: [] }
  // cancel() marks every nonce used; anything filled before it landed shows up as a SwapERC20 event, not a Cancel.
  // Without a receipt we cannot tell yet.
  if (!receipt) return { status: 'timeout', hash: s.hash, taken: [] }
  const cancelled = new Set(receipt.logs.filter((l) => getAddress(l.address) === swapAddr && l.topics[0] === CANCEL_TOPIC).map((l) => BigInt(l.topics[1] as Hex)))
  const taken = list.filter((n) => !cancelled.has(n))
  return { status: taken.length ? 'partly_taken' : 'cancelled', hash: s.hash, receipt, taken, ...(s.downgraded ? { downgraded: s.downgraded } : {}) }
}

// ------------------------------------------------------------------ price guards (pure)

export type PriceLevel = 'ok' | 'warn' | 'danger'
/**
 * How much better than the market an offer is for whoever takes it — what a bot looks for.
 * side: 'sell' (signer gives base) or 'buy' (signer gives quote); price: quote per base; mid: book mid.
 * positive deviation = cheaper than market for the taker. Thresholds are inclusive (exactly 2.00 % → warn).
 */
export function priceCheck({ side, price, mid, warnBps = 200, dangerBps = 1000 }: { side: 'sell' | 'buy'; price: number; mid: number; warnBps?: number; dangerBps?: number }): { level: PriceLevel; deviationBps: number } {
  if (!(price > 0) || !(mid > 0)) return { level: 'ok', deviationBps: 0 }
  const dev = side === 'sell' ? (mid - price) / mid : (price - mid) / mid
  const bps = Math.round(dev * 10_000)
  return { level: bps >= dangerBps ? 'danger' : bps >= warnBps ? 'warn' : 'ok', deviationBps: bps }
}

/** An open offer the market has moved past: takers (and bots) get it below market. */
export const isStale = ({ side, price, mid, staleBps = 100 }: { side: 'sell' | 'buy'; price: number; mid: number; staleBps?: number }): boolean =>
  priceCheck({ side, price, mid, warnBps: staleBps }).level !== 'ok'

/** Expiry defaults: short by default, longer ones flagged (a long-lived fixed price is a free option for bots). */
export const EXPIRY = { defaultSec: 3600, warnAboveSec: 86_400 } as const
