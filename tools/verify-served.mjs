// Is what a host (or an IPFS gateway) serves the reproducible build? Compares every file of the build manifest
// (tools/build-hash.mjs → reports/build-manifest.txt) with the bytes served under <base-url>.
//   node tools/verify-served.mjs https://app.example.org/ [manifest]
//   node tools/verify-served.mjs https://<cid>.ipfs.dweb.link/ [manifest]       (or https://ipfs.io/ipfs/<cid>/)
// config.json is reported separately: a host may legitimately serve its own configuration (the bundle is what must match).
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)), '..')
const [base, mf = resolve(ROOT, 'reports/build-manifest.txt')] = process.argv.slice(2)
if (!base) { console.error('usage: verify-served.mjs <base-url> [manifest]'); process.exit(2) }
const lines = readFileSync(mf, 'utf8').trim().split('\n').map((l) => { const [h, ...p] = l.split('  '); return { h, p: p.join('  ') } })
let bad = 0, cfg = null
for (const { h, p } of lines) {
  const url = new URL(p, base.endsWith('/') ? base : base + '/').href
  let got = 'unreachable'
  try { const r = await fetch(url, { cache: 'no-store' }); got = r.ok ? createHash('sha256').update(Buffer.from(await r.arrayBuffer())).digest('hex') : `HTTP ${r.status}` } catch (e) { got = e.message }
  const ok = got === h
  if (p === 'config.json') { cfg = ok ? 'identical' : 'differs (host configuration)'; continue }
  if (!ok) bad++
  console.log(`${ok ? 'PASS' : 'FAIL'} | ${p}${ok ? '' : ` | ${got.slice(0, 20)} ≠ ${h.slice(0, 20)}`}`)
}
console.log(`config.json: ${cfg ?? 'not in manifest'}`)
console.log(`\n${bad ? 0 : 1}/1 checks passed — ${lines.length - (cfg ? 1 : 0) - bad}/${lines.length - (cfg ? 1 : 0)} files identical`)
process.exit(bad ? 1 : 0)
