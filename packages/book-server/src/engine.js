// Book engine: order intake, reorg-aware event indexing, event-driven revalidation with a periodic full sweep,
// cumulative funding allocation, cached book reads.
//
// Every tick: 1 request for the head block; if nothing new, done. Otherwise the swap contract's logs (fills, cancels,
// fee, authorize) and the whitelisted tokens' Transfer/Approval/Deposit/Withdrawal logs of live signers tell which
// (signer, token) pairs changed; only those are re-read. A full sweep of every live order still runs every
// `fullSweepMs` (and after a reorg, a fee change or a long gap) as a backstop for anything logs cannot show
// (token blacklists, pauses, missed logs).
import { EventEmitter } from 'node:events'
import { parseAbiItem, getAddress, toHex } from 'viem'
import { normalizeOrder, validateShape, orderHash, recoverSignatory, requiredSignerFunds, packedSignature, domainFor, ORDER_TYPES, typedMessage, OrderError } from './order.js'
import { makeClient, snapshot, readFee, EV_AUTHORIZE, EV_REVOKE, TOPIC, padTopic, topicAddr } from './chain.js'
import { rowToOrder, rowToJson } from './db.js'

const EV_SWAP = parseAbiItem('event SwapERC20(uint256 indexed nonce, address indexed signerWallet)')
const EV_CANCEL = parseAbiItem('event Cancel(uint256 indexed nonce, address indexed signerWallet)')
const EV_FEE = parseAbiItem('event SetProtocolFee(uint256 protocolFee)')
const SIGNAL_TOPICS = [TOPIC.transfer, TOPIC.approval, TOPIC.deposit, TOPIC.withdrawal]

const nowMs = () => Date.now()
const yieldLoop = () => new Promise((r) => setImmediate(r))
const minBig = (a, b) => (a < b ? a : b)

export class Engine extends EventEmitter {
  constructor(config, db, { counter } = {}) {
    super()
    this.setMaxListeners(0)
    this.db = db
    this.chains = new Map()
    for (const [id, raw] of Object.entries(config.chains)) {
      const tokens = {}
      for (const [a, t] of Object.entries(raw.tokens)) {
        tokens[getAddress(a)] = { symbol: t.symbol, decimals: Number(t.decimals), ...(t.min != null ? { min: BigInt(t.min) } : {}) }
      }
      const cfg = {
        id: Number(id),
        rpc: raw.rpc,
        rpcTimeoutMs: raw.rpcTimeoutMs,
        swap: getAddress(raw.swap),
        multicall: raw.multicall,
        tokens,
        startBlock: BigInt(raw.startBlock ?? 0),
        logChunk: BigInt(raw.logChunk ?? 2000),
        reorgDepth: BigInt(raw.reorgDepth ?? 64), // blocks re-read after a reorg (64 ≈ two epochs on Ethereum = finality)
        signalMaxBlocks: BigInt(raw.signalMaxBlocks ?? 50), // longer gaps → full sweep instead of token logs
        logSignerChunk: Number(raw.logSignerChunk ?? 200), // above this many live signers, token logs are filtered locally
        fullSweepMs: Number(raw.fullSweepMs ?? 60_000),
        expiryBufferSec: Number(raw.expiryBufferSec ?? 30),
        minExpirySec: Number(raw.minExpirySec ?? 60),
        maxExpirySec: Number(raw.maxExpirySec ?? 7 * 86400),
        maxOpenPerSigner: Number(raw.maxOpenPerSigner ?? 200),
        maxLiveOrders: Number(raw.maxLiveOrders ?? 100_000),
      }
      this.chains.set(cfg.id, {
        cfg, client: makeClient(cfg.id, cfg, counter), fee: null, chainTime: 0n, chainTimeAt: 0, head: null, busy: false,
        version: 0, cache: new Map(), lastFull: 0, forceFull: true,
      })
    }
  }

  chain(id) {
    const c = this.chains.get(Number(id))
    if (!c) throw new OrderError('unknown_chain', `chain ${id} not supported`)
    return c
  }

