// Hourly backups of the book's SQLite database to S3-compatible storage (AWS S3, Cloudflare R2, Backblaze B2, MinIO…).
// No dependencies: node:sqlite for a consistent snapshot (VACUUM INTO, safe while the book writes in WAL mode),
// PRAGMA integrity_check on the snapshot, gzip, AWS Signature V4 PUT (path-style). Same image as the book.
//
//   node scripts/backup.mjs once                 one backup now
//   node scripts/backup.mjs loop                 one backup every BACKUP_EVERY_SEC (default 3600)
//   node scripts/backup.mjs list                 list the backups in the bucket (newest last)
//   node scripts/backup.mjs restore <key|latest> <target.sqlite>   download, check and write a database (book stopped!)
//
// Environment: BOOK_DB (default /data/book.sqlite), S3_ENDPOINT (https://…), S3_BUCKET, S3_REGION (default us-east-1),
// S3_ACCESS_KEY_ID, S3_SECRET_ACCESS_KEY, S3_PREFIX (default book/), BACKUP_KEEP (remote copies kept, default 168 = 7 days).
import { createHash, createHmac } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, writeFileSync, renameSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gzipSync, gunzipSync } from 'node:zlib'
import { DatabaseSync } from 'node:sqlite'
import { fileURLToPath } from 'node:url'

const sha256hex = (b) => createHash('sha256').update(b).digest('hex')
const hmac = (k, s) => createHmac('sha256', k).update(s).digest()
const enc = (s) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase())

/**
 * AWS Signature V4 headers for one S3 request (path-style URL). Exported for the test against AWS's published example.
 * @returns headers to send (Authorization, x-amz-date, x-amz-content-sha256, plus `extra`)
 */
export function signV4({ method, url, region, accessKeyId, secretAccessKey, body = Buffer.alloc(0), date = new Date(), extra = {} }) {
  const u = new URL(url)
  const amzDate = date.toISOString().replace(/[:-]|\.\d{3}/g, ''), day = amzDate.slice(0, 8)
  const payload = sha256hex(body)
  const headers = { host: u.host, 'x-amz-content-sha256': payload, 'x-amz-date': amzDate, ...Object.fromEntries(Object.entries(extra).map(([k, v]) => [k.toLowerCase(), String(v).trim()])) }
  const names = Object.keys(headers).sort()
  const query = [...u.searchParams.entries()].map(([k, v]) => [enc(k), enc(v)]).sort(([a, x], [b, y]) => (a === b ? (x < y ? -1 : 1) : a < b ? -1 : 1)).map(([k, v]) => `${k}=${v}`).join('&')
  const path = u.pathname.split('/').map((seg) => enc(decodeURIComponent(seg))).join('/')
  const canonical = [method, path, query, names.map((n) => `${n}:${headers[n]}\n`).join(''), names.join(';'), payload].join('\n')
  const scope = `${day}/${region}/s3/aws4_request`
  const toSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256hex(canonical)].join('\n')
  const key = hmac(hmac(hmac(hmac('AWS4' + secretAccessKey, day), region), 's3'), 'aws4_request')
  const signature = createHmac('sha256', key).update(toSign).digest('hex')
  const out = { ...headers, authorization: `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${scope},SignedHeaders=${names.join(';')},Signature=${signature}` }
  delete out.host
  return { headers: out, signature, canonical }
}

function s3() {
  const e = process.env
  for (const k of ['S3_ENDPOINT', 'S3_BUCKET', 'S3_ACCESS_KEY_ID', 'S3_SECRET_ACCESS_KEY']) if (!e[k]) throw new Error(`${k} is not set`)
  const base = e.S3_ENDPOINT.replace(/\/+$/, '') + '/' + e.S3_BUCKET
  const cred = { region: e.S3_REGION || 'us-east-1', accessKeyId: e.S3_ACCESS_KEY_ID, secretAccessKey: e.S3_SECRET_ACCESS_KEY }
  const req = async (method, key, { body, query = '' } = {}) => {
    const url = `${base}/${key}${query}`
    const { headers } = signV4({ method, url, body, ...cred })
    const r = await fetch(url, { method, headers, body })
    if (!r.ok) throw new Error(`S3 ${method} ${key}${query} → ${r.status} ${(await r.text()).slice(0, 200)}`)
    return r
  }
  return { prefix: e.S3_PREFIX ?? 'book/', req }
}

