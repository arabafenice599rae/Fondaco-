// Taker-side execution for AirSwap SwapERC20 v5.0.0 (browser or Node, viem only).
//
//  1. plan()     whole signed orders from the book → an INDICATIVE quote (orders are all-or-nothing)
//  2. verify()   one batched read: SwapERC20.check() per leg (signature, nonce, expiry, signer funds at the
//                current fee) + the taker's own balance/allowance → a VERIFIED quote, or a list of problems
//  3. execute()  approve if needed, then per leg: eth_call simulation of swapAnySender right before sending,
//                send, track the transaction through pending / sped up / cancelled / replaced / reverted.
//
// The recipient is never a parameter: every call pays out to the connected account, and the encoded calldata
// is decoded and checked against it before it is handed to the wallet.
import { parseAbi, decodeFunctionData, decodeErrorResult, encodeFunctionData, getAddress, hexToString, maxUint256, zeroAddress, BaseError, ContractFunctionRevertedError, UserRejectedRequestError } from 'viem'

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
const MULTICALL3 = '0xcA11bde05977b3631167028862bE2a173976CA11' // same address on every major EVM chain

/** Reasons, with the Italian copy the UI shows. `costsGas` = the user paid for a mined, reverted transaction. */
export const REASONS = {
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
}

const big = (x) => BigInt(x)
const norm = (o) => ({
  nonce: big(o.nonce), expiry: big(o.expiry), signerWallet: getAddress(o.signerWallet), signerToken: getAddress(o.signerToken),
  signerAmount: big(o.signerAmount), protocolFee: big(o.protocolFee), senderWallet: getAddress(o.senderWallet || zeroAddress),
  senderToken: getAddress(o.senderToken), senderAmount: big(o.senderAmount), v: Number(o.v), r: o.r, s: o.s,
})
const orderArgs = (recipient, o) => [recipient, o.nonce, o.expiry, o.signerWallet, o.signerToken, o.signerAmount, o.senderToken, o.senderAmount, o.v, o.r, o.s]

/**
 * Indicative plan: take whole orders best-first while the cumulative payment stays ≤ `pay`.
 * @param entries book side, best first: [{ hash, order }] (GET /book?signed=1 → asks to buy base, bids to sell base)
 * @param pay amount of senderToken the taker wants to spend (bigint, base units)
 */
export function plan(entries, pay) {
  const legs = []
  let paid = 0n, got = 0n
  for (const e of entries) {
    const o = norm(e.order)
    if (o.senderWallet !== zeroAddress) continue // private orders never come from the public book
    if (legs.length && (o.senderToken !== legs[0].order.senderToken || o.signerToken !== legs[0].order.signerToken)) continue
    if (paid + o.senderAmount > pay) continue // all-or-nothing: a bigger order further down may not fit either, a smaller one may
    legs.push({ hash: e.hash, order: o })
    paid += o.senderAmount
    got += o.signerAmount
  }
  return { kind: 'indicative', legs, pay: paid, receive: got, left: pay - paid, at: Date.now() }
}

/**
 * Taker for one connected account. `walletClient.account` is the only possible recipient.
 * @param opts { publicClient, walletClient, swap, confirmations = 1, timeoutMs = 300_000, multicallAddress, onUpdate(event),
 *   submitter?: createSubmitter(...) from ./protect.js — private (MEV-protected) submission when available,
 *   privateTimeoutMs = 120_000: a private transaction that would revert is never included, so it ends in a timeout }
 */
