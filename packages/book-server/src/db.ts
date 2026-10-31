// Storage on the built-in node:sqlite (no native deps). Amounts are stored as decimal strings (exact),
// plus a REAL price column used only for sorting.
import { DatabaseSync, type StatementSync } from 'node:sqlite'
import type { Address, Hex } from 'viem'
import type { NormalizedOrder, OrderInsert, OrderRow, OrderStatus } from './types.js'
import { migrate, type MigrationReport } from './migrations.js'

export const OPEN_STATES = ['open', 'unfunded'] as const

type Rows<T> = T[]
const all = <T>(st: StatementSync, ...args: (string | number | null)[]): Rows<T> => st.all(...args) as unknown as Rows<T>
const get = <T>(st: StatementSync, ...args: (string | number | null)[]): T | undefined => st.get(...args) as unknown as T | undefined

export interface Db {
  raw: DatabaseSync
  migration: MigrationReport
  tx<T>(fn: () => T): T
  insert(row: OrderInsert): void
  byHash(h: string): OrderRow | undefined
  byNonce(c: number, signer: Address, nonce: string): Pick<OrderRow, 'hash' | 'status'> | undefined
  setStatus(hash: Hex, status: OrderStatus, now: number, block?: bigint | number | null): boolean
  setStatusByNonce(c: number, signer: Address, nonce: string, status: OrderStatus, now: number, block?: bigint | number | null): Hex[]
  rollback(c: number, fromBlock: bigint, now: number): Pick<OrderRow, 'hash' | 'signer' | 'signer_token' | 'status'>[]
  liveBySigner(c: number, signer: Address): OrderRow[]
  liveSigners(c: number): { signer: Address; unfunded: number }[]
  countLive(c: number): number
  countByStatus(): { chain_id: number; status: OrderStatus; n: number }[]
  expire(c: number, chainTime: number, now: number): Hex[]
  invalidateFee(c: number, fee: number, now: number): Hex[]
  reviveFee(c: number, fee: number, chainTime: number, now: number): Hex[]
  live(c: number): OrderRow[]
  liveBySignerToken(c: number, signer: Address, token: Address): OrderRow[]
  side(c: number, give: Address, want: Address, minExpiry: bigint, limit: number): OrderRow[]
  bySigner(c: number, signer: Address): OrderRow[]
  setLive(hash: Hex, live: boolean, now: number): void
  revoked(c: number, chainTime: bigint): OrderRow[]
  revokedBySigner(c: number, signer: Address, chainTime: bigint): OrderRow[]
  getMeta(k: string): string | undefined
  setMeta(k: string, v: string | number | bigint): void
}