  /** Chain time extrapolated from the last observed block (contract checks expiry against block.timestamp). */
  chainNow(c) {
    return c.chainTime + BigInt(Math.floor((nowMs() - c.chainTimeAt) / 1000))
  }

  async init() {
    for (const c of this.chains.values()) {
      c.fee = await readFee(c.client, c.cfg.swap)
      const b = await c.client.getBlock()
      this._setHead(c, b)
      if (this.db.getMeta(`last_block:${c.cfg.id}`) == null) {
        this.db.setMeta(`last_block:${c.cfg.id}`, (c.cfg.startBlock > 0n ? c.cfg.startBlock - 1n : b.number).toString())
        this.db.setMeta(`last_hash:${c.cfg.id}`, '')
      }
      // fee may have changed while offline
      this._emitAll(c, this.db.invalidateFee(c.cfg.id, Number(c.fee), nowMs()), 'invalid_fee')
      this._emitAll(c, this.db.reviveFee(c.cfg.id, Number(c.fee), Number(this.chainNow(c)), nowMs()), 'unfunded')
    }
  }

  _setHead(c, b) {
    c.head = b
    c.chainTime = b.timestamp
    c.chainTimeAt = nowMs()
  }

  /** Every state change goes through here: bumps the chain's version (book cache) and notifies SSE. */
  _emitOrder(c, hash, status) {
    c.version++
    this.emit('order', { chainId: c.cfg.id, hash, status })
  }
  _emitAll(c, hashes, status) {
    for (const hash of hashes) this._emitOrder(c, hash, status)
  }
  _setStatus(c, hash, status, stamp, block = null) {
    if (this.db.setStatus(hash, status, stamp, block)) this._emitOrder(c, hash, status)
  }

