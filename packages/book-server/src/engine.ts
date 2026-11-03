// Book engine: order intake, reorg-aware event indexing, event-driven revalidation with a periodic full sweep,
// cumulative funding allocation, cached book reads.
//
// Every tick: 1 request for the head block; if nothing new, done. Otherwise the swap contract's logs (fills, cancels,
// fee, authorize) and the whitelisted tokens' Transfer/Approval/Deposit/Withdrawal logs of live signers tell which
// (signer, token) pairs changed; only those are re-read. A full sweep of every live order still runs every
// `fullSweepMs` (and after a reorg, a fee change or a long gap) as a backstop for anything logs cannot show
// (token blacklists, pauses, missed logs).
import { EventEmitter } from 'node:events'
import { parseAbiItem, getAddress, toHex, formatUnits, type Address, type Block, type Hex, type Log, type PublicClient } from 'viem'
import { normalizeOrder, validateShape, orderHash, recoverSignatory, requiredSignerFunds, packedSignature, domainFor, ORDER_TYPES, typedMessage, OrderError } from './order.js'
import { makeClient, snapshot, readFee, readFeeLight, EV_AUTHORIZE, EV_REVOKE, GOVERNANCE_EVENTS, TOPIC, padTopic, topicAddr, type RequestCounter, type Snapshot } from './chain.js'
import { rowToOrder, rowToJson, type Db, type OrderJson } from './db.js'
import { allocate } from './allocation.js'
import type { ChainCfg, EngineEvents, FillRow, NormalizedOrder, OrderRow, OrderStatus, SubmitResult, TickResult } from './types.js'

const EV_SWAP = parseAbiItem('event SwapERC20(uint256 indexed nonce, address indexed signerWallet)')
const EV_CANCEL = parseAbiItem('event Cancel(uint256 indexed nonce, address indexed signerWallet)')
const EV_FEE = parseAbiItem('event SetProtocolFee(uint256 protocolFee)')
const SIGNAL_TOPICS: Hex[] = [TOPIC.transfer, TOPIC.approval, TOPIC.deposit, TOPIC.withdrawal]

const nowMs = () => Date.now()
const yieldLoop = () => new Promise<void>((r) => setImmediate(r))
const minBig = (a: bigint, b: bigint) => (a < b ? a : b)

/** After a provider rejects the signer-filtered log query, use the unfiltered one for this long before trying again. */
export const FILTER_BACKOFF_MS = 10 * 60_000
/**
 * "The provider is unavailable", never "the provider refused this filter": timeouts, network failures (no HTTP status),
 * 408, 429 and 5xx. Anything else (JSON-RPC error, 400/413/414/431…) may be a refusal of the filter.
 */
export function isOutage(e: unknown): boolean {
  const walk = (x: unknown, depth = 0): boolean => {
    if (!x || typeof x !== 'object' || depth > 5) return false
    const err = x as { name?: string; status?: number; cause?: unknown }
    if (err.name === 'TimeoutError') return true
    if (err.name === 'HttpRequestError') return err.status == null || err.status === 408 || err.status === 429 || err.status >= 500
    return walk(err.cause, depth + 1)
  }
  return walk(e)
}

/** Optional observers (structured logs, metrics); the engine never depends on them. */
export interface EngineHooks {
  onTick?(e: { chainId: number; kind: 'idle' | 'incremental' | 'full'; ms: number; rpc: number; checked: number }): void
  onReorg?(e: { chainId: number; rewoundTo: bigint; rolledBack: number }): void
  onLogFilterFallback?(e: { chainId: number; signers: number; error: string }): void
}

export interface ChainState {
  cfg: ChainCfg
  client: PublicClient
  fee: bigint
  feeLight: bigint
  chainTime: bigint
  chainTimeAt: number
  head: Block | null
  busy: boolean
  version: number
  cache: Map<string, { version: number; bucket: bigint; value: BookView }>
  lastFull: number
  forceFull: boolean
  /** wall-clock ms of the last fully successful round (or init) */
  lastOk: number
  /** until this wall-clock ms, token logs are read unfiltered (the provider rejected the signer filter) */
  filterRejectedUntil: number
  /** bumped by every new or rolled-back fill: ETag of /trades and /candles */
  tradeVersion: number
}

export interface BookEntry { hash: Hex; price: number; baseAmount: string; quoteAmount: string; expiry: number; signer: Address; order?: OrderJson['order'] }
export interface BookView { base: Address; quote: Address; asks: BookEntry[]; bids: BookEntry[]; etag: string }
export type OrderView = OrderJson & { executableOnChain: boolean }
interface Signals { pairs: Set<string>; signers: Set<Address>; full: boolean; idle?: boolean }

type ContractLog = Log & { eventName: string; args: Record<string, unknown> }

export class Engine extends EventEmitter<EngineEvents> {
  readonly db: Db
  readonly chains = new Map<number, ChainState>()
  readonly counter: RequestCounter | undefined
  private readonly hooks: EngineHooks

