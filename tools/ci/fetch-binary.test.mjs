// Proof of tools/ci/fetch-binary.mjs against a local HTTP server (no external host): primary blocked → fallback used →
// hash verified; wrong bytes anywhere → failure with nothing kept; cache hit → no request at all.
//   node tools/ci/fetch-binary.test.mjs
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createServer } from 'node:http'
import { existsSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'

const SCRIPT = fileURLToPath(new URL('./fetch-binary.mjs', import.meta.url))
const GOOD = Buffer.from('pinned binary v1\n'), EVIL = Buffer.from('tampered binary\n')
const SHA = createHash('sha512').update(GOOD).digest('hex')
const hits = {}
// /down → 504 (the outage of 2026-11-05), /good → the pinned bytes, /evil → other bytes
const server = createServer((req, res) => {
  hits[req.url] = (hits[req.url] ?? 0) + 1
  if (req.url === '/down') { res.writeHead(504); return res.end('gateway timeout') }
  res.writeHead(200); res.end(req.url === '/good' ? GOOD : EVIL)
})
await new Promise((r) => server.listen(0, '127.0.0.1', r))
const base = `http://127.0.0.1:${server.address().port}`
const dir = mkdtempSync(join(tmpdir(), 'fetch-binary-test-'))

async function run(sources, cache = join(dir, `cache-${Math.random().toString(36).slice(2)}`)) {
  for (const k of Object.keys(hits)) delete hits[k]
  const cfg = join(dir, 'toolchain.json')
  writeFileSync(cfg, JSON.stringify({ tool: { version: '1.0.0', file: 'tool.tgz', sha512: SHA, sources: sources.map((p) => base + p) } }))
  // async child: the server lives in this process and must keep answering while the script runs
  const r = await new Promise((res) => {
    const c = spawn(process.execPath, [SCRIPT, 'tool'], { env: { ...process.env, FETCH_CONFIG: cfg, FETCH_CACHE: cache, FETCH_ATTEMPTS: '3', FETCH_BACKOFF_MS: '10', NO_PROXY: '127.0.0.1', no_proxy: '127.0.0.1' } })
    let stdout = '', stderr = ''
    c.stdout.on('data', (d) => (stdout += d)); c.stderr.on('data', (d) => (stderr += d))
    c.on('close', (status) => res({ status, stdout, stderr }))
  })
  const path = r.stdout.trim().split('\n').pop()
  return { code: r.status, log: r.stderr, path, cache, hits: { ...hits } }
}
const results = []
const check = (n, ok, d = '') => { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'} | ${n}${d && !ok ? ' | ' + d : ''}`) }
const kept = (r) => existsSync(join(r.cache, 'tool', 'tool.tgz'))

let r = await run(['/good', '/evil'])
check('F1: primary up → primary used, sha512 verified, fallback never asked', r.code === 0 && readFileSync(r.path).equals(GOOD) && r.hits['/good'] === 1 && !r.hits['/evil'] && /primary .*verified/.test(r.log), r.log)

r = await run(['/down', '/good'])
check('F2: primary blocked (504) → 3 tries on the primary, then the fallback, sha512 verified', r.code === 0 && readFileSync(r.path).equals(GOOD) && r.hits['/down'] === 3 && r.hits['/good'] === 1 && /using fallback 1/.test(r.log) && /fallback 1 .*verified/.test(r.log), r.log)

r = await run(['/down', '/evil'])
check('F3: primary blocked, fallback with other bytes → fails, nothing kept', r.code === 1 && !kept(r) && r.hits['/down'] === 3 && r.hits['/evil'] === 1 && /nothing kept/.test(r.log), r.log)

r = await run(['/evil', '/good'])
check('F4: primary with other bytes → fails at once, the fallback is not tried', r.code === 1 && !kept(r) && r.hits['/evil'] === 1 && !r.hits['/good'], r.log)

r = await run(['/down', '/down'])
check('F5: both sources down → fails after 3 + 3 tries', r.code === 1 && !kept(r) && r.hits['/down'] === 6 && /no source could be downloaded/.test(r.log), r.log)

const warm = (await run(['/good'])).cache
r = await run(['/down', '/down'], warm)
check('F6: cache hit (actions/cache restored the file) → hash verified, no request at all', r.code === 0 && readFileSync(r.path).equals(GOOD) && Object.keys(r.hits).length === 0 && /cache hit/.test(r.log), r.log)

writeFileSync(join(warm, 'tool', 'tool.tgz'), EVIL)
r = await run(['/down', '/good'], warm)
check('F7: cached file with another hash → discarded, downloaded again (fallback), verified', r.code === 0 && readFileSync(r.path).equals(GOOD) && /discarded/.test(r.log) && r.hits['/good'] === 1, r.log)

server.close(); rmSync(dir, { recursive: true, force: true })
const p = results.filter(Boolean).length
console.log(`\n${p}/${results.length} checks passed`)
process.exit(p === results.length ? 0 : 1)
