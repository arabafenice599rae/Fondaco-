// Taker-side execution for AirSwap SwapERC20 v4.3 (browser or Node, viem only).
//
//  1. plan()     whole signed orders from the book → an INDICATIVE quote (orders are all-or-nothing)
//  2. verify()   one batched read: SwapERC20.check() per leg (signature, nonce, expiry, signer funds at the
//                current fee) + the taker's own balance/allowance → a VERIFIED quote, or a list of problems
//  3. execute()  approve if needed, then per leg: eth_call simulation of swapAnySender right before sending,
//                send, track the transaction through pending / sped up / cancelled / replaced / reverted.
//
// The recipient is never a parameter: every call pays out to the connected account, and the encoded calldata
// is decoded and checked against it before it is handed to the wallet.
import {
  parseAbi, decodeFunctionData, decodeErrorResult, encodeFunctionData, getAddress, hexToString, maxUint256, zeroAddress, BaseError,
  ContractFunctionRevertedError, UserRejectedRequestError, type Address, type Hex, type PublicClient, type WalletClient, type TransactionReceipt,
} from 'viem'
import type {
  StopReason, BookEntry, DroppedLeg, ExecuteResult, IndicativeQuote, Leg, Order, OrderInput, Reason, SendResult, SubmitMode, SubmitWhy, TakerEvent, Tracked, VerifiedQuote,
} from './types.js'

export const SWAP_TAKER_ABI = parseAbi([
  'function swapAnySender(address recipient, uint256 nonce, uint256 expiry, address signerWallet, address signerToken, uint256 signerAmount, address senderToken, uint256 senderAmount, uint8 v, bytes32 r, bytes32 s)',
  'function swap(address recipient, uint256 nonce, uint256 expiry, address signerWallet, address signerToken, uint256 signerAmount, address senderToken, uint256 senderAmount, uint8 v, bytes32 r, bytes32 s)',
  'function check(address senderWallet, uint256 nonce, uint256 expiry, address signerWallet, address signerToken, uint256 signerAmount, address senderToken, uint256 senderAmount, uint8 v, bytes32 r, bytes32 s) view returns (bytes32[])',
  'function nonceUsed(address signer, uint256 nonce) view returns (bool)',
  'function protocolFee() view returns (uint256)',
  'error NonceAlreadyUsed(uint256)',
  'error OrderExpired()',
  'error SignatureInvalid()',
  'error SignatoryInvalid()',
  'error TransferFromFailed()',
])
const ERC20_ABI = parseAbi([
  'function balanceOf(address) view returns (uint256)',
  'function allowance(address owner, address spender) view returns (uint256)',
])
// No return value declared: USDT-style tokens return nothing, and simulation must not fail on decoding.
const APPROVE_ABI = parseAbi(['function approve(address spender, uint256 amount)'])
const FEE_DIVISOR = 10_000n
export const MULTICALL3: Address = '0xcA11bde05977b3631167028862bE2a173976CA11' // same address on every major EVM chain

/** Reasons, with the Italian copy the UI shows. `costsGas` = the user paid for a mined, reverted transaction. */
export const REASONS: Record<Reason, string> = {
  taken: 'Offerta già presa da un altro',
  expired: 'Offerta scaduta',
  signature: 'Firma dell’offerta non valida',
  signer_funds: 'Chi ha proposto non ha più fondi sufficienti',
  taker_balance: 'Saldo insufficiente',
  taker_allowance: 'Autorizzazione insufficiente',
  private: 'Offerta riservata a un altro indirizzo',
  rejected: 'Firma rifiutata nel wallet',
  cancelled: 'Transazione annullata dal wallet',
  replaced: 'Transazione sostituita da un’altra',
  timeout: 'Nessuna conferma entro il tempo limite',
  reverted: 'Transazione fallita',
  not_included: 'Presa da un altro: la tua transazione non è stata inclusa, nessun costo',
  unknown: 'Errore sconosciuto',
  recipient_guard: 'Invio bloccato: la transazione non pagava il tuo wallet sul contratto previsto',
  private_unavailable: 'Invio protetto non disponibile: nessuna transazione inviata',
}