  constructor(chains: ChainCfg[], db: Db, { counter, hooks = {} }: { counter?: RequestCounter; hooks?: EngineHooks } = {}) {
    super()
    this.setMaxListeners(0)
    this.db = db
    this.counter = counter
    this.hooks = hooks
    for (const cfg of chains) {
      this.chains.set(cfg.id, {
        cfg, client: makeClient(cfg.id, cfg, counter), fee: 0n, feeLight: 0n, chainTime: 0n, chainTimeAt: 0, head: null, busy: false,
        version: 0, cache: new Map(), lastFull: 0, forceFull: true, lastOk: 0, filterRejectedUntil: 0, tradeVersion: 0,
      })
    }
  }

  chain(id: number | string): ChainState {
    const c = this.chains.get(Number(id))
    if (!c) throw new OrderError('unknown_chain', `chain ${id} not supported`)
    return c
  }

  /** Chain time extrapolated from the last observed block (contract checks expiry against block.timestamp). */
  chainNow(c: ChainState): bigint {
    return c.chainTime + BigInt(Math.floor((nowMs() - c.chainTimeAt) / 1000))
  }

  async init(): Promise<void> {
    for (const c of this.chains.values()) {
      c.fee = await readFee(c.client, c.cfg.swap)
      c.feeLight = await readFeeLight(c.client, c.cfg.swap)
      const b = await c.client.getBlock()
      this._setHead(c, b)
      c.lastOk = nowMs()
      if (this.db.getMeta(`last_block:${c.cfg.id}`) == null) {
        this.db.setMeta(`last_block:${c.cfg.id}`, (c.cfg.startBlock > 0n ? c.cfg.startBlock - 1n : (b.number as bigint)).toString())
        this.db.setMeta(`last_hash:${c.cfg.id}`, '')
      }
      // fee may have changed while offline
      this._emitAll(c, this.db.invalidateFee(c.cfg.id, Number(c.fee), nowMs()), 'invalid_fee')
      this._emitAll(c, this.db.reviveFee(c.cfg.id, Number(c.fee), Number(this.chainNow(c)), nowMs()), 'unfunded')
    }
  }

  private _setHead(c: ChainState, b: Block): void {
    c.head = b
    c.chainTime = b.timestamp
    c.chainTimeAt = nowMs()
  }

  /** Every state change goes through here: bumps the chain's version (book cache) and notifies SSE. */
  private _emitOrder(c: ChainState, hash: Hex, status: OrderStatus): void {
    c.version++
    this.emit('order', { chainId: c.cfg.id, hash, status })
  }
  private _emitAll(c: ChainState, hashes: Hex[], status: OrderStatus): void {
    for (const hash of hashes) this._emitOrder(c, hash, status)
  }
  private _setStatus(c: ChainState, hash: Hex, status: OrderStatus, stamp: number, block: bigint | null = null): void {
    if (this.db.setStatus(hash, status, stamp, block)) {
      // at the moment it becomes invalid_signer the signature does not validate on-chain (delegate set / 1271 refused)
      if (status === 'invalid_signer') this.db.setLive(hash, false, stamp)
      this._emitOrder(c, hash, status)
    }
  }

  /**
   * Can this signed order still be executed on-chain, whatever the book says? true = the signature, nonce and expiry are
   * valid at the current fee, so it fills now or as soon as the signer's balance/allowance allows; only cancel() ends it.
   * open/unfunded → true; invalid_signer → true when the signature validates again (revoke(), smart wallet re-accepts);
   * filled/cancelled/used/expired → false; invalid_fee → false while the contract fee differs (true again if it returns).
   */
  executableOnChain(row: OrderRow): boolean {
    const c = this.chain(row.chain_id)
    if (BigInt(row.expiry) <= this.chainNow(c)) return false
    if (row.status === 'open' || row.status === 'unfunded') return true
    if (row.status === 'invalid_signer') return row.onchain_live === 1
    return false
  }

  /** JSON view of an order for the API: the stored order plus executableOnChain. */
  orderJson(row: OrderRow, withSignature = true): OrderView {
    return { ...rowToJson(row, withSignature), executableOnChain: this.executableOnChain(row) }
  }

  /**
   * Re-check invalid_signer orders (all, or those of `signers`): after revoke() their signature validates again on-chain.
   * One batched snapshot; no request when there is nothing to watch.
   */
  private async _watchRevoked(c: ChainState, signers: Set<Address> | null = null): Promise<{ watched: number }> {
    const now = this.chainNow(c)
    const rows = signers == null ? this.db.revoked(c.cfg.id, now) : [...signers].flatMap((s) => this.db.revokedBySigner(c.cfg.id, s, now))
    if (rows.length === 0) return { watched: 0 }
    const snap = await snapshot(c.client, c.cfg, rows.map(rowToOrder), { contractSigned: (_, i) => rows[i]?.contract_signer === 1 })
    const stamp = nowMs()
    rows.forEach((r, i) => {
      if (snap.unknown.has(i)) return // unreadable: keep what we knew
      const live = !snap.delegated.has(r.signer) && !snap.badSignature.has(i) && !snap.nonceUsed[i] && BigInt(r.protocol_fee) === c.fee
      if ((r.onchain_live === 1) !== live) {
        this.db.setLive(r.hash, live, stamp)
        c.version++
        this.emit('order', { chainId: c.cfg.id, hash: r.hash, status: r.status, executableOnChain: live })
      }
    })
    return { watched: rows.length }
  }