export function openDb(file: string): Db {
  const db = new DatabaseSync(file)
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = NORMAL;
    PRAGMA busy_timeout = 5000;
    PRAGMA temp_store = MEMORY;
    PRAGMA foreign_keys = ON;
  `)
  const migration = migrate(db)

  const p = (sql: string) => db.prepare(sql)
  const st = {
    insert: p(`INSERT INTO orders (hash, chain_id, nonce, expiry, signer, signer_token, signer_amount, sender_wallet, sender_token,
      sender_amount, protocol_fee, v, r, s, price, status, created_at, updated_at, contract_signer)
      VALUES (:hash,:chain_id,:nonce,:expiry,:signer,:signer_token,:signer_amount,:sender_wallet,
      :sender_token,:sender_amount,:protocol_fee,:v,:r,:s,:price,:status,:now,:now,:contract_signer)`),
    byHash: p('SELECT * FROM orders WHERE hash = ?'),
    byNonce: p('SELECT hash, status FROM orders WHERE chain_id = ? AND signer = ? AND nonce = ?'),
    setStatus: p(`UPDATE orders SET status = ?, updated_at = ?, status_block = ?, signer_revoked = MAX(signer_revoked, ?) WHERE hash = ? AND status <> ?`),
    // 'used' (seen consumed by a read) is upgraded to filled/cancelled when the event arrives.
    // invalid_signer too: after revoke() the old signature is valid again on-chain, so it can still be filled or cancelled.
    setStatusByNonce: p(`UPDATE orders SET status = ?, updated_at = ?, status_block = ? WHERE chain_id = ? AND signer = ? AND nonce = ?
      AND status IN ('open','unfunded','invalid_fee','used','invalid_signer') RETURNING hash`),
    // reorg: statuses observed on blocks that are no longer canonical are re-checked; a revoked order never returns to the book (A-02)
    rollback: p(`UPDATE orders SET status = CASE WHEN signer_revoked = 1 THEN 'invalid_signer' ELSE 'unfunded' END, status_block = NULL,
      updated_at = ? WHERE chain_id = ? AND status IN ('filled','cancelled','used') AND status_block >= ? RETURNING hash, signer, signer_token, status`),
    expire: p(`UPDATE orders SET status = 'expired', updated_at = ? WHERE chain_id = ? AND status IN ('open','unfunded','invalid_fee')
      AND expiry <= ? RETURNING hash`),
    invalidateFee: p(`UPDATE orders SET status = 'invalid_fee', updated_at = ? WHERE chain_id = ? AND status IN ('open','unfunded')
      AND protocol_fee <> ? RETURNING hash`),
    // fee set back to a value some orders were signed with → they become fillable again (re-allocated next revalidation)
    reviveFee: p(`UPDATE orders SET status = 'unfunded', updated_at = ? WHERE chain_id = ? AND status = 'invalid_fee'
      AND protocol_fee = ? AND expiry > ? RETURNING hash`),
    live: p(`SELECT * FROM orders WHERE chain_id = ? AND status IN ('open','unfunded') ORDER BY created_at, rowid`),
    liveBySigner: p(`SELECT * FROM orders WHERE chain_id = ? AND signer = ? AND status IN ('open','unfunded') ORDER BY created_at, rowid`),
    liveSigners: p(`SELECT signer, MAX(status = 'unfunded') AS unfunded FROM orders WHERE chain_id = ? AND status IN ('open','unfunded') GROUP BY signer`),
    countLive: p(`SELECT COUNT(*) AS n FROM orders WHERE chain_id = ? AND status IN ('open','unfunded','invalid_fee')`),
    countByStatus: p('SELECT chain_id, status, COUNT(*) AS n FROM orders GROUP BY chain_id, status'),
    liveBySignerToken: p(`SELECT * FROM orders WHERE chain_id = ? AND signer = ? AND signer_token = ? AND status IN ('open','unfunded')
      ORDER BY created_at, rowid`),
    // orders about to expire are hidden (expiry buffer) so takers do not land an OrderExpired revert
    side: p(`SELECT * FROM orders INDEXED BY orders_book_open WHERE chain_id = ? AND signer_token = ? AND sender_token = ? AND status = 'open'
      AND sender_wallet = '0x0000000000000000000000000000000000000000' AND expiry > ? ORDER BY price ASC LIMIT ?`),
    bySigner: p('SELECT * FROM orders WHERE chain_id = ? AND signer = ? ORDER BY created_at DESC LIMIT 500'),
    setLive: p('UPDATE orders SET onchain_live = ?, updated_at = ? WHERE hash = ?'),
    // invalid_signer orders whose signature may come back to life: watched until filled, cancelled or expired
    revoked: p(`SELECT * FROM orders WHERE chain_id = ? AND status = 'invalid_signer' AND expiry > ? ORDER BY created_at, rowid`),
    revokedBySigner: p(`SELECT * FROM orders WHERE chain_id = ? AND signer = ? AND status = 'invalid_signer' AND expiry > ? ORDER BY created_at, rowid`),
    getMeta: p('SELECT value FROM meta WHERE key = ?'),
    setMeta: p('INSERT INTO meta(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'),
  }
  const blk = (b: bigint | number | null | undefined) => (b == null ? null : Number(b))

  return {
    raw: db,
    migration,
    tx(fn) {
      db.exec('BEGIN')
      try { const r = fn(); db.exec('COMMIT'); return r } catch (e) { db.exec('ROLLBACK'); throw e }
    },
    insert: (row) => { st.insert.run(row as unknown as Record<string, string | number>) },
    byHash: (h) => get<OrderRow>(st.byHash, h),
    byNonce: (c, signer, nonce) => get(st.byNonce, c, signer, nonce),
    setStatus: (hash, status, now, block = null) => Number(st.setStatus.run(status, now, blk(block), status === 'invalid_signer' ? 1 : 0, hash, status).changes) > 0,
    setStatusByNonce: (c, signer, nonce, status, now, block = null) => all<{ hash: Hex }>(st.setStatusByNonce, status, now, blk(block), c, signer, nonce).map((r) => r.hash),
    rollback: (c, fromBlock, now) => all(st.rollback, now, c, Number(fromBlock)),
    liveBySigner: (c, signer) => all<OrderRow>(st.liveBySigner, c, signer),
    liveSigners: (c) => all(st.liveSigners, c),
    countLive: (c) => (get<{ n: number }>(st.countLive, c) as { n: number }).n,
    countByStatus: () => all(st.countByStatus),
    expire: (c, chainTime, now) => all<{ hash: Hex }>(st.expire, now, c, chainTime).map((r) => r.hash),
    invalidateFee: (c, fee, now) => all<{ hash: Hex }>(st.invalidateFee, now, c, fee).map((r) => r.hash),
    reviveFee: (c, fee, chainTime, now) => all<{ hash: Hex }>(st.reviveFee, now, c, fee, chainTime).map((r) => r.hash),
    live: (c) => all<OrderRow>(st.live, c),
    liveBySignerToken: (c, signer, token) => all<OrderRow>(st.liveBySignerToken, c, signer, token),
    side: (c, give, want, minExpiry, limit) => all<OrderRow>(st.side, c, give, want, Number(minExpiry), limit),
    bySigner: (c, signer) => all<OrderRow>(st.bySigner, c, signer),
    setLive: (hash, live, now) => { st.setLive.run(live ? 1 : 0, now, hash) },
    revoked: (c, chainTime) => all<OrderRow>(st.revoked, c, Number(chainTime)),
    revokedBySigner: (c, signer, chainTime) => all<OrderRow>(st.revokedBySigner, c, signer, Number(chainTime)),
    getMeta: (k) => get<{ value: string }>(st.getMeta, k)?.value,
    setMeta: (k, v) => { st.setMeta.run(k, String(v)) },
  }
}

export const rowToOrder = (r: OrderRow): NormalizedOrder => ({
  nonce: BigInt(r.nonce),
  expiry: BigInt(r.expiry),
  signerWallet: r.signer,
  signerToken: r.signer_token,
  signerAmount: BigInt(r.signer_amount),
  protocolFee: BigInt(r.protocol_fee),
  senderWallet: r.sender_wallet,
  senderToken: r.sender_token,
  senderAmount: BigInt(r.sender_amount),
  v: r.v,
  r: r.r,
  s: r.s,
})

export interface OrderJson {
  hash: Hex
  chainId: number
  status: OrderStatus
  order: Record<string, string | number>
  createdAt: number
  updatedAt: number
}

/** @param withSignature false → omit v/r/s (private orders listed by signer: terms visible to the owner's UI, not executable copies) */
export const rowToJson = (r: OrderRow, withSignature = true): OrderJson => ({
  hash: r.hash,
  chainId: r.chain_id,
  status: r.status,
  order: {
    nonce: r.nonce, expiry: String(r.expiry), signerWallet: r.signer, signerToken: r.signer_token, signerAmount: r.signer_amount,
    protocolFee: String(r.protocol_fee), senderWallet: r.sender_wallet, senderToken: r.sender_token, senderAmount: r.sender_amount,
    ...(withSignature ? { v: r.v, r: r.r, s: r.s } : {}),
  },
  createdAt: r.created_at,
  updatedAt: r.updated_at,
})