const big = (x: unknown) => BigInt(x as string | number | bigint)
const norm = (o: OrderInput): Order => ({
  nonce: big(o.nonce), expiry: big(o.expiry), signerWallet: getAddress(String(o.signerWallet)), signerToken: getAddress(String(o.signerToken)),
  signerAmount: big(o.signerAmount), protocolFee: big(o.protocolFee), senderWallet: getAddress((o.senderWallet as string) || zeroAddress),
  senderToken: getAddress(String(o.senderToken)), senderAmount: big(o.senderAmount), v: Number(o.v), r: o.r as Hex, s: o.s as Hex,
})
const orderArgs = (recipient: Address | null, o: Order) => [recipient, o.nonce, o.expiry, o.signerWallet, o.signerToken, o.signerAmount, o.senderToken, o.senderAmount, o.v, o.r, o.s] as const

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

/** A way to send transactions: the wallet itself, or a private (MEV-protected) submitter from ./protect.js. */
export interface Submitter {
  mode: SubmitMode
  why: SubmitWhy
  private: boolean
  send(request: ContractRequest): Promise<SendResult>
}
/** A simulated contract call, as returned by viem's simulateContract (what is handed to the wallet). */
export interface ContractRequest { address: Address; abi: readonly unknown[]; functionName: string; args?: readonly unknown[]; value?: bigint; [k: string]: unknown }

export interface TakerOptions {
  publicClient: PublicClient
  walletClient: WalletClient
  swap: Address
  confirmations?: number
  timeoutMs?: number
  multicallAddress?: Address
  onUpdate?: (e: TakerEvent) => void
  /** private (MEV-protected) submission when available: createSubmitter(...) from ./protect.js */
  submitter?: Submitter
  /** a private transaction that would revert is never included, so it ends in a timeout */
  privateTimeoutMs?: number
}
export interface Taker {
  address: Address
  plan: typeof plan
  verify(p: IndicativeQuote): Promise<VerifiedQuote>
  execute(q: VerifiedQuote, opts?: { approval?: 'exact' | 'max' }): Promise<ExecuteResult>
  track(hash: Hex, ctx: Record<string, unknown>, timeout?: number): Promise<Tracked>
}