  publicConfig(): Record<number, unknown> {
    const out: Record<number, unknown> = {}
    for (const c of this.chains.values()) {
      out[c.cfg.id] = {
        swap: c.cfg.swap,
        protocolFee: c.fee.toString(),
        // must equal protocolFee (both 30 at deploy); a difference means an administrative change: the app shows a banner
        protocolFeeLight: c.feeLight.toString(),
        markets: c.cfg.markets,
        domain: domainFor(c.cfg.id, c.cfg.swap),
        types: ORDER_TYPES,
        tokens: c.cfg.tokens,
        minExpirySec: c.cfg.minExpirySec,
        maxExpirySec: c.cfg.maxExpirySec,
        expiryBufferSec: c.cfg.expiryBufferSec,
      }
    }
    return out
  }

  // ------------------------------------------------------------------ intake
  /** Validate and store a batch of orders (e.g. a ladder). One multicall for the whole batch. */
  async submit(chainId: number | string, rawOrders: unknown[]): Promise<SubmitResult[]> {
    const c = this.chain(chainId)
    const now = this.chainNow(c)
    const results: SubmitResult[] = []
    // replaces: an invalid_fee order with the same nonce and terms, re-signed at the current fee (only one of the two can ever fill)
    type Acc = { o: NormalizedOrder & { _contract?: boolean }; hash: Hex; reject?: OrderError; replaces?: Hex }
    const accepted: Acc[] = []
    const batchKeys = new Set<string>()
    if (this.db.countLive(c.cfg.id) + rawOrders.length > c.cfg.maxLiveOrders) {
      return rawOrders.map(() => ({ error: 'book_full', message: 'the book is at capacity, try later' }))
    }
    for (let i = 0; i < rawOrders.length; i++) {
      // signature recovery is ~2 ms of CPU: yield so a 50-order batch never blocks reads and SSE for long
      if (i % 8 === 7) await yieldLoop()
      try {
        const o: Acc['o'] = normalizeOrder(rawOrders[i])
        validateShape(o, c.cfg, { now, fee: c.fee })
        const hash = orderHash(c.cfg.id, c.cfg.swap, o)
        const nonceKey = `${o.signerWallet}|${o.nonce}`
        // dedupe on the EIP-712 hash, not the signature: a malleated (high-s) copy of a signature maps to the same order
        if (batchKeys.has(hash) || this.db.byHash(hash)) throw new OrderError('duplicate', 'order already submitted')
        if (batchKeys.has(nonceKey)) throw new OrderError('nonce_reused', 'another order uses this nonce')
        // Re-signing after a fee change keeps the nonce: the old order (still valid on-chain if the fee ever returns) and the
        // new one share it, so at most one of them can be filled. Allowed only over an invalid_fee order with the same terms.
        const prev = this.db.orderByNonce(c.cfg.id, o.signerWallet, o.nonce.toString())
        let replaces: Hex | undefined
        if (prev) {
          const same = prev.status === 'invalid_fee' && prev.signer_token === o.signerToken && prev.sender_token === o.senderToken && prev.sender_wallet === o.senderWallet &&
            prev.signer_amount === o.signerAmount.toString() && prev.sender_amount === o.senderAmount.toString() && BigInt(prev.protocol_fee) !== o.protocolFee
          if (!same) throw new OrderError('nonce_reused', 'another order uses this nonce')
          replaces = prev.hash as Hex
        }
        batchKeys.add(hash).add(nonceKey)
        o._contract = await this._checkSignature(c, o)
        accepted.push({ o, hash, ...(replaces ? { replaces } : {}) })
        results.push({ hash, status: 'pending' })
      } catch (e) {
        const err = e as { code?: string; message: string }
        results.push({ error: err.code || 'error', message: err.message })
      }
    }
    if (accepted.length === 0) return results

    // Batched on-chain state for the new orders + the signers' existing live orders on the same tokens.
    const existing: NormalizedOrder[] = []
    const seen = new Set<string>()
    for (const { o } of accepted) {
      const key = `${o.signerWallet}|${o.signerToken}`
      if (seen.has(key)) continue
      seen.add(key)
      const rows = this.db.liveBySignerToken(c.cfg.id, o.signerWallet, o.signerToken)
      const incoming = accepted.filter((a) => a.o.signerWallet === o.signerWallet && a.o.signerToken === o.signerToken).length
      if (rows.length + incoming > c.cfg.maxOpenPerSigner) {
        for (const a of accepted) if (a.o.signerWallet === o.signerWallet) a.reject = new OrderError('too_many_orders', 'open order limit reached')
      }
      existing.push(...rows.map((r) => rowToOrder(r)))
    }
    const fresh = accepted.filter((a) => !a.reject)
    const snap = await snapshot(c.client, c.cfg, [...existing, ...fresh.map((a) => a.o)], { contractSigned: (o) => (o as Acc['o'])._contract === true })
    const base = existing.length

    const stamp = nowMs()
    const ready: Acc[] = []
    const taintedPairs = new Set<string>()
    ;[...existing, ...fresh.map((a) => a.o)].forEach((o, i) => { if (snap.unknown.has(i)) taintedPairs.add(`${o.signerWallet}|${o.signerToken}`) })
    fresh.forEach((a, i) => {
      if (taintedPairs.has(`${a.o.signerWallet}|${a.o.signerToken}`)) a.reject = new OrderError('chain_unavailable', 'on-chain state could not be read completely, retry shortly')
      else if (snap.delegated.has(a.o.signerWallet)) a.reject = new OrderError('delegated_signer', 'wallets with an authorized signatory (SwapERC20.authorize) are not supported; call revoke() first')
      else if (snap.badSignature.has(base + i)) a.reject = new OrderError('bad_signature', 'contract wallet signature not accepted by SwapERC20')
      else if (snap.nonceUsed[base + i]) a.reject = new OrderError('nonce_used', 'nonce already used or cancelled on-chain')
      else if ((snap.funds.get(`${a.o.signerWallet}|${a.o.signerToken}`) ?? 0n) < requiredSignerFunds(a.o)) {
        a.reject = new OrderError('insufficient_funds', 'balance/allowance must cover amount + protocol fee')
      } else ready.push(a)
    })

    this.db.tx(() => {
      for (const a of ready) {
        if (a.replaces) this.db.deleteOrder(a.replaces)
        const c0 = c.cfg.tokens[a.o.signerToken] as { decimals: number }, c1 = c.cfg.tokens[a.o.senderToken] as { decimals: number }
        const price = Number(a.o.senderAmount) / 10 ** c1.decimals / (Number(a.o.signerAmount) / 10 ** c0.decimals)
        this.db.insert({
          hash: a.hash, chain_id: c.cfg.id, nonce: a.o.nonce.toString(), expiry: Number(a.o.expiry), signer: a.o.signerWallet,
          signer_token: a.o.signerToken, signer_amount: a.o.signerAmount.toString(), sender_wallet: a.o.senderWallet,
          sender_token: a.o.senderToken, sender_amount: a.o.senderAmount.toString(), protocol_fee: Number(a.o.protocolFee),
          v: a.o.v, r: a.o.r, s: a.o.s, price, status: 'unfunded', now: stamp, contract_signer: a.o._contract ? 1 : 0,
        })
      }
    })
    if (ready.length) c.version++
    // Allocate funds across all live orders of the touched (signer, token) pairs (oldest first).
    const touched = new Set(ready.map((a) => `${a.o.signerWallet}|${a.o.signerToken}`))
    for (const key of touched) {
      const [signer, token] = key.split('|') as [Address, Address]
      this._allocate(c, this.db.liveBySignerToken(c.cfg.id, signer, token), snap.funds.get(key) ?? 0n, stamp)
    }
    return results.map((r) => {
      if (!('hash' in r)) return r
      const a = accepted.find((x) => x.hash === r.hash) as Acc
      if (a.reject) return { error: a.reject.code, message: a.reject.message }
      return { hash: r.hash, status: (this.db.byHash(r.hash) as OrderRow).status }
    })
  }

