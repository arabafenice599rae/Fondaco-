// Versioned migrations (no chain needed). Legacy databases are created by the REAL legacy code (test/fixtures/legacy):
// the JavaScript reference server's db.js and the phase-1 JS db.js, plus the oldest reference layout (v1, by SQL).
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { openDb, migrate, MIGRATIONS, LATEST_VERSION, MigrationError } from '../dist/index.js'
import { openDb as openReferenceDb } from './fixtures/legacy/reference-db.js'
import { openDb as openPhase1Db } from './fixtures/legacy/phase1-db.js'

const results = []
const check = (n, ok, d = '') => { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'} | ${n}${d ? ' | ' + d : ''}`) }
const dir = mkdtempSync(join(tmpdir(), 'fondaco-mig-'))
const file = (n) => join(dir, `${n}.sqlite`)
const ZERO = '0x0000000000000000000000000000000000000000'
const A = '0x1111111111111111111111111111111111111111', T1 = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', T2 = '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2'
const row = (i, status, extra = {}) => ({ hash: `0x${i.toString(16).padStart(64, '0')}`, chain_id: 1, nonce: String(i), expiry: 2_000_000_000 + i, signer: A, signer_token: T1,
  signer_amount: '1000000', sender_wallet: ZERO, sender_token: T2, sender_amount: '400000000000000', protocol_fee: 30, v: 27, r: '0x' + 'ab'.repeat(32), s: '0x' + 'cd'.repeat(32),
  price: 2500 + i, status, now: 1_700_000_000_000 + i, contract_signer: 0, ...extra })
const STATUSES = ['open', 'unfunded', 'filled', 'cancelled', 'used', 'expired', 'invalid_fee', 'invalid_signer']
const shape = (db) => ({
  cols: db.prepare('PRAGMA table_info(orders)').all().map((c) => `${c.name}:${c.type}:${c.notnull}:${c.dflt_value}`).sort().join(','),
  idx: db.prepare(`SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'orders' AND name NOT LIKE 'sqlite_%'`).all().map((r) => r.name).sort().join(','),
})
const dump = (raw, cols) => raw.prepare(`SELECT ${cols.join(',')} FROM orders ORDER BY hash`).all()
const SHARED = ['hash', 'chain_id', 'nonce', 'expiry', 'signer', 'signer_token', 'signer_amount', 'sender_wallet', 'sender_token', 'sender_amount', 'protocol_fee', 'v', 'r', 's', 'price', 'status', 'created_at', 'updated_at']

// M1 fresh database
const fresh = openDb(file('fresh'))
const freshShape = shape(fresh.raw)
const hist = fresh.raw.prepare('SELECT version FROM schema_migrations ORDER BY version').all().map((r) => r.version)
const jm = fresh.raw.prepare('PRAGMA journal_mode').get().journal_mode
check('M1: fresh database migrated to the latest version, history recorded, WAL', fresh.migration.to === LATEST_VERSION && LATEST_VERSION === MIGRATIONS.length && hist.join() === '1,2,3,4,5' && !fresh.migration.adoptedLegacy && jm === 'wal',
  `v${fresh.migration.to}, history ${hist}, journal ${jm}`)

// M2 database written by the JavaScript reference server (exchange-book.zip db.js), with orders in every status
const ref = openReferenceDb(file('reference'))
STATUSES.forEach((s, i) => ref.insert(row(i + 1, s)))
ref.setStatus(row(3).hash, 'filled', 1_700_000_000_999, 23_700_005)
ref.setMeta('last_block:1', '23700010'); ref.setMeta('last_hash:1', '0xbeef')
const before = dump(ref.raw, [...SHARED, 'status_block', 'contract_signer'])
ref.raw.close()
const m2 = openDb(file('reference'))
const after = dump(m2.raw, [...SHARED, 'status_block', 'contract_signer'])
const extra2 = dump(m2.raw, ['signer_revoked', 'onchain_live'])
const sideOk = m2.side(1, T1, T2, 0n, 10).length === 1 && m2.live(1).length === 2 && m2.bySigner(1, A).length === 8 && m2.getMeta('last_block:1') === '23700010'
check('M2: reference JS database adopted and migrated; every row and meta value preserved; queries work', m2.migration.adoptedLegacy && m2.migration.from === 0 && m2.migration.to === LATEST_VERSION &&
  JSON.stringify(after) === JSON.stringify(before) && extra2.every((r) => r.signer_revoked === 0 && r.onchain_live === null) && sideOk && JSON.stringify(shape(m2.raw)) === JSON.stringify(freshShape),
  `applied ${m2.migration.applied.map((a) => 'v' + a.version).join(',')}; ${after.length} rows identical; schema = fresh schema`)

// M3 oldest reference layout (v1: no status_block / contract_signer)
const old = new DatabaseSync(file('v1'))
MIGRATIONS[0].up(old)
const ins = old.prepare(`INSERT INTO orders (hash, chain_id, nonce, expiry, signer, signer_token, signer_amount, sender_wallet, sender_token, sender_amount, protocol_fee, v, r, s, price, status, created_at, updated_at)
  VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
for (let i = 1; i <= 3; i++) { const r = row(i, STATUSES[i - 1]); ins.run(r.hash, 1, r.nonce, r.expiry, A, T1, r.signer_amount, ZERO, T2, r.sender_amount, 30, 27, r.r, r.s, r.price, r.status, r.now, r.now) }
const before3 = dump(old, SHARED)
old.close()
const m3 = openDb(file('v1'))
const b3 = dump(m3.raw, ['status_block', 'contract_signer'])
check('M3: oldest reference layout (v1) gains status_block/contract_signer/signer_revoked/onchain_live, data intact', JSON.stringify(dump(m3.raw, SHARED)) === JSON.stringify(before3) &&
  b3.every((r) => r.status_block === null && r.contract_signer === 0) && JSON.stringify(shape(m3.raw)) === JSON.stringify(freshShape))

// M4 phase-1 JS database (already has signer_revoked and onchain_live, user_version 0)
const p1 = openPhase1Db(file('phase1'))
p1.insert(row(1, 'open'))
p1.insert(row(2, 'unfunded'))
p1.setStatus(row(2).hash, 'invalid_signer', 1_700_000_001_000)
p1.setLive(row(2).hash, true, 1_700_000_001_001)
const before4 = dump(p1.raw, [...SHARED, 'signer_revoked', 'onchain_live'])
p1.raw.close()
const m4 = openDb(file('phase1'))
check('M4: phase-1 JS database (columns already present) migrates without errors, revoked/live flags preserved', m4.migration.adoptedLegacy && m4.migration.to === LATEST_VERSION &&
  JSON.stringify(dump(m4.raw, [...SHARED, 'signer_revoked', 'onchain_live'])) === JSON.stringify(before4) && m4.byHash(row(2).hash).signer_revoked === 1 && m4.byHash(row(2).hash).onchain_live === 1)

// M5 re-open is a no-op
m4.raw.close()
const m5 = openDb(file('phase1'))
check('M5: reopening a migrated database applies nothing', m5.migration.applied.length === 0 && !m5.migration.adoptedLegacy && m5.migration.from === LATEST_VERSION)
m5.raw.close()

// M6 a database from a newer server is refused, readable message
const newer = new DatabaseSync(file('newer'))
newer.exec('PRAGMA user_version = 99')
newer.close()
let e6 = null
try { openDb(file('newer')) } catch (e) { e6 = e }
check('M6: database newer than the code is refused (no downgrade)', e6 instanceof MigrationError && /schema v99 is newer than this server \(knows up to v5\)/.test(e6.message), e6?.message)

// M7 a failing step rolls back completely
const m7 = new DatabaseSync(file('fail'))
migrate(m7)
const broken = [...MIGRATIONS, { version: 6, name: 'broken', up: (db) => { db.exec('ALTER TABLE orders ADD COLUMN half_done INTEGER'); throw new Error('boom') } }]
let e7 = null
try { migrate(m7, broken) } catch (e) { e7 = e }
const v7 = m7.prepare('PRAGMA user_version').get().user_version
const cols7 = m7.prepare('PRAGMA table_info(orders)').all().map((c) => c.name)
check('M7: failed migration rolls back (version, columns and history unchanged)', e7 instanceof MigrationError && v7 === 5 && !cols7.includes('half_done') &&
  m7.prepare('SELECT COUNT(*) AS n FROM schema_migrations WHERE version = 6').get().n === 0, e7?.message)

const failed = results.filter((x) => !x).length
console.log(`\n${results.length - failed}/${results.length} checks passed`)
process.exit(failed ? 1 : 0)