/** Taker for one connected account. `walletClient.account` is the only possible recipient. */
export function createTaker({ publicClient, walletClient, swap, confirmations = 1, timeoutMs = 300_000, multicallAddress = MULTICALL3, onUpdate = () => {}, submitter, privateTimeoutMs = 120_000 }: TakerOptions): Taker {
  if (!walletClient?.account) throw new Error('walletClient must have a connected account')
  const account = walletClient.account
  const me = getAddress(account.address)
  const swapAddr = getAddress(swap)
  const emit = (e: TakerEvent) => { try { onUpdate(e) } catch { /* UI errors must not break execution */ } }

  const callFor = (o: Order): 'swapAnySender' | 'swap' | null => {
    if (o.senderWallet === zeroAddress) return 'swapAnySender'
    if (o.senderWallet === me) return 'swap' // private order addressed to us
    return null
  }

  /**
   * Calldata guard, run on the exact request handed to the wallet/submitter: the calldata THAT request encodes (with its own
   * abi, function and args) must be byte-identical to swapAnySender/swap(recipient = connected account, this order) on the
   * configured SwapERC20. Anything else — another contract, another function, another recipient, a swapped ABI — is refused.
   * @returns null if it pays the connected account as expected, otherwise why it was refused
   */
  function guard(request: ContractRequest, functionName: 'swapAnySender' | 'swap', o: Order): string | null {
    try {
      if (getAddress(request.address) !== swapAddr) return `target ${request.address} is not the configured SwapERC20 ${swapAddr}`
      const actual = encodeFunctionData({ abi: request.abi, functionName: request.functionName, args: request.args } as never)
      const expected = encodeFunctionData({ abi: SWAP_TAKER_ABI, functionName, args: orderArgs(me, o) as never })
      if (actual === expected) return null
      try {
        const d = decodeFunctionData({ abi: SWAP_TAKER_ABI, data: actual })
        if (d.functionName !== functionName) return `unexpected call ${d.functionName}`
        if (getAddress(d.args[0] as Address) !== me) return `recipient ${d.args[0]} is not the connected wallet`
      } catch { /* not a SwapERC20 swap call */ }
      return 'calldata differs from the expected swap of this order'
    } catch (e) {
      return `request cannot be checked: ${(e as Error).message}`
    }
  }

  async function takerFunds(token: Address): Promise<{ balance: bigint; allowance: bigint }> {
    const [balance, allowance] = await publicClient.multicall({
      allowFailure: false,
      multicallAddress,
      contracts: [
        { address: token, abi: ERC20_ABI, functionName: 'balanceOf', args: [me] },
        { address: token, abi: ERC20_ABI, functionName: 'allowance', args: [me, swapAddr] },
      ],
    })
    return { balance, allowance }
  }

  const checkReason = (errs: readonly Hex[]): Reason | null => {
    const s = errs.map((e) => hexToString(e, { size: 32 }).replace(/\0+$/, ''))
    if (s.includes('NonceAlreadyUsed')) return 'taken'
    if (s.includes('OrderExpired')) return 'expired'
    if (s.some((x) => x === 'SignatureInvalid' || x === 'SignatoryInvalid' || x === 'Unauthorized')) return 'signature'
    if (s.some((x) => x.startsWith('Signer'))) return 'signer_funds'
    return s.length ? 'unknown' : null
  }

  /**
   * One batched read for the whole plan. Returns a VERIFIED quote over the legs that are still fillable
   * (amounts are fixed by the signatures, so a verified leg can only fail if someone takes it first).
   */
  async function verify(p: IndicativeQuote): Promise<VerifiedQuote> {
    if (!p.legs.length) return { ...p, kind: 'verified', ok: false, legs: [], dropped: [], problems: ['empty'] }
    const token = (p.legs[0] as Leg).order.senderToken
    // cacheTime 0: viem caches the block number (default 4 s); verifying at a stale block can miss a fill that just landed
    const block = await publicClient.getBlockNumber({ cacheTime: 0 })
    const res = await publicClient.multicall({
      blockNumber: block,
      allowFailure: true,
      multicallAddress,
      contracts: [
        { address: token, abi: ERC20_ABI, functionName: 'balanceOf', args: [me] },
        { address: token, abi: ERC20_ABI, functionName: 'allowance', args: [me, swapAddr] },
        // senderWallet in check() is part of the hash: pass the value the order was signed with.
        ...p.legs.map(({ order: o }) => ({ address: swapAddr, abi: SWAP_TAKER_ABI, functionName: 'check', args: [o.senderWallet, ...orderArgs(null, o).slice(1)] })),
      ] as never,
    }) as { status: 'success' | 'failure'; result?: unknown }[]
    const r0 = res[0] as { status: string; result?: unknown }, r1 = res[1] as { status: string; result?: unknown }
    const balance = r0.status === 'success' ? (r0.result as bigint) : 0n
    const allowance = r1.status === 'success' ? (r1.result as bigint) : 0n
    const legs: Leg[] = [], dropped: DroppedLeg[] = []
    p.legs.forEach((l, i) => {
      const r = res[2 + i] as { status: string; result?: unknown }
      const reason: Reason | null = !callFor(l.order) ? 'private' : r.status !== 'success' ? 'unknown' : checkReason(r.result as Hex[])
      if (reason) dropped.push({ ...l, reason, message: REASONS[reason] })
      else legs.push(l)
    })
    const pay = legs.reduce((s, l) => s + l.order.senderAmount, 0n)
    const receive = legs.reduce((s, l) => s + l.order.signerAmount, 0n)
    const problems: VerifiedQuote['problems'] = []
    if (balance < pay) problems.push('taker_balance')
    const out: VerifiedQuote = { kind: 'verified', ok: legs.length > 0 && balance >= pay, block, legs, dropped, pay, receive, left: p.pay + p.left - pay,
      balance, allowance, needsApproval: allowance < pay, problems, at: Date.now(), recipient: me }
    emit({ type: 'verified', quote: out })
    return out
  }

  /** Track a sent transaction to its end state. */
  async function track(hash: Hex, ctx: Record<string, unknown>, timeout: number = sub.private ? privateTimeoutMs : timeoutMs): Promise<Tracked> {
    emit({ type: 'pending', hash, private: sub.private, ...ctx } as TakerEvent)
    let replacedBy: { reason: 'cancelled' | 'replaced' | 'repriced' } | null = null
    let receipt: TransactionReceipt
    try {
      // viem detects a replacement (same sender + nonce, different hash), calls onReplaced, then resolves
      // with the replacing transaction's receipt.
      receipt = await publicClient.waitForTransactionReceipt({
        hash, confirmations, timeout, pollingInterval: publicClient.pollingInterval,
        onReplaced: (r) => { replacedBy = r },
      })
    } catch (e) {
      if ((e as { name?: string })?.name === 'WaitForTransactionReceiptTimeoutError') return { status: 'timeout', hash, reason: 'timeout' }
      throw e
    }
    const rep = replacedBy as { reason: 'cancelled' | 'replaced' | 'repriced' } | null
    if (rep && rep.reason !== 'repriced') {
      // cancelled ("send 0 to self") or a different transaction took the nonce: our call never ran
      return { status: rep.reason, hash: receipt.transactionHash, previous: hash, reason: rep.reason, receipt }
    }
    if (rep) emit({ type: 'sped_up', hash: receipt.transactionHash, previous: hash, ...ctx } as TakerEvent)
    return receipt.status === 'success'
      ? { status: 'mined', hash: receipt.transactionHash, receipt, ...(rep ? { previous: hash } : {}) }
      : { status: 'reverted', hash: receipt.transactionHash, receipt }
  }

  /** Map a simulation error to a reason. */
  function simReason(err: unknown): Reason | 'transfer' {
    if (err instanceof BaseError) {
      const rev = err.walk((x) => x instanceof ContractFunctionRevertedError) as ContractFunctionRevertedError | null
      const name = rev?.data?.errorName
      if (name === 'NonceAlreadyUsed') return 'taken'
      if (name === 'OrderExpired') return 'expired'
      if (name === 'SignatureInvalid' || name === 'SignatoryInvalid') return 'signature'
      if (name === 'TransferFromFailed') return 'transfer'
    }
    return 'unknown'
  }

  /** After a TransferFromFailed or a mined revert: work out which side failed. */
  async function diagnose(o: Order): Promise<Reason> {
    const [used, mine, signerBal, signerAlw] = await Promise.all([
      publicClient.readContract({ address: swapAddr, abi: SWAP_TAKER_ABI, functionName: 'nonceUsed', args: [o.signerWallet, o.nonce] }),
      takerFunds(o.senderToken),
      publicClient.readContract({ address: o.signerToken, abi: ERC20_ABI, functionName: 'balanceOf', args: [o.signerWallet] }),
      publicClient.readContract({ address: o.signerToken, abi: ERC20_ABI, functionName: 'allowance', args: [o.signerWallet, swapAddr] }),
    ])
    if (used) return 'taken'
    if (mine.balance < o.senderAmount) return 'taker_balance'
    if (mine.allowance < o.senderAmount) return 'taker_allowance'
    const need = o.signerAmount + (o.signerAmount * o.protocolFee) / FEE_DIVISOR
    if (signerBal < need || signerAlw < need) return 'signer_funds'
    const now = (await publicClient.getBlock()).timestamp
    if (o.expiry < now) return 'expired'
    return 'reverted'
  }

  async function walletSend(request: ContractRequest): Promise<SendResult> {
    try {
      const hash = await walletClient.writeContract(request as never)
      return { hash }
    } catch (e) {
      if (e instanceof BaseError && e.walk((x) => x instanceof UserRejectedRequestError)) return { rejected: true }
      if ((e as { code?: number })?.code === 4001) return { rejected: true }
      throw e
    }
  }
  const sub: Submitter = submitter || { mode: 'wallet', why: 'not_configured', private: false, send: walletSend }
  const send = (request: ContractRequest) => sub.send(request)

  type ApproveOutcome = { status: 'mined'; receipt: TransactionReceipt } | { status: 'stopped'; reason: StopReason; receipt?: TransactionReceipt }
  const stopFrom = (t: Exclude<Tracked, { status: 'mined' }>): ApproveOutcome =>
    ({ status: 'stopped', reason: 'reason' in t ? t.reason : 'reverted', ...('receipt' in t ? { receipt: t.receipt } : {}) })

  /** Approve exactly `amount` (or unlimited). Handles tokens that require resetting to 0 first (e.g. USDT). */
  async function approve(token: Address, amount: bigint, current: bigint): Promise<ApproveOutcome> {
    const base = { account, chain: walletClient.chain, address: token, abi: APPROVE_ABI, functionName: 'approve' as const }
    let direct = true
    try { await publicClient.simulateContract({ ...base, args: [swapAddr, amount] }) } catch { direct = false }
    if (!direct && current > 0n) {
      emit({ type: 'approval_reset', token })
      const r0 = await send({ ...base, args: [swapAddr, 0n] } as ContractRequest)
      if ('rejected' in r0) return { status: 'stopped', reason: 'rejected' }
      if ('unavailable' in r0) { emit({ type: 'private_unavailable', error: r0.error }); return { status: 'stopped', reason: 'private_unavailable' } }
      const t0 = await track(r0.hash, { step: 'approve_reset' })
      if (t0.status !== 'mined') return stopFrom(t0)
    }
    emit({ type: 'approving', token, amount })
    const r = await send({ ...base, args: [swapAddr, amount] } as ContractRequest)
    if ('rejected' in r) return { status: 'stopped', reason: 'rejected' }
    if ('unavailable' in r) { emit({ type: 'private_unavailable', error: r.error }); return { status: 'stopped', reason: 'private_unavailable' } }
    if (r.downgraded) emit({ type: 'protection_downgraded', from: 'private', to: 'wallet', error: r.downgraded })
    const t = await track(r.hash, { step: 'approve' })
    return t.status === 'mined' ? { status: 'mined', receipt: t.receipt } : stopFrom(t)
  }

  /**
   * Execute a verified quote. Legs are separate transactions (all-or-nothing each): a leg that is no longer
   * available at simulation time is skipped at no cost; a user rejection, cancellation or replacement stops the run.
   */
  async function execute(q: VerifiedQuote, { approval = 'exact' }: { approval?: 'exact' | 'max' } = {}): Promise<ExecuteResult> {
    if (q.kind !== 'verified') throw new Error('execute() needs a verified quote: call verify() first')
    const result: ExecuteResult = { filled: [], skipped: [...q.dropped], failed: [], stopped: null, paid: 0n, received: 0n, gasCostWei: 0n, protection: sub.mode }
    emit({ type: 'protection', mode: sub.mode, why: sub.why })
    if (!q.ok) { result.stopped = q.problems[0] || 'empty'; emit({ type: 'done', result }); return result }
    const token = (q.legs[0] as Leg).order.senderToken, outToken = (q.legs[0] as Leg).order.signerToken

    const funds = await takerFunds(token)
    if (funds.balance < q.pay) { result.stopped = 'taker_balance'; emit({ type: 'done', result }); return result }
    if (funds.allowance < q.pay) {
      const a = await approve(token, approval === 'max' ? maxUint256 : q.pay, funds.allowance)
      if (a.receipt) result.gasCostWei += a.receipt.gasUsed * a.receipt.effectiveGasPrice
      if (a.status !== 'mined') { result.stopped = a.reason; emit({ type: 'done', result }); return result }
    }

    for (let i = 0; i < q.legs.length; i++) {
      const leg = q.legs[i] as Leg, o = leg.order, ctx = { leg: i, of: q.legs.length, orderHash: leg.hash }
      const functionName = callFor(o) as 'swapAnySender' | 'swap'
      // 1) eth_call right before the send: catches orders taken since verify(), and our own funds
      emit({ type: 'simulating', ...ctx })
      let request: ContractRequest
      try {
        ;({ request } = await publicClient.simulateContract({ account, chain: walletClient.chain, address: swapAddr, abi: SWAP_TAKER_ABI, functionName, args: orderArgs(me, o) as never }) as unknown as { request: ContractRequest })
      } catch (e) {
        let reason: Reason | 'transfer' = simReason(e)
        if (reason === 'transfer' || reason === 'unknown') reason = await diagnose(o)
        result.skipped.push({ ...leg, reason, message: REASONS[reason], costsGas: false })
        emit({ type: 'skipped', reason, message: REASONS[reason], ...ctx })
        if (reason === 'taker_balance' || reason === 'taker_allowance') { result.stopped = reason; break }
        continue
      }
      const refused = guard(request, functionName, o)
      if (refused) {
        // nothing is sent: a component between us and the wallet altered the call
        result.stopped = 'recipient_guard'
        emit({ type: 'blocked', reason: 'recipient_guard', message: refused, ...ctx })
        break
      }

      // 2) send
      emit({ type: 'awaiting_signature', ...ctx })
      const s = await send(request)
      if ('rejected' in s) { result.stopped = 'rejected'; emit({ type: 'rejected', ...ctx }); break }
      if ('unavailable' in s) { result.stopped = 'private_unavailable'; emit({ type: 'private_unavailable', error: s.error }); break }
      if (s.downgraded) { result.protection = 'wallet'; result.downgraded = true; emit({ type: 'protection_downgraded', from: 'private', to: 'wallet', error: s.downgraded }) }

      // 3) track
      const t = await track(s.hash, ctx)
      if ('receipt' in t && t.receipt) result.gasCostWei += t.receipt.gasUsed * t.receipt.effectiveGasPrice
      if (t.status === 'mined') {
        const received = receivedFrom(t.receipt, outToken, me)
        result.filled.push({ ...leg, txHash: t.hash, received })
        result.paid += o.senderAmount
        result.received += received
        emit({ type: 'filled', txHash: t.hash, received, ...ctx })
      } else if (t.status === 'reverted') {
        const reason = await diagnose(o)
        result.failed.push({ ...leg, txHash: t.hash, reason, message: REASONS[reason], costsGas: true })
        emit({ type: 'failed', txHash: t.hash, reason, message: REASONS[reason], costsGas: true, ...ctx })
        if (reason === 'taker_balance' || reason === 'taker_allowance') { result.stopped = reason; break }
      } else if (t.status === 'timeout' && sub.private && (await diagnose(o)) === 'taken') {
        // revert protection: someone took the offer first, our transaction was never included — free, go on
        result.skipped.push({ ...leg, txHash: t.hash, reason: 'not_included', message: REASONS.not_included, costsGas: false })
        emit({ type: 'skipped', reason: 'not_included', message: REASONS.not_included, txHash: t.hash, ...ctx })
      } else {
        // cancelled / replaced / timeout: the wallet no longer runs our call (or we cannot tell) → stop, do not guess
        const st = t.status as 'cancelled' | 'replaced' | 'timeout'
        result.failed.push({ ...leg, txHash: t.hash, reason: st, message: REASONS[st], costsGas: st !== 'timeout' })
        result.stopped = st
        emit({ type: st, txHash: t.hash, ...ctx })
        break
      }
    }
    emit({ type: 'done', result })
    return result
  }

  return { address: me, plan, verify, execute, track }
}

/** Sum of `token` transfers to `to` in a receipt: what actually arrived, not what was quoted. */
export function receivedFrom(receipt: Pick<TransactionReceipt, 'logs'>, token: Address, to: Address): bigint {
  let sum = 0n
  for (const log of receipt.logs) {
    if (getAddress(log.address) !== getAddress(token)) continue
    try {
      const ev = decodeTransfer(log)
      if (ev && getAddress(ev.to) === getAddress(to)) sum += ev.value
    } catch { /* not a Transfer */ }
  }
  return sum
}
const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef'
function decodeTransfer(log: { topics: readonly Hex[]; data: Hex }): { from: Address; to: Address; value: bigint } | null {
  if (log.topics[0] !== TRANSFER_TOPIC || log.topics.length < 3) return null
  return { from: `0x${(log.topics[1] as Hex).slice(26)}` as Address, to: `0x${(log.topics[2] as Hex).slice(26)}` as Address, value: BigInt(log.data) }
}

/** Helper for SDKs that want the reason of a revert from raw data. */
export const decodeSwapError = (data: Hex): string | null => { try { return decodeErrorResult({ abi: SWAP_TAKER_ABI, data }).errorName } catch { return null } }