  /** @returns true for a contract (EIP-1271) signer, false for an EOA; throws on an invalid signature. */
  private async _checkSignature(c: ChainState, o: NormalizedOrder): Promise<boolean> {
    let signatory: Address | null
    try { signatory = getAddress(await recoverSignatory(c.cfg.id, c.cfg.swap, o)) } catch { signatory = null }
    // EOA: recovered locally, no RPC. The authorized() check happens in the batched snapshot.
    if (signatory === o.signerWallet) return false
    // Otherwise only an EIP-1271 contract wallet can be valid (65-byte r,s,v signature, as the contract passes it).
    // Delegated signatories are deliberately unsupported: their nonces live under the delegate and the
    // wallet's own cancel() would not reach them.
    if (!(await c.client.getCode({ address: o.signerWallet }))) throw new OrderError('bad_signature', 'invalid signature')
    const ok = await c.client.verifyTypedData({
      address: o.signerWallet, domain: domainFor(c.cfg.id, c.cfg.swap), types: ORDER_TYPES, primaryType: 'OrderERC20',
      message: typedMessage(o), signature: packedSignature(o),
    })
    if (!ok) throw new OrderError('bad_signature', 'invalid signature')
    return true
  }

  /** Cumulative funding: orders are funded in creation order until min(balance, allowance) runs out. */
  private _allocate(c: ChainState, rows: OrderRow[], available: bigint, stamp: number): void {
    // rows come ordered by (created_at, rowid): their position is the tie-break sequence
    const funded = allocate(rows.map((r, i) => ({ need: requiredSignerFunds(rowToOrder(r)), createdAt: r.created_at, seq: i })), available)
    rows.forEach((r, i) => {
      const status: OrderStatus = funded[i] ? 'open' : 'unfunded'
      if (r.status !== status) this._setStatus(c, r.hash, status, stamp)
    })
  }

