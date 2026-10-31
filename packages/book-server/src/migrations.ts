// Versioned schema migrations on PRAGMA user_version, with a history table.
//
// Databases written by the JavaScript reference server have user_version = 0 but already contain `orders`: they are
// adopted as v1 and then brought forward by idempotent steps, so every intermediate reference layout migrates
// (v1 only; v1 + status_block/contract_signer; the phase-1 JS columns signer_revoked/onchain_live).
// Each step runs in a transaction: a failure leaves the database at the previous version.
import type { DatabaseSync } from 'node:sqlite'

export interface Migration { version: number; name: string; up(db: DatabaseSync): void }
export interface MigrationReport { from: number; to: number; adoptedLegacy: boolean; applied: { version: number; name: string }[] }

const columns = (db: DatabaseSync, table: string): Set<string> =>
  new Set((db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => c.name))
const addColumn = (db: DatabaseSync, table: string, col: string, ddl: string) => { if (!columns(db, table).has(col)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${ddl}`) }
const hasTable = (db: DatabaseSync, name: string) => !!db.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`).get(name)

export const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    name: 'orders and meta (reference schema)',
    up: (db) => db.exec(`
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
    `),
  },
  {
    version: 2,
    name: 'status_block (reorg rollback), contract_signer (EIP-1271), book indexes',
    up: (db) => {
      addColumn(db, 'orders', 'status_block', 'INTEGER')
      addColumn(db, 'orders', 'contract_signer', 'INTEGER NOT NULL DEFAULT 0')
      db.exec(`
        -- the book query reads only public open orders: a partial index keeps it small and ordered by price
        CREATE INDEX IF NOT EXISTS orders_book_open ON orders (chain_id, signer_token, sender_token, price)
          WHERE status = 'open' AND sender_wallet = '0x0000000000000000000000000000000000000000';
        CREATE INDEX IF NOT EXISTS orders_signer_token ON orders (chain_id, signer, signer_token, status);
        CREATE INDEX IF NOT EXISTS orders_status_block ON orders (chain_id, status_block) WHERE status_block IS NOT NULL;
      `)
    },
  },
  {
    version: 3,
    name: 'signer_revoked: invalid_signer stays terminal across reorgs (A-02)',
    up: (db) => addColumn(db, 'orders', 'signer_revoked', 'INTEGER NOT NULL DEFAULT 0'),
  },
  {
    version: 4,
    name: 'onchain_live: invalid_signer orders still executable on-chain (executableOnChain)',
    up: (db) => {
      addColumn(db, 'orders', 'onchain_live', 'INTEGER')
      db.exec(`CREATE INDEX IF NOT EXISTS orders_revoked ON orders (chain_id, signer, expiry) WHERE status = 'invalid_signer'`)
    },
  },
]

export const LATEST_VERSION = Math.max(...MIGRATIONS.map((m) => m.version))

export class MigrationError extends Error {}

/** Bring `db` to the latest schema. Throws MigrationError for a database newer than this code or a failed step. */
export function migrate(db: DatabaseSync, migrations: readonly Migration[] = MIGRATIONS, now: () => number = Date.now): MigrationReport {
  const latest = Math.max(...migrations.map((m) => m.version))
  let version = Number((db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version)
  const from = version
  if (version > latest) throw new MigrationError(`database schema v${version} is newer than this server (knows up to v${latest}): upgrade the server, do not downgrade the database`)
  db.exec('CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at INTEGER NOT NULL)')
  let adoptedLegacy = false
  if (version === 0 && hasTable(db, 'orders')) {
    // written by the JavaScript reference server (no user_version): its base layout is v1, later columns are added idempotently
    adoptedLegacy = true
    db.exec('PRAGMA user_version = 1')
    db.prepare('INSERT OR IGNORE INTO schema_migrations (version, name, applied_at) VALUES (1, ?, ?)').run('adopted legacy reference database', now())
    version = 1
  }
  const applied: MigrationReport['applied'] = []
  for (const m of [...migrations].sort((a, b) => a.version - b.version)) {
    if (m.version <= version) continue
    db.exec('BEGIN IMMEDIATE')
    try {
      m.up(db)
      db.prepare('INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)').run(m.version, m.name, now())
      db.exec(`PRAGMA user_version = ${m.version}`)
      db.exec('COMMIT')
    } catch (e) {
      db.exec('ROLLBACK')
      throw new MigrationError(`migration v${m.version} (${m.name}) failed, database left at v${version}: ${(e as Error).message}`)
    }
    version = m.version
    applied.push({ version: m.version, name: m.name })
  }
  return { from, to: version, adoptedLegacy, applied }
}
