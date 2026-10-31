// Storage on the built-in node:sqlite (no native deps). Amounts are stored as decimal strings (exact),
// plus a REAL price column used only for sorting.
import { DatabaseSync } from 'node:sqlite'

export const OPEN_STATES = ['open', 'unfunded']

export function openDb(file) {
  const db = new DatabaseSync(file)
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = NORMAL;
    PRAGMA busy_timeout = 5000;
    PRAGMA temp_store = MEMORY;
    PRAGMA foreign_keys = ON;
    CREATE TABLE IF NOT EXISTS orders (
      hash TEXT PRIMARY KEY,
      chain_id INTEGER NOT NULL,
      nonce TEXT NOT NULL,
      expiry INTEGER NOT NULL,
      signer TEXT NOT NULL,
      signer_token TEXT NOT NULL,
      signer_amount TEXT NOT NULL,
      sender_wallet TEXT NOT NULL,
      sender_token TEXT NOT NULL,
      sender_amount TEXT NOT NULL,
      protocol_fee INTEGER NOT NULL,
      v INTEGER NOT NULL, r TEXT NOT NULL, s TEXT NOT NULL,
      price REAL NOT NULL,              -- senderAmount / signerAmount, decimals-adjusted
      status TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      UNIQUE (chain_id, signer, nonce)
    );
    CREATE INDEX IF NOT EXISTS orders_book ON orders (chain_id, signer_token, sender_token, status, price);
    CREATE INDEX IF NOT EXISTS orders_live ON orders (chain_id, status);
    CREATE INDEX IF NOT EXISTS orders_signer ON orders (chain_id, signer);
    CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  `)
  // migrations (additive): block at which an on-chain status was observed (reorg rollback), contract signer flag
  const cols = new Set(db.prepare('PRAGMA table_info(orders)').all().map((c) => c.name))
  if (!cols.has('status_block')) db.exec('ALTER TABLE orders ADD COLUMN status_block INTEGER')
  if (!cols.has('contract_signer')) db.exec('ALTER TABLE orders ADD COLUMN contract_signer INTEGER NOT NULL DEFAULT 0')
  // once invalid_signer, always invalid_signer in the book (decision A-02): kept across reorg rollbacks
  if (!cols.has('signer_revoked')) db.exec('ALTER TABLE orders ADD COLUMN signer_revoked INTEGER NOT NULL DEFAULT 0')
  db.exec(`
    -- the book query reads only public open orders: a partial index keeps it small and ordered by price
    CREATE INDEX IF NOT EXISTS orders_book_open ON orders (chain_id, signer_token, sender_token, price)
      WHERE status = 'open' AND sender_wallet = '0x0000000000000000000000000000000000000000';
    CREATE INDEX IF NOT EXISTS orders_signer_token ON orders (chain_id, signer, signer_token, status);
    CREATE INDEX IF NOT EXISTS orders_status_block ON orders (chain_id, status_block) WHERE status_block IS NOT NULL;
  `)

  const st = {
    insert: db.prepare(`INSERT INTO orders (hash, chain_id, nonce, expiry, signer, signer_token, signer_amount, sender_wallet, sender_token,
      sender_amount, protocol_fee, v, r, s, price, status, created_at, updated_at, contract_signer)
      VALUES (:hash,:chain_id,:nonce,:expiry,:signer,:signer_token,:signer_amount,:sender_wallet,
      :sender_token,:sender_amount,:protocol_fee,:v,:r,:s,:price,:status,:now,:now,:contract_signer)`),
    byHash: db.prepare('SELECT * FROM orders WHERE hash = ?'),
    byNonce: db.prepare('SELECT hash, status FROM orders WHERE chain_id = ? AND signer = ? AND nonce = ?'),
    setStatus: db.prepare(`UPDATE orders SET status = ?, updated_at = ?, status_block = ?, signer_revoked = MAX(signer_revoked, ?) WHERE hash = ? AND status <> ?`),
    // 'used' (seen consumed by a read) is upgraded to filled/cancelled when the event arrives.
    // invalid_signer too: after revoke() the old signature is valid again on-chain, so it can still be filled or cancelled.
    setStatusByNonce: db.prepare(`UPDATE orders SET status = ?, updated_at = ?, status_block = ? WHERE chain_id = ? AND signer = ? AND nonce = ?
      AND status IN ('open','unfunded','invalid_fee','used','invalid_signer') RETURNING hash`),
    // reorg: statuses observed on blocks that are no longer canonical go back to unfunded and are re-checked
    // a rolled-back order that had been invalid_signer goes back to invalid_signer, never to the book (A-02)
    rollback: db.prepare(`UPDATE orders SET status = CASE WHEN signer_revoked = 1 THEN 'invalid_signer' ELSE 'unfunded' END, status_block = NULL,
      updated_at = ? WHERE chain_id = ? AND status IN ('filled','cancelled','used') AND status_block >= ? RETURNING hash, signer, signer_token, status`),
    expire: db.prepare(`UPDATE orders SET status = 'expired', updated_at = ? WHERE chain_id = ? AND status IN ('open','unfunded','invalid_fee')
      AND expiry <= ? RETURNING hash`),
    invalidateFee: db.prepare(`UPDATE orders SET status = 'invalid_fee', updated_at = ? WHERE chain_id = ? AND status IN ('open','unfunded')
      AND protocol_fee <> ? RETURNING hash`),
    // fee set back to a value some orders were signed with → they become fillable again (re-allocated next revalidation)
    reviveFee: db.prepare(`UPDATE orders SET status = 'unfunded', updated_at = ? WHERE chain_id = ? AND status = 'invalid_fee'
      AND protocol_fee = ? AND expiry > ? RETURNING hash`),
    live: db.prepare(`SELECT * FROM orders WHERE chain_id = ? AND status IN ('open','unfunded') ORDER BY created_at, rowid`),
    liveBySigner: db.prepare(`SELECT * FROM orders WHERE chain_id = ? AND signer = ? AND status IN ('open','unfunded') ORDER BY created_at, rowid`),
    liveSigners: db.prepare(`SELECT signer, MAX(status = 'unfunded') AS unfunded FROM orders WHERE chain_id = ? AND status IN ('open','unfunded') GROUP BY signer`),
    countLive: db.prepare(`SELECT COUNT(*) AS n FROM orders WHERE chain_id = ? AND status IN ('open','unfunded','invalid_fee')`),
    liveBySignerToken: db.prepare(`SELECT * FROM orders WHERE chain_id = ? AND signer = ? AND signer_token = ? AND status IN ('open','unfunded')
      ORDER BY created_at, rowid`),
    // orders about to expire are hidden (expiry buffer) so takers do not land an OrderExpired revert
    side: db.prepare(`SELECT * FROM orders INDEXED BY orders_book_open WHERE chain_id = ? AND signer_token = ? AND sender_token = ? AND status = 'open'
      AND sender_wallet = '0x0000000000000000000000000000000000000000' AND expiry > ? ORDER BY price ASC LIMIT ?`),
    bySigner: db.prepare('SELECT * FROM orders WHERE chain_id = ? AND signer = ? ORDER BY created_at DESC LIMIT 500'),
    getMeta: db.prepare('SELECT value FROM meta WHERE key = ?'),
    setMeta: db.prepare('INSERT INTO meta(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'),
  }

  return {
    raw: db,
    tx(fn) {
      db.exec('BEGIN')
      try { const r = fn(); db.exec('COMMIT'); return r } catch (e) { db.exec('ROLLBACK'); throw e }
    },
    insert: (row) => st.insert.run(row),
    byHash: (h) => st.byHash.get(h),
    byNonce: (c, signer, nonce) => st.byNonce.get(c, signer, nonce),
    setStatus: (hash, status, now, block = null) => st.setStatus.run(status, now, block == null ? null : Number(block), status === 'invalid_signer' ? 1 : 0, hash, status).changes > 0,
    setStatusByNonce: (c, signer, nonce, status, now, block = null) => st.setStatusByNonce.all(status, now, block == null ? null : Number(block), c, signer, nonce).map((r) => r.hash),
    rollback: (c, fromBlock, now) => st.rollback.all(now, c, Number(fromBlock)),
    liveBySigner: (c, signer) => st.liveBySigner.all(c, signer),
    liveSigners: (c) => st.liveSigners.all(c),
    countLive: (c) => st.countLive.get(c).n,
    expire: (c, chainTime, now) => st.expire.all(now, c, chainTime).map((r) => r.hash),
    invalidateFee: (c, fee, now) => st.invalidateFee.all(now, c, fee).map((r) => r.hash),
    reviveFee: (c, fee, chainTime, now) => st.reviveFee.all(now, c, fee, chainTime).map((r) => r.hash),
    live: (c) => st.live.all(c),
    liveBySignerToken: (c, signer, token) => st.liveBySignerToken.all(c, signer, token),
    side: (c, give, want, minExpiry, limit) => st.side.all(c, give, want, Number(minExpiry), limit),
    bySigner: (c, signer) => st.bySigner.all(c, signer),
    getMeta: (k) => st.getMeta.get(k)?.value,
    setMeta: (k, v) => st.setMeta.run(k, String(v)),
  }
}

export const rowToOrder = (r) => ({
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

/** @param withSignature false → omit v/r/s (private orders listed by signer: terms visible to the owner's UI, not executable copies) */
export const rowToJson = (r, withSignature = true) => ({
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