  // ------------------------------------------------------------------ indexer
  /**
   * Index the swap contract's events up to the head and collect token signals. Reorg-aware: the hash of the last
   * indexed block is stored; if it is no longer canonical, every status observed in the last `reorgDepth` blocks
   * is rolled back and those blocks are indexed again.
   */
  private async _sync(c: ChainState, head: Block): Promise<Signals> {
    const id = c.cfg.id
    const out: Signals = { pairs: new Set(), signers: new Set(), full: false }
    const headNumber = head.number as bigint, headHash = head.hash as Hex
    let last = BigInt(this.db.getMeta(`last_block:${id}`) as string)
    const lastHash = this.db.getMeta(`last_hash:${id}`) || null
    if (headNumber === last && headHash === lastHash) { out.idle = true; return out } // nothing new: 1 RPC this tick

    // continuity: the head's parent proves it for free; otherwise read the stored block once
    const continuous = lastHash == null || (headNumber === last + 1n && head.parentHash === lastHash) ||
      (await c.client.getBlock({ blockNumber: last }).then((b) => b.hash === lastHash, () => false))
    if (!continuous || headNumber < last) {
      const floor = c.cfg.startBlock > 0n ? c.cfg.startBlock - 1n : 0n
      const to = last - c.cfg.reorgDepth > floor ? last - c.cfg.reorgDepth : floor
      const stamp = nowMs()
      const rolled = this.db.rollback(id, to + 1n, stamp)
      if (this.db.rollbackFills(id, to + 1n) > 0) c.tradeVersion++
      for (const r of rolled) { this._emitOrder(c, r.hash, r.status); out.pairs.add(`${r.signer}|${r.signer_token}`) }
      this.emit('reorg', { chainId: id, rewoundTo: to, rolledBack: rolled.length })
      this.hooks.onReorg?.({ chainId: id, rewoundTo: to, rolledBack: rolled.length })
      last = to
      this.db.setMeta(`last_block:${id}`, to.toString())
      this.db.setMeta(`last_hash:${id}`, '')
      out.full = true
    }

    const start = last + 1n
    if (start > headNumber) return out
    if (headNumber - start + 1n > c.cfg.signalMaxBlocks) out.full = true

    let from = start
    while (from <= headNumber) {
      const to = minBig(from + c.cfg.logChunk - 1n, headNumber)
      const logs = await c.client.getLogs({ address: c.cfg.swap, events: [EV_SWAP, EV_CANCEL, EV_FEE, EV_AUTHORIZE, EV_REVOKE, ...GOVERNANCE_EVENTS], fromBlock: from, toBlock: to }) as unknown as ContractLog[]
      const toHash = to === headNumber ? headHash : ((await c.client.getBlock({ blockNumber: to })).hash as Hex)
      // block timestamps of the fills (one read per block that has fills; the head's is already known)
      const fillBlocks = [...new Set(logs.filter((l) => l.eventName === 'SwapERC20').map((l) => l.blockNumber as bigint))]
      const ts = new Map<bigint, number>()
      for (const b of fillBlocks) ts.set(b, b === headNumber ? Number(head.timestamp) : Number((await c.client.getBlock({ blockNumber: b })).timestamp))
      const stamp = nowMs()
      const newTrades: { orderHash: Hex; tx: Hex; block: number; ts: number }[] = []
      this.db.tx(() => {
        for (const l of logs) {
          if (GOVERNANCE_EVENTS.some((e) => e.name === l.eventName)) {
            if (l.eventName === 'SetProtocolFeeLight') c.feeLight = l.args.protocolFeeLight as bigint
            this.emit('governance', { chainId: id, event: l.eventName, block: Number(l.blockNumber), tx: l.transactionHash as Hex,
              args: Object.fromEntries(Object.entries(l.args).map(([k, v]) => [k, String(v)])) })
            continue
          }
          if (l.eventName === 'SetProtocolFee') {
            c.fee = l.args.protocolFee as bigint
            this._emitAll(c, this.db.invalidateFee(id, Number(c.fee), stamp), 'invalid_fee')
            this._emitAll(c, this.db.reviveFee(id, Number(c.fee), Number(this.chainNow(c)), stamp), 'unfunded')
            this.emit('fee', { chainId: id, protocolFee: c.fee.toString() })
            out.full = true
          } else if (l.eventName === 'Authorize' || l.eventName === 'Revoke') {
            out.signers.add(getAddress(l.args.signerWallet as string))
          } else {
            const status: OrderStatus = l.eventName === 'SwapERC20' ? 'filled' : 'cancelled'
            const signer = getAddress(l.args.signerWallet as string)
            const nonce = (l.args.nonce as bigint).toString()
            this._emitAll(c, this.db.setStatusByNonce(id, signer, nonce, status, stamp, l.blockNumber), status)
            if (status === 'filled') {
              // only fills of orders this book knows: amounts come from the signed order (the event carries nonce + signer)
              const row = this.db.orderByNonce(id, signer, nonce)
              if (row && this.db.insertFill({ chain_id: id, order_hash: row.hash, block: Number(l.blockNumber), tx: l.transactionHash as Hex, log_index: Number(l.logIndex),
                ts: ts.get(l.blockNumber as bigint) ?? Number(head.timestamp), signer, signer_token: row.signer_token, signer_amount: row.signer_amount,
                sender_token: row.sender_token, sender_amount: row.sender_amount })) {
                newTrades.push({ orderHash: row.hash, tx: l.transactionHash as Hex, block: Number(l.blockNumber), ts: ts.get(l.blockNumber as bigint) ?? Number(head.timestamp) })
              }
            }
            out.signers.add(signer) // a fill moved this signer's funds: re-allocate the rest of the ladder
          }
        }
        this.db.setMeta(`last_block:${id}`, to.toString())
        this.db.setMeta(`last_hash:${id}`, toHash)
      })
      if (newTrades.length) { c.tradeVersion++; for (const t of newTrades) this.emit('trade', { chainId: id, ...t }) }
      from = to + 1n
    }
    if (!out.full) await this._tokenSignals(c, start, headNumber, out)
    return out
  }