  publicConfig() {
    const out = {}
    for (const c of this.chains.values()) {
      out[c.cfg.id] = {
        swap: c.cfg.swap,
        protocolFee: c.fee?.toString(),
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
  async submit(chainId, rawOrders) {
    const c = this.chain(chainId)
    const now = this.chainNow(c)
    const results = []
    const accepted = []
    const batchKeys = new Set()
    if (this.db.countLive(c.cfg.id) + rawOrders.length > c.cfg.maxLiveOrders) {
      return rawOrders.map(() => ({ error: 'book_full', message: 'the book is at capacity, try later' }))
    }
    for (let i = 0; i < rawOrders.length; i++) {
      // signature recovery is ~2 ms of CPU: yield so a 50-order batch never blocks reads and SSE for long
      if (i % 8 === 7) await yieldLoop()
      try {
        const o = normalizeOrder(rawOrders[i])
        validateShape(o, c.cfg, { now, fee: c.fee })
        const hash = orderHash(c.cfg.id, c.cfg.swap, o)
        const nonceKey = `${o.signerWallet}|${o.nonce}`
        // dedupe on the EIP-712 hash, not the signature: a malleated (high-s) copy of a signature maps to the same order
        if (batchKeys.has(hash) || this.db.byHash(hash)) throw new OrderError('duplicate', 'order already submitted')
        if (batchKeys.has(nonceKey) || this.db.byNonce(c.cfg.id, o.signerWallet, o.nonce.toString())) throw new OrderError('nonce_reused', 'another order uses this nonce')
        batchKeys.add(hash).add(nonceKey)
        o._contract = await this._checkSignature(c, o)
        accepted.push({ o, hash })
        results.push({ hash, status: 'pending' })
      } catch (e) {
        results.push({ error: e.code || 'error', message: e.message })
      }
    }
    if (accepted.length === 0) return results

    // Batched on-chain state for the new orders + the signers' existing live orders on the same tokens.
    const existing = []
    const seen = new Set()
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
    const snap = await snapshot(c.client, c.cfg, [...existing, ...fresh.map((a) => a.o)], { contractSigned: (o) => o._contract === true })
    const base = existing.length

    const stamp = nowMs()
    const ready = []
    fresh.forEach((a, i) => {
      if (snap.delegated.has(a.o.signerWallet)) a.reject = new OrderError('delegated_signer', 'wallets with an authorized signatory (SwapERC20.authorize) are not supported; call revoke() first')
      else if (snap.badSignature.has(base + i)) a.reject = new OrderError('bad_signature', 'contract wallet signature not accepted by SwapERC20')
      else if (snap.nonceUsed[base + i]) a.reject = new OrderError('nonce_used', 'nonce already used or cancelled on-chain')
      else if ((snap.funds.get(`${a.o.signerWallet}|${a.o.signerToken}`) ?? 0n) < requiredSignerFunds(a.o)) {
        a.reject = new OrderError('insufficient_funds', 'balance/allowance must cover amount + protocol fee')
      } else ready.push(a)
    })

    this.db.tx(() => {
      for (const a of ready) {
        const c0 = c.cfg.tokens[a.o.signerToken], c1 = c.cfg.tokens[a.o.senderToken]
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
      const [signer, token] = key.split('|')
      this._allocate(c, this.db.liveBySignerToken(c.cfg.id, signer, token), snap.funds.get(key) ?? 0n, stamp)
    }
    for (const r of results) {
      if (!r.hash) continue
      const a = accepted.find((x) => x.hash === r.hash)
      if (a.reject) { r.error = a.reject.code; r.message = a.reject.message; delete r.status; delete r.hash }
      else r.status = this.db.byHash(r.hash).status
    }
    return results
  }

  /** @returns true for a contract (EIP-1271) signer, false for an EOA; throws on an invalid signature. */
  async _checkSignature(c, o) {
    let signatory
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
  _allocate(c, rows, available, stamp) {
    let left = available
    for (const r of rows) {
      const need = requiredSignerFunds(rowToOrder(r))
      const status = need <= left ? 'open' : 'unfunded'
      if (status === 'open') left -= need
      if (r.status !== status) this._setStatus(c, r.hash, status, stamp)
    }
  }

  // ------------------------------------------------------------------ indexer
  /**
   * Index the swap contract's events up to the head and collect token signals. Reorg-aware: the hash of the last
   * indexed block is stored; if it is no longer canonical, every status observed in the last `reorgDepth` blocks
   * goes back to 'unfunded' and those blocks are indexed again.
   * @returns { pairs: Set<'signer|token'>, signers: Set<signer>, full: boolean }
   */
  async _sync(c, head) {
    const id = c.cfg.id
    const out = { pairs: new Set(), signers: new Set(), full: false }
    let last = BigInt(this.db.getMeta(`last_block:${id}`))
    const lastHash = this.db.getMeta(`last_hash:${id}`) || null
    if (head.number === last && head.hash === lastHash) return out // nothing new: 1 RPC this tick

    // continuity: the head's parent proves it for free; otherwise read the stored block once
    const continuous = lastHash == null || (head.number === last + 1n && head.parentHash === lastHash) ||
      (await c.client.getBlock({ blockNumber: last }).then((b) => b.hash === lastHash, () => false))
    if (!continuous || head.number < last) {
      const floor = c.cfg.startBlock > 0n ? c.cfg.startBlock - 1n : 0n
      const to = last - c.cfg.reorgDepth > floor ? last - c.cfg.reorgDepth : floor
      const stamp = nowMs()
      const rolled = this.db.rollback(id, to + 1n, stamp)
      for (const r of rolled) { this._emitOrder(c, r.hash, r.status); out.pairs.add(`${r.signer}|${r.signer_token}`) }
      this.emit('reorg', { chainId: id, rewoundTo: to, rolledBack: rolled.length })
      last = to
      this.db.setMeta(`last_block:${id}`, to.toString())
      this.db.setMeta(`last_hash:${id}`, '')
      out.full = true
    }

    const start = last + 1n
    if (start > head.number) return out
    if (head.number - start + 1n > c.cfg.signalMaxBlocks) out.full = true

    let from = start
    while (from <= head.number) {
      const to = minBig(from + c.cfg.logChunk - 1n, head.number)
      const logs = await c.client.getLogs({ address: c.cfg.swap, events: [EV_SWAP, EV_CANCEL, EV_FEE, EV_AUTHORIZE, EV_REVOKE], fromBlock: from, toBlock: to })
      const toHash = to === head.number ? head.hash : (await c.client.getBlock({ blockNumber: to })).hash
      const stamp = nowMs()
      this.db.tx(() => {
        for (const l of logs) {
          if (l.eventName === 'SetProtocolFee') {
            c.fee = l.args.protocolFee
            this._emitAll(c, this.db.invalidateFee(id, Number(c.fee), stamp), 'invalid_fee')
            this._emitAll(c, this.db.reviveFee(id, Number(c.fee), Number(this.chainNow(c)), stamp), 'unfunded')
            this.emit('fee', { chainId: id, protocolFee: c.fee.toString() })
            out.full = true
          } else if (l.eventName === 'Authorize' || l.eventName === 'Revoke') {
            out.signers.add(getAddress(l.args.signerWallet))
          } else {
            const status = l.eventName === 'SwapERC20' ? 'filled' : 'cancelled'
            const signer = getAddress(l.args.signerWallet)
            this._emitAll(c, this.db.setStatusByNonce(id, signer, l.args.nonce.toString(), status, stamp, l.blockNumber), status)
            out.signers.add(signer) // a fill moved this signer's funds: re-allocate the rest of the ladder
          }
        }
        this.db.setMeta(`last_block:${id}`, to.toString())
        this.db.setMeta(`last_hash:${id}`, toHash)
      })
      from = to + 1n
    }
    if (!out.full) await this._tokenSignals(c, start, head.number, out)
    return out
  }

  /** Which live signers' balances/allowances may have changed in [from, to], from the whitelisted tokens' logs. */
  async _tokenSignals(c, from, to, out) {
    const live = this.db.liveSigners(c.cfg.id)
    if (live.length === 0) return
    const all = new Set(live.map((s) => s.signer))
    const address = Object.keys(c.cfg.tokens)
    const getLogs = (topics) => c.client.request({ method: 'eth_getLogs', params: [{ address, fromBlock: toHex(from), toBlock: toHex(to), topics }] })
    let logs
    if (live.length <= c.cfg.logSignerChunk) {
      // filtered at the node: outgoing transfers, approvals, WETH deposits/withdrawals of signers; incoming transfers of unfunded ones
      const unfunded = live.filter((s) => s.unfunded).map((s) => padTopic(s.signer))
      const [a, b] = await Promise.all([
        getLogs([SIGNAL_TOPICS, live.map((s) => padTopic(s.signer))]),
        unfunded.length ? getLogs([[TOPIC.transfer], null, unfunded]) : [],
      ])
      logs = a.concat(b)
    } else {
      // many signers: one unfiltered query for the (short) range, filtered here
      logs = await getLogs([SIGNAL_TOPICS])
    }
    for (const l of logs) {
      const token = getAddress(l.address), t0 = l.topics[0]
      if (!c.cfg.tokens[token] || l.topics.length < 2) continue
      const a1 = topicAddr(l.topics[1])
      if (t0 === TOPIC.approval) {
        if (l.topics.length > 2 && topicAddr(l.topics[2]) === c.cfg.swap && all.has(a1)) out.pairs.add(`${a1}|${token}`)
      } else {
        if (all.has(a1)) out.pairs.add(`${a1}|${token}`)
        if (t0 === TOPIC.transfer && l.topics.length > 2) { const a2 = topicAddr(l.topics[2]); if (all.has(a2)) out.pairs.add(`${a2}|${token}`) }
      }
    }
  }

  // ------------------------------------------------------------------ revalidation
  /** Apply a snapshot to live rows: terminal/soft statuses first, then funding allocation per (signer, token). */
  _apply(c, rows, snap, stamp) {
    const block = snap.blockNumber ?? c.head?.number ?? null // lower bound of the read block: safe for reorg rollback
    const groups = new Map()
    rows.forEach((r, i) => {
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
      if (!groups.has(key)) groups.set(key, [])
      groups.get(key).push(r)
    })
    for (const [key, list] of groups) this._allocate(c, list, snap.funds.get(key) ?? 0n, stamp)
  }

  expire(chainId) {
    const c = this.chain(chainId)
    this._emitAll(c, this.db.expire(c.cfg.id, Number(this.chainNow(c)), nowMs()), 'expired')
  }

  /** Full sweep: expire, then re-check every live order with one batched snapshot and re-allocate funds. */
  async revalidate(chainId) {
    const c = this.chain(chainId)
    this.expire(chainId)
    const rows = this.db.live(c.cfg.id)
    c.lastFull = nowMs()
    c.forceFull = false
    if (rows.length === 0) return { checked: 0 }
    const snap = await snapshot(c.client, c.cfg, rows.map(rowToOrder), { contractSigned: (_, i) => rows[i].contract_signer === 1 })
    this._apply(c, rows, snap, nowMs())
    return { checked: rows.length, full: true }
  }

  /** Incremental: only the live orders of the touched (signer, token) pairs and signers. */
  async _revalidateSome(c, pairs, signers) {
    const byHash = new Map()
    for (const key of pairs) {
      const [signer, token] = key.split('|')
      for (const r of this.db.liveBySignerToken(c.cfg.id, signer, token)) byHash.set(r.hash, r)
    }
    for (const s of signers) for (const r of this.db.liveBySigner(c.cfg.id, s)) byHash.set(r.hash, r)
    const rows = [...byHash.values()]
    if (rows.length === 0) return { checked: 0 }
    const snap = await snapshot(c.client, c.cfg, rows.map(rowToOrder), { contractSigned: (_, i) => rows[i].contract_signer === 1 })
    this._apply(c, rows, snap, nowMs())
    return { checked: rows.length, full: false }
  }

  /** Serialize work per chain so indexing and revalidation never overlap. */
  async tick(chainId) {
    const c = this.chain(chainId)
    if (c.busy) return { skipped: true }
    c.busy = true
    try {
      const head = await c.client.getBlock()
      this._setHead(c, head)
      const sig = await this._sync(c, head)
      if (sig.full || c.forceFull || nowMs() - c.lastFull >= c.cfg.fullSweepMs) return await this.revalidate(chainId)
      this.expire(chainId)
      return await this._revalidateSome(c, sig.pairs, sig.signers)
    } finally {
      c.busy = false
    }
  }

  // ------------------------------------------------------------------ queries
  /**
   * Book for base/quote. asks: signer gives base, wants quote. bids: signer gives quote, wants base.
   * Cached per chain version (any status change invalidates) and per 5 s of chain time (expiry buffer moves).
   */
  book(chainId, base, quote, limit = 50, { signed = false } = {}) {
    const c = this.chain(chainId)
    base = getAddress(base)
    quote = getAddress(quote)
    const db = c.cfg.tokens[base], dq = c.cfg.tokens[quote]
    if (!db || !dq) throw new OrderError('token_not_allowed', 'pair not whitelisted')
    const minExpiry = this.chainNow(c) + BigInt(c.cfg.expiryBufferSec)
    const bucket = minExpiry / 5n
    const key = `${base}|${quote}|${limit}|${signed ? 1 : 0}`
    const hit = c.cache.get(key)
    if (hit && hit.version === c.version && hit.bucket === bucket) return hit.value
    const fmt = (r, side) => {
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
    const asks = this.db.side(c.cfg.id, base, quote, minExpiry, limit).map((r) => fmt(r, 'ask'))
    // bids: stored price = base/quote; ascending stored price = highest quote/base first = best bid first
    const bids = this.db.side(c.cfg.id, quote, base, minExpiry, limit).map((r) => fmt(r, 'bid'))
    const value = { base, quote, asks, bids, etag: `W/"${c.cfg.id}-${c.version}-${bucket}"` }
    if (c.cache.size > 2000) c.cache.clear()
    c.cache.set(key, { version: c.version, bucket, value })
    return value
  }
}
