// MEV protection on the user's side: private submission and price guards. No server involvement.
//
// Private submission: the signed transaction goes to a protected RPC instead of the public mempool, so a bot cannot
// copy a fill (or a cancel) and land it first. The endpoints below also have revert protection: a transaction that
// would fail (offer already taken) is not included, so it costs no gas — it simply never lands.
//
// It works when this code signs the transaction itself (local account: bots, scripts, embedded wallets). A browser
// wallet (json-rpc account) broadcasts through its own RPC: we cannot redirect it, so mode = 'wallet' and the UI
// explains how to turn protection on in the wallet.
import { createClient, http, fallback, encodeFunctionData, getAddress, parseAbi, BaseError, UserRejectedRequestError } from 'viem'
import { prepareTransactionRequest } from 'viem/actions'

/** Protected endpoints with revert protection, per chain. L2s with a sequencer have no public mempool to protect from. */
export const PROTECTED_RPC = {
  1: ['https://rpc.mevblocker.io/noreverts', 'https://rpc.flashbots.net/fast'],
}
export const SEQUENCER_CHAINS = new Set([8453, 10, 42161]) // Base, OP Mainnet, Arbitrum One

/**
 * @param opts { publicClient, walletClient, chainId, privateTransport?, onUpdate? }
 *   privateTransport: a viem transport to use instead of PROTECTED_RPC[chainId] (tests, a paid endpoint, your own relay)
 * @returns { mode: 'private'|'wallet', why, send(request) → { hash } | { rejected: true } }
 */
export function createSubmitter({ publicClient, walletClient, chainId, privateTransport, onUpdate = () => {} }) {
  const account = walletClient.account
  const local = account && account.type === 'local' && typeof account.signTransaction === 'function'
  const urls = PROTECTED_RPC[chainId] || []
  const transport = privateTransport || (urls.length ? fallback(urls.map((u) => http(u, { retryCount: 1, timeout: 10_000 })), { rank: false }) : null)
  const mode = local && transport ? 'private' : 'wallet'
  const why = mode === 'private' ? 'private_rpc'
    : SEQUENCER_CHAINS.has(Number(chainId)) ? 'sequencer' // no public mempool on this chain
    : !transport ? 'no_private_rpc' : 'browser_wallet' // the wallet's own RPC decides
  const priv = transport ? createClient({ transport, chain: walletClient.chain }) : null

  const rejected = (e) => (e instanceof BaseError && e.walk((x) => x instanceof UserRejectedRequestError)) || e?.code === 4001

  async function send(request) {
    try {
      if (mode === 'wallet') return { hash: await walletClient.writeContract(request) }
      const data = encodeFunctionData({ abi: request.abi, functionName: request.functionName, args: request.args })
      // 'latest', not 'pending': a private transaction that was never included (revert protection) frees its nonce,
      // and the next one must take it over instead of queueing behind it
      const nonce = await publicClient.getTransactionCount({ address: account.address, blockTag: 'latest' })
      const tx = await prepareTransactionRequest(publicClient, { account, chain: walletClient.chain, to: getAddress(request.address), data, value: request.value ?? 0n, nonce })
      const raw = await account.signTransaction(tx)
      const hash = await priv.request({ method: 'eth_sendRawTransaction', params: [raw] })
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

/**
 * Cancel offers through the submitter (private when possible): a public cancel can be seen in the mempool and
 * front-run by a fill. Resolves { status: 'cancelled'|'partly_taken'|'rejected'|'timeout'|'reverted', taken: [nonces] }.
 */
export async function cancelOrders({ publicClient, walletClient, submitter, swap, nonces, timeoutMs = 180_000 }) {
  swap = getAddress(swap)
  const list = nonces.map(BigInt)
  const { request } = await publicClient.simulateContract({ account: walletClient.account, chain: walletClient.chain, address: swap, abi: CANCEL_ABI, functionName: 'cancel', args: [list] })
  const s = await submitter.send(request)
  if (s.rejected) return { status: 'rejected', taken: [] }
  let receipt = null
  try { receipt = await publicClient.waitForTransactionReceipt({ hash: s.hash, timeout: timeoutMs }) } catch (e) {
    if (e?.name !== 'WaitForTransactionReceiptTimeoutError') throw e
  }
  if (receipt && receipt.status !== 'success') return { status: 'reverted', hash: s.hash, taken: [] }
  // cancel() marks every nonce used; anything filled before it landed shows up as a SwapERC20 event, not a Cancel.
  // Without a receipt we cannot tell yet.
  if (!receipt) return { status: 'timeout', hash: s.hash, taken: [] }
  const cancelled = new Set(receipt.logs.filter((l) => getAddress(l.address) === swap && l.topics[0] === CANCEL_TOPIC).map((l) => BigInt(l.topics[1])))
  const taken = list.filter((n) => !cancelled.has(n))
  return { status: taken.length ? 'partly_taken' : 'cancelled', hash: s.hash, receipt, taken }
}
const CANCEL_TOPIC = '0x8dd3c361eb2366ff27c2db0eb07b9261f1d052570742ab8c9a0c326f37aa576d' // Cancel(uint256,address)

// ------------------------------------------------------------------ price guards (pure)

/**
 * How much better than the market an offer is for whoever takes it — what a bot looks for.
 * side: 'sell' (signer gives base) or 'buy' (signer gives quote); price: quote per base; mid: book mid.
 * @returns { level: 'ok'|'warn'|'danger', deviationBps } — positive deviation = cheaper than market for the taker
 */
export function priceCheck({ side, price, mid, warnBps = 200, dangerBps = 1000 }) {
  if (!(price > 0) || !(mid > 0)) return { level: 'ok', deviationBps: 0 }
  const dev = side === 'sell' ? (mid - price) / mid : (price - mid) / mid
  const bps = Math.round(dev * 10_000)
  return { level: bps >= dangerBps ? 'danger' : bps >= warnBps ? 'warn' : 'ok', deviationBps: bps }
}

/** An open offer the market has moved past: takers (and bots) get it below market. */
export const isStale = ({ side, price, mid, staleBps = 100 }) => priceCheck({ side, price, mid, warnBps: staleBps }).level !== 'ok'

/** Expiry defaults: short by default, longer ones flagged (a long-lived fixed price is a free option for bots). */
export const EXPIRY = { defaultSec: 3600, warnAboveSec: 86_400 }