  /** Which live signers' balances/allowances may have changed in [from, to], from the whitelisted tokens' logs. */
  private async _tokenSignals(c: ChainState, from: bigint, to: bigint, out: Signals): Promise<void> {
    const live = this.db.liveSigners(c.cfg.id)
    if (live.length === 0) return
    const all = new Set(live.map((s) => s.signer))
    const address = Object.keys(c.cfg.tokens) as Address[]
    type RawLog = { address: Address; topics: Hex[] }
    const getLogs = (topics: (Hex[] | null)[]) => c.client.request({ method: 'eth_getLogs', params: [{ address, fromBlock: toHex(from), toBlock: toHex(to), topics }] } as never) as Promise<RawLog[]>
    let logs: RawLog[] | null = null
    if (live.length <= c.cfg.logSignerChunk && nowMs() >= c.filterRejectedUntil) {
      // filtered at the node: outgoing transfers, approvals, WETH deposits/withdrawals of signers; incoming transfers of unfunded ones
      const unfunded = live.filter((s) => s.unfunded).map((s) => padTopic(s.signer))
      try {
        const [a, b] = await Promise.all([
          getLogs([SIGNAL_TOPICS, live.map((s) => padTopic(s.signer))]),
          unfunded.length ? getLogs([[TOPIC.transfer], null, unfunded]) : Promise.resolve([] as RawLog[]),
        ])
        logs = a.concat(b)
      } catch (e) {
        // A refusal of the filter (topic list too long, request too large, any JSON-RPC/4xx error) is confirmed by the unfiltered
        // query succeeding in the same round: then fall back for FILTER_BACKOFF_MS and never stop. If the unfiltered query fails
        // too, or the error is a timeout / 5xx, the provider is down: the round fails as usual.
        if (isOutage(e)) throw e
        logs = await getLogs([SIGNAL_TOPICS])
        c.filterRejectedUntil = nowMs() + FILTER_BACKOFF_MS
        const err = e as { details?: string; shortMessage?: string; message: string }
        this.hooks.onLogFilterFallback?.({ chainId: c.cfg.id, signers: live.length, error: err.details || err.shortMessage || err.message })
      }
    }
    // many signers (or filter rejected): one unfiltered query for the (short) range, filtered here
    if (logs == null) logs = await getLogs([SIGNAL_TOPICS])
    for (const l of logs) {
      const token = getAddress(l.address), t0 = l.topics[0]
      if (!c.cfg.tokens[token] || l.topics.length < 2) continue
      const a1 = topicAddr(l.topics[1] as Hex)
      if (t0 === TOPIC.approval) {
        if (l.topics.length > 2 && topicAddr(l.topics[2] as Hex) === c.cfg.swap && all.has(a1)) out.pairs.add(`${a1}|${token}`)
      } else {
        if (all.has(a1)) out.pairs.add(`${a1}|${token}`)
        if (t0 === TOPIC.transfer && l.topics.length > 2) { const a2 = topicAddr(l.topics[2] as Hex); if (all.has(a2)) out.pairs.add(`${a2}|${token}`) }
      }
    }
  }

  // ------------------------------------------------------------------ revalidation
  /** Apply a snapshot to live rows: terminal/soft statuses first, then funding allocation per (signer, token). */
  private _apply(c: ChainState, rows: OrderRow[], snap: Snapshot, stamp: number): void {
    const block = snap.blockNumber ?? c.head?.number ?? null // lower bound of the read block: safe for reorg rollback
    const groups = new Map<string, OrderRow[]>()
    // fail closed: a (signer, token) pair with any unreadable value is not funded this round, and gets no terminal status
    const tainted = new Set<string>()
    rows.forEach((r, i) => { if (snap.unknown.has(i)) tainted.add(`${r.signer}|${r.signer_token}`) })
    rows.forEach((r, i) => {
      if (tainted.has(`${r.signer}|${r.signer_token}`)) {
        this._setStatus(c, r.hash, 'unfunded', stamp)
        return
      }
      if (snap.delegated.has(r.signer) || snap.badSignature.has(i)) {
        // authorize() after posting, or a contract wallet that stopped accepting the signature (terminal; re-sign)
        this._setStatus(c, r.hash, 'invalid_signer', stamp)
        return
      }
      if (snap.nonceUsed[i]) {
        // nonce consumed and its event not indexed yet → not fillable; upgraded to filled/cancelled when the event arrives
        this._setStatus(c, r.hash, 'used', stamp, block)
        return
      }
      const key = `${r.signer}|${r.signer_token}`
      const g = groups.get(key)
      if (g) g.push(r); else groups.set(key, [r])
    })
    for (const [key, list] of groups) this._allocate(c, list, snap.funds.get(key) ?? 0n, stamp)
  }