/** Consistent snapshot of `db` (the book may be writing): VACUUM INTO, then integrity_check on the copy. */
export function snapshot(db) {
  const dir = mkdtempSync(join(tmpdir(), 'book-backup-'))
  const out = join(dir, 'snapshot.sqlite')
  const src = new DatabaseSync(db, { readOnly: true })
  try { src.exec(`VACUUM INTO '${out.replace(/'/g, "''")}'`) } finally { src.close() }
  const chk = new DatabaseSync(out, { readOnly: true })
  try {
    const r = chk.prepare('PRAGMA integrity_check').get()
    if (r?.integrity_check !== 'ok') throw new Error(`integrity_check: ${JSON.stringify(r)}`)
    const rows = chk.prepare('SELECT COUNT(*) AS n FROM orders').get()
    return { file: out, dir, orders: Number(rows?.n ?? 0) }
  } finally { chk.close() }
}

async function list(c) {
  const keys = []
  let token = ''
  for (;;) {
    const q = `?list-type=2&prefix=${enc(c.prefix)}${token ? `&continuation-token=${enc(token)}` : ''}`
    const xml = await (await c.req('GET', '', { query: q })).text()
    for (const m of xml.matchAll(/<Key>([^<]+)<\/Key>/g)) keys.push(m[1])
    const t = /<NextContinuationToken>([^<]+)</.exec(xml)
    if (!t) break
    token = t[1]
  }
  return keys.sort()
}

async function once() {
  const c = s3(), db = process.env.BOOK_DB || '/data/book.sqlite'
  const snap = snapshot(db)
  try {
    const body = gzipSync(readFileSync(snap.file), { level: 9 })
    const key = `${c.prefix}book-${new Date().toISOString().replace(/[:.]/g, '-')}.sqlite.gz`
    await c.req('PUT', key, { body })
    const keep = Number(process.env.BACKUP_KEEP || 168)
    const all = await list(c)
    for (const old of all.slice(0, Math.max(0, all.length - keep))) await c.req('DELETE', old)
    log({ msg: 'backup uploaded', key, bytes: body.length, orders: snap.orders, kept: Math.min(all.length, keep) })
  } finally { rmSync(snap.dir, { recursive: true, force: true }) }
}

async function restore(which, target) {
  if (!target) throw new Error('usage: restore <key|latest> <target.sqlite>')
  if (existsSync(target)) throw new Error(`${target} exists: move it away first (and stop the book)`)
  const c = s3()
  const key = which === 'latest' ? (await list(c)).at(-1) : which
  if (!key) throw new Error('no backup found')
  const raw = gunzipSync(Buffer.from(await (await c.req('GET', key)).arrayBuffer()))
  const tmp = target + '.part'
  writeFileSync(tmp, raw)
  const chk = new DatabaseSync(tmp, { readOnly: true })
  try { if (chk.prepare('PRAGMA integrity_check').get()?.integrity_check !== 'ok') throw new Error('downloaded backup fails integrity_check') } finally { chk.close() }
  renameSync(tmp, target)
  log({ msg: 'restored', key, target, bytes: raw.length })
}

const log = (o) => process.stdout.write(JSON.stringify({ t: new Date().toISOString(), level: 'info', service: 'backup', ...o }) + '\n')

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]
if (isMain) {
  const [cmd, a, b] = process.argv.slice(2)
  const fail = (e) => { process.stdout.write(JSON.stringify({ t: new Date().toISOString(), level: 'error', service: 'backup', msg: e.message }) + '\n') }
  if (cmd === 'once') once().catch((e) => { fail(e); process.exit(1) })
  else if (cmd === 'list') list(s3()).then((k) => console.log(k.join('\n'))).catch((e) => { fail(e); process.exit(1) })
  else if (cmd === 'restore') restore(a, b).catch((e) => { fail(e); process.exit(1) })
  else if (cmd === 'loop') {
    const every = Number(process.env.BACKUP_EVERY_SEC || 3600) * 1000
    const tick = () => once().catch(fail).finally(() => setTimeout(tick, every))
    setTimeout(tick, Number(process.env.BACKUP_FIRST_DELAY_SEC || 60) * 1000)
  } else { console.error('usage: backup.mjs once|loop|list|restore <key|latest> <target>'); process.exit(2) }
}