export function createTaker({ publicClient, walletClient, swap, confirmations = 1, timeoutMs = 300_000, multicallAddress = MULTICALL3, onUpdate = () => {}, submitter, privateTimeoutMs = 120_000 }) {
  if (!walletClient?.account) throw new Error('walletClient must have a connected account')
  const account = walletClient.account
  const me = getAddress(account.address)
  swap = getAddress(swap)
  const emit = (e) => { try { onUpdate(e) } catch { /* UI errors must not break execution */ } }

  const callFor = (o) => {
    if (o.senderWallet === zeroAddress) return 'swapAnySender'
    if (o.senderWallet === me) return 'swap' // private order addressed to us
    return null
  }

  /** Calldata guard: whatever is about to be signed must pay out to the connected account, on our contract. */
  function assertPaysMe(to, data) {
    if (getAddress(to) !== swap) throw new Error(`refusing to send to ${to}: not the configured SwapERC20`)
    const { functionName, args } = decodeFunctionData({ abi: SWAP_TAKER_ABI, data })
    if (functionName !== 'swapAnySender' && functionName !== 'swap') throw new Error(`unexpected call ${functionName}`)
    if (getAddress(args[0]) !== me) throw new Error(`recipient ${args[0]} is not the connected wallet`)
  }

  async function takerFunds(token) {
    const [balance, allowance] = await publicClient.multicall({
      allowFailure: false,
      multicallAddress,
      contracts: [
        { address: token, abi: ERC20_ABI, functionName: 'balanceOf', args: [me] },
        { address: token, abi: ERC20_ABI, functionName: 'allowance', args: [me, swap] },
      ],
    })
    return { balance, allowance }
  }

  const checkReason = (errs) => {
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
  async function verify(p) {
    if (!p.legs.length) return { ...p, kind: 'verified', ok: false, legs: [], dropped: [], problems: ['empty'] }
    const token = p.legs[0].order.senderToken
    const block = await publicClient.getBlockNumber()
    const res = await publicClient.multicall({
      blockNumber: block,
      allowFailure: true,
      multicallAddress,
      contracts: [
        { address: token, abi: ERC20_ABI, functionName: 'balanceOf', args: [me] },
        { address: token, abi: ERC20_ABI, functionName: 'allowance', args: [me, swap] },
        // senderWallet in check() is part of the hash: pass the value the order was signed with.
        ...p.legs.map(({ order: o }) => ({ address: swap, abi: SWAP_TAKER_ABI, functionName: 'check', args: [o.senderWallet, ...orderArgs(null, o).slice(1)] })),
      ],
    })
    const balance = res[0].status === 'success' ? res[0].result : 0n
    const allowance = res[1].status === 'success' ? res[1].result : 0n
    const legs = [], dropped = []
    p.legs.forEach((l, i) => {
      const r = res[2 + i]
      const reason = !callFor(l.order) ? 'private' : r.status !== 'success' ? 'unknown' : checkReason(r.result)
      if (reason) dropped.push({ ...l, reason, message: REASONS[reason] })
      else legs.push(l)
    })
    const pay = legs.reduce((s, l) => s + l.order.senderAmount, 0n)
    const receive = legs.reduce((s, l) => s + l.order.signerAmount, 0n)
    const problems = []
    if (balance < pay) problems.push('taker_balance')
    const out = { kind: 'verified', ok: legs.length > 0 && balance >= pay, block, legs, dropped, pay, receive, left: p.pay + p.left - pay,
      balance, allowance, needsApproval: allowance < pay, problems, at: Date.now(), recipient: me }
    emit({ type: 'verified', quote: out })
    return out
  }

  /** Track a sent transaction to its end state. Resolves { status, hash, receipt?, reason? }. */
  async function track(hash, ctx, timeout = sub.private ? privateTimeoutMs : timeoutMs) {
    emit({ type: 'pending', hash, private: sub.private, ...ctx })
    let replacedBy = null
    let receipt
    try {
      // viem detects a replacement (same sender + nonce, different hash), calls onReplaced, then resolves
      // with the replacing transaction's receipt.
      receipt = await publicClient.waitForTransactionReceipt({
        hash, confirmations, timeout, pollingInterval: publicClient.pollingInterval,
        onReplaced: (r) => { replacedBy = r },
      })
    } catch (e) {
      if (e?.name === 'WaitForTransactionReceiptTimeoutError') return { status: 'timeout', hash, reason: 'timeout' }
      throw e
    }
    if (replacedBy && replacedBy.reason !== 'repriced') {
      // cancelled ("send 0 to self") or a different transaction took the nonce: our call never ran
      return { status: replacedBy.reason, hash: receipt.transactionHash, previous: hash, reason: replacedBy.reason, receipt }
    }
    if (replacedBy) emit({ type: 'sped_up', hash: receipt.transactionHash, previous: hash, ...ctx })
    return receipt.status === 'success' ? { status: 'mined', hash: receipt.transactionHash, receipt, previous: replacedBy ? hash : undefined }
      : { status: 'reverted', hash: receipt.transactionHash, receipt }
  }

  /** Map a simulation error to a reason. */
  function simReason(err) {
    if (err instanceof BaseError) {
      const rev = err.walk((x) => x instanceof ContractFunctionRevertedError)
      const name = rev?.data?.errorName
      if (name === 'NonceAlreadyUsed') return 'taken'
      if (name === 'OrderExpired') return 'expired'
      if (name === 'SignatureInvalid' || name === 'SignatoryInvalid') return 'signature'
      if (name === 'TransferFromFailed') return 'transfer'
    }
    return 'unknown'
  }

  /** After a TransferFromFailed or a mined revert: work out which side failed. */
  async function diagnose(o) {
    const [used, mine, signerBal, signerAlw] = await Promise.all([
      publicClient.readContract({ address: swap, abi: SWAP_TAKER_ABI, functionName: 'nonceUsed', args: [o.signerWallet, o.nonce] }),
      takerFunds(o.senderToken),
      publicClient.readContract({ address: o.signerToken, abi: ERC20_ABI, functionName: 'balanceOf', args: [o.signerWallet] }),
      publicClient.readContract({ address: o.signerToken, abi: ERC20_ABI, functionName: 'allowance', args: [o.signerWallet, swap] }),
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

  async function walletSend(request) {
    try {
      const hash = await walletClient.writeContract(request)
      return { hash }
    } catch (e) {
      if (e instanceof BaseError && e.walk((x) => x instanceof UserRejectedRequestError)) return { rejected: true }
      if (e?.code === 4001) return { rejected: true }
      throw e
    }
  }
  const sub = submitter || { mode: 'wallet', why: 'not_configured', private: false, send: walletSend }
  const send = (request) => sub.send(request)

  /** Approve exactly `amount` (or unlimited). Handles tokens that require resetting to 0 first (e.g. USDT). */
  async function approve(token, amount, current) {
    const base = { account, chain: walletClient.chain, address: token, abi: APPROVE_ABI, functionName: 'approve' }
    let direct = true
    try { await publicClient.simulateContract({ ...base, args: [swap, amount] }) } catch { direct = false }
    if (!direct && current > 0n) {
      emit({ type: 'approval_reset', token })
      const r0 = await send({ ...base, args: [swap, 0n] })
      if (r0.rejected) return { status: 'rejected', reason: 'rejected' }
      const t0 = await track(r0.hash, { step: 'approve_reset' })
      if (t0.status !== 'mined') return { ...t0, reason: t0.reason || 'reverted' }
    }
    emit({ type: 'approving', token, amount })
    const r = await send({ ...base, args: [swap, amount] })
    if (r.rejected) return { status: 'rejected', reason: 'rejected' }
    const t = await track(r.hash, { step: 'approve' })
    return t.status === 'mined' ? t : { ...t, reason: t.reason || 'reverted' }
  }

  /**
   * Execute a verified quote. Legs are separate transactions (all-or-nothing each): a leg that is no longer
   * available at simulation time is skipped at no cost; a user rejection, cancellation or replacement stops the run.
   * @param q result of verify()
   * @param opts { approval: 'exact' | 'max' }
   */
  async function execute(q, { approval = 'exact' } = {}) {
    if (q.kind !== 'verified') throw new Error('execute() needs a verified quote: call verify() first')
    const result = { filled: [], skipped: [...q.dropped], failed: [], stopped: null, paid: 0n, received: 0n, gasCostWei: 0n, protection: sub.mode }
    emit({ type: 'protection', mode: sub.mode, why: sub.why })
    if (!q.ok) { result.stopped = q.problems[0] || 'empty'; emit({ type: 'done', result }); return result }
    const token = q.legs[0].order.senderToken, outToken = q.legs[0].order.signerToken

    const funds = await takerFunds(token)
    if (funds.balance < q.pay) { result.stopped = 'taker_balance'; emit({ type: 'done', result }); return result }
    if (funds.allowance < q.pay) {
      const a = await approve(token, approval === 'max' ? maxUint256 : q.pay, funds.allowance)
      if (a.receipt) result.gasCostWei += a.receipt.gasUsed * a.receipt.effectiveGasPrice
      if (a.status !== 'mined') { result.stopped = a.reason || a.status; emit({ type: 'done', result }); return result }
    }

    for (let i = 0; i < q.legs.length; i++) {
      const leg = q.legs[i], o = leg.order, ctx = { leg: i, of: q.legs.length, orderHash: leg.hash }
      const functionName = callFor(o)
      // 1) eth_call right before the send: catches orders taken since verify(), and our own funds
      emit({ type: 'simulating', ...ctx })
      let request
      try {
        ;({ request } = await publicClient.simulateContract({ account, chain: walletClient.chain, address: swap, abi: SWAP_TAKER_ABI, functionName, args: orderArgs(me, o) }))
      } catch (e) {
        let reason = simReason(e)
        if (reason === 'transfer' || reason === 'unknown') reason = await diagnose(o)
        result.skipped.push({ ...leg, reason, message: REASONS[reason], costsGas: false })
        emit({ type: 'skipped', reason, message: REASONS[reason], ...ctx })
        if (reason === 'taker_balance' || reason === 'taker_allowance') { result.stopped = reason; break }
        continue
      }
      assertPaysMe(request.address, encodeFunctionData({ abi: SWAP_TAKER_ABI, functionName: request.functionName, args: request.args }))

      // 2) send
      emit({ type: 'awaiting_signature', ...ctx })
      const s = await send(request)
      if (s.rejected) { result.stopped = 'rejected'; emit({ type: 'rejected', ...ctx }); break }

      // 3) track
      const t = await track(s.hash, ctx)
      if (t.receipt) result.gasCostWei += t.receipt.gasUsed * t.receipt.effectiveGasPrice
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
        result.failed.push({ ...leg, txHash: t.hash, reason: t.status, message: REASONS[t.status], costsGas: t.status !== 'timeout' })
        result.stopped = t.status
        emit({ type: t.status, txHash: t.hash, ...ctx })
        break
      }
    }
    emit({ type: 'done', result })
    return result
  }

  return { address: me, plan, verify, execute, track }
}

/** Sum of `token` transfers to `to` in a receipt: what actually arrived, not what was quoted. */
export function receivedFrom(receipt, token, to) {
  let sum = 0n
  for (const log of receipt.logs) {
    if (getAddress(log.address) !== getAddress(token)) continue
    try {
      const ev = decodeEventLogSafe(log)
      if (ev && getAddress(ev.to) === getAddress(to)) sum += ev.value
    } catch { /* not a Transfer */ }
  }
  return sum
}
const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef'
function decodeEventLogSafe(log) {
  if (log.topics[0] !== TRANSFER_TOPIC || log.topics.length < 3) return null
  return { from: '0x' + log.topics[1].slice(26), to: '0x' + log.topics[2].slice(26), value: BigInt(log.data) }
}

/** Helper for SDKs that want the reason of a revert from raw data. */
export const decodeSwapError = (data) => { try { return decodeErrorResult({ abi: SWAP_TAKER_ABI, data }).errorName } catch { return null } }