  expire(chainId: number | string): void {
    const c = this.chain(chainId)
    this._emitAll(c, this.db.expire(c.cfg.id, Number(this.chainNow(c)), nowMs()), 'expired')
  }

  /** Full sweep: expire, then re-check every live order with one batched snapshot and re-allocate funds. */
  async revalidate(chainId: number | string): Promise<{ checked: number; full?: boolean }> {
    const c = this.chain(chainId)
    this.expire(chainId)
    const rows = this.db.live(c.cfg.id)
    c.lastFull = nowMs()
    c.forceFull = false
    if (rows.length === 0) return { checked: 0 }
    const snap = await snapshot(c.client, c.cfg, rows.map(rowToOrder), { contractSigned: (_, i) => rows[i]?.contract_signer === 1 })
    this._apply(c, rows, snap, nowMs())
    return { checked: rows.length, full: true }
  }

  /** Incremental: only the live orders of the touched (signer, token) pairs and signers. */
  private async _revalidateSome(c: ChainState, pairs: Set<string>, signers: Set<Address>): Promise<{ checked: number; full?: boolean }> {
    const byHash = new Map<Hex, OrderRow>()
    for (const key of pairs) {
      const [signer, token] = key.split('|') as [Address, Address]
      for (const r of this.db.liveBySignerToken(c.cfg.id, signer, token)) byHash.set(r.hash, r)
    }
    for (const s of signers) for (const r of this.db.liveBySigner(c.cfg.id, s)) byHash.set(r.hash, r)
    const rows = [...byHash.values()]
    if (rows.length === 0) return { checked: 0 }
    const snap = await snapshot(c.client, c.cfg, rows.map(rowToOrder), { contractSigned: (_, i) => rows[i]?.contract_signer === 1 })
    this._apply(c, rows, snap, nowMs())
    return { checked: rows.length, full: false }
  }

  /** Serialize work per chain so indexing and revalidation never overlap. */
  async tick(chainId: number | string): Promise<TickResult> {
    const c = this.chain(chainId)
    if (c.busy) return { skipped: true }
    c.busy = true
    const t0 = performance.now(), rpc0 = this.counter?.n[c.cfg.id] ?? 0
    let kind: 'idle' | 'incremental' | 'full' = 'incremental'
    let res: { checked: number; full?: boolean } = { checked: 0 }
    try {
      const head = await c.client.getBlock()
      this._setHead(c, head)
      const sig = await this._sync(c, head)
      const full = sig.full || c.forceFull || nowMs() - c.lastFull >= c.cfg.fullSweepMs
      if (full) { kind = 'full'; res = await this.revalidate(chainId) }
      else {
        if (sig.idle) kind = 'idle'
        this.expire(chainId)
        res = await this._revalidateSome(c, sig.pairs, sig.signers)
      }
      await this._watchRevoked(c, full ? null : sig.signers)
      c.lastOk = nowMs()
      // successful rounds only: failures are counted by the caller (fondaco_tick_errors_total)
      this.hooks.onTick?.({ chainId: c.cfg.id, kind, ms: performance.now() - t0, rpc: (this.counter?.n[c.cfg.id] ?? 0) - rpc0, checked: res.checked })
      return res
    } finally {
      c.busy = false
    }
  }

  // ------------------------------------------------------------------ queries
  /**
   * Book for base/quote. asks: signer gives base, wants quote. bids: signer gives quote, wants base.
   * Cached per chain version (any status change invalidates) and per 5 s of chain time (expiry buffer moves).
   */
  book(chainId: number | string, base: string, quote: string, limit = 50, { signed = false }: { signed?: boolean } = {}): BookView {
    const c = this.chain(chainId)
    const b = getAddress(base), q = getAddress(quote)
    const db = c.cfg.tokens[b], dq = c.cfg.tokens[q]
    if (!db || !dq) throw new OrderError('token_not_allowed', 'pair not whitelisted')
    // fail closed: never serve offers whose verification is older than maxStalenessMs (RPC outage)
    if (nowMs() - c.lastOk > c.cfg.maxStalenessMs) throw new OrderError('stale', `chain ${c.cfg.id} not verified for ${Math.round((nowMs() - c.lastOk) / 1000)} s`)
    const minExpiry = this.chainNow(c) + BigInt(c.cfg.expiryBufferSec)
    const bucket = minExpiry / 5n
    const key = `${b}|${q}|${limit}|${signed ? 1 : 0}`
    const hit = c.cache.get(key)
    if (hit && hit.version === c.version && hit.bucket === bucket) return hit.value
    const fmt = (r: OrderRow, side: 'ask' | 'bid'): BookEntry => {
      const baseAmt = side === 'ask' ? BigInt(r.signer_amount) : BigInt(r.sender_amount)
      const quoteAmt = side === 'ask' ? BigInt(r.sender_amount) : BigInt(r.signer_amount)
      return {
        hash: r.hash,
        price: Number(quoteAmt) / 10 ** dq.decimals / (Number(baseAmt) / 10 ** db.decimals),
        baseAmount: baseAmt.toString(),
        quoteAmount: quoteAmt.toString(),
        expiry: r.expiry,
        signer: r.signer,
        ...(signed ? { order: rowToJson(r).order } : {}),
      }
    }
    // asks: price = quote/base = sender/signer → stored price ascending = best ask first
    const asks = this.db.side(c.cfg.id, b, q, minExpiry, limit).map((r) => fmt(r, 'ask'))
    // bids: stored price = base/quote; ascending stored price = highest quote/base first = best bid first
    const bids = this.db.side(c.cfg.id, q, b, minExpiry, limit).map((r) => fmt(r, 'bid'))
    const value: BookView = { base: b, quote: q, asks, bids, etag: `W/"${c.cfg.id}-${c.version}-${bucket}"` }
    if (c.cache.size > 2000) c.cache.clear()
    c.cache.set(key, { version: c.version, bucket, value })
    return value
  }

