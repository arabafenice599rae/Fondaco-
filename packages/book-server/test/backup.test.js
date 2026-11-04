// Backup script: AWS Signature V4 against AWS's published S3 example (PUT Object, documentation credentials), and a
// consistent snapshot of a WAL database while another connection is writing; restore path checked by integrity_check.
import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { signV4, snapshot } from '../scripts/backup.mjs'

const results = []
const check = (n, ok, d = '') => { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'} | ${n}${d ? ' | ' + d : ''}`) }

// AWS S3 documentation, "Signature Calculations for the Authorization Header", example "PUT Object"
const s = signV4({
  method: 'PUT', url: 'https://examplebucket.s3.amazonaws.com/test$file.text', region: 'us-east-1',
  accessKeyId: 'AKIAIOSFODNN7EXAMPLE', secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY', // gitleaks:allow (AWS documentation example)
  body: Buffer.from('Welcome to Amazon S3.'), date: new Date('2013-05-24T00:00:00Z'),
  extra: { Date: 'Fri, 24 May 2013 00:00:00 GMT', 'x-amz-storage-class': 'REDUCED_REDUNDANCY' },
})
check('B1: SigV4 matches the AWS S3 documentation example (PUT Object)', s.signature === '98ad721746da40c64f1a55b78f14c238d841ea1380cd77a1b5971af0ece108bd', s.signature)
check('B2: canonical request path-encodes "$" and signs date;host;x-amz-content-sha256;x-amz-date;x-amz-storage-class',
  s.canonical.startsWith('PUT\n/test%24file.text\n\n') && s.canonical.includes('\ndate;host;x-amz-content-sha256;x-amz-date;x-amz-storage-class\n'))

// snapshot while writing (WAL)
const dir = mkdtempSync(join(tmpdir(), 'bk-'))
const db = join(dir, 'book.sqlite')
const w = new DatabaseSync(db)
w.exec('PRAGMA journal_mode = WAL; CREATE TABLE orders (hash TEXT PRIMARY KEY, n INTEGER)')
const ins = w.prepare('INSERT INTO orders VALUES (?, ?)')
for (let i = 0; i < 500; i++) ins.run('h' + i, i)
w.exec('BEGIN'); for (let i = 500; i < 600; i++) ins.run('h' + i, i) // an open write transaction during the snapshot
const snap = snapshot(db)
w.exec('COMMIT'); w.close()
check('B3: snapshot during an open write transaction: consistent (integrity_check ok) and holds the committed rows only', snap.orders === 500 && existsSync(snap.file), `${snap.orders} orders`)

const p = results.filter(Boolean).length
console.log(`\n${p}/${results.length} checks passed`)
process.exit(p === results.length ? 0 : 1)