  // ------------------------------------------------------------------ trades and price history (indexed fills)
  /** Price (quote per base, decimals-adjusted), base amount and taker side of a fill, seen from the base/quote market. */
  private _trade(c: ChainState, f: FillRow, base: Address) {
    const tb = c.cfg.tokens[base] as { decimals: number }
    const quote = f.signer_token === base ? f.sender_token : f.signer_token
    const tq = c.cfg.tokens[quote] as { decimals: number }
    const askTaken = f.signer_token === base // the signer sold base: the taker bought
    const baseAmt = BigInt(askTaken ? f.signer_amount : f.sender_amount), quoteAmt = BigInt(askTaken ? f.sender_amount : f.signer_amount)
    const b = Number(baseAmt) / 10 ** tb.decimals, q = Number(quoteAmt) / 10 ** tq.decimals
    return { price: q / b, base: b, quote: q, side: (askTaken ? 'buy' : 'sell') as 'buy' | 'sell', baseAmount: baseAmt.toString(), quoteAmount: quoteAmt.toString() }
  }

  private _pair(c: ChainState, base: string, quote: string): [Address, Address] {
    const b = getAddress(base), q = getAddress(quote)
    if (!c.cfg.tokens[b] || !c.cfg.tokens[q] || b === q) throw new OrderError('token_not_allowed', 'pair not whitelisted')
    return [b, q]
  }

  /** Most recent fills of the pair (newest first). */
  trades(chainId: number | string, base: string, quote: string, limit = 50) {
    const c = this.chain(chainId)
    const [b, q] = this._pair(c, base, quote)
    const rows = this.db.recentFills(c.cfg.id, b, q, Math.max(1, Math.min(limit, 200)))
    return { base: b, quote: q, etag: `W/"t-${c.cfg.id}-${c.tradeVersion}"`,
      trades: rows.map((f) => ({ ...this._trade(c, f, b), ts: f.ts, tx: f.tx, block: f.block, orderHash: f.order_hash })) }
  }

  /**
   * OHLCV buckets of `interval` seconds for the last `limit` buckets up to the current chain time, from indexed fills.
   * Only buckets with trades are returned; `prev` is the last price before the window (to draw a flat start).
   */
  candles(chainId: number | string, base: string, quote: string, interval = 300, limit = 288) {
    const c = this.chain(chainId)
    const [b, q] = this._pair(c, base, quote)
    const iv = Math.max(60, Math.min(Math.floor(interval), 86_400)), n = Math.max(1, Math.min(Math.floor(limit), 1000))
    const now = Number(this.chainNow(c)), end = Math.floor(now / iv) * iv, start = end - (n - 1) * iv
    const rows = this.db.fillsForPair(c.cfg.id, b, q, start, end + iv - 1, 100_000)
    // volumes summed exactly in base units, converted once
    const buckets = new Map<number, { t: number; o: number; h: number; l: number; c: number; vb: bigint; vqb: bigint; n: number }>()
    for (const f of rows) {
      const t = Math.floor(f.ts / iv) * iv, x = this._trade(c, f, b)
      const k = buckets.get(t)
      if (!k) buckets.set(t, { t, o: x.price, h: x.price, l: x.price, c: x.price, vb: BigInt(x.baseAmount), vqb: BigInt(x.quoteAmount), n: 1 })
      else { k.h = Math.max(k.h, x.price); k.l = Math.min(k.l, x.price); k.c = x.price; k.vb += BigInt(x.baseAmount); k.vqb += BigInt(x.quoteAmount); k.n++ }
    }
    const db = (c.cfg.tokens[b] as { decimals: number }).decimals, dq = (c.cfg.tokens[q] as { decimals: number }).decimals
    const units = (v: bigint, d: number) => Number(formatUnits(v, d))
    const before = this.db.lastFillBefore(c.cfg.id, b, q, start)
    return { base: b, quote: q, interval: iv, from: start, to: end, now, prev: before ? this._trade(c, before, b).price : null,
      candles: [...buckets.values()].map(({ vb, vqb, ...k }) => ({ ...k, v: units(vb, db), vq: units(vqb, dq) })),
      etag: `W/"c-${c.cfg.id}-${c.tradeVersion}-${iv}-${n}-${end}"` }
  }
}
