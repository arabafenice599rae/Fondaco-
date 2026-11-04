// Fails if a build contains anything that looks like an API key or a key-bearing RPC URL.
//   node scripts/scan-keys.mjs [dir ...]   scan the given build directories
//   node scripts/scan-keys.mjs             build production and demo into temp dirs, scan both (and self-test the scanner)
// Patterns (case-insensitive): alchemy, infura, sk_, apiKey=  — plus common key-in-URL shapes (/v2/<32+ chars>, ?key=…).
import { execFileSync } from 'node:child_process'
import { readdirSync, readFileSync, statSync, mkdtempSync, writeFileSync, cpSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const APP = resolve(fileURLToPath(new URL('.', import.meta.url)), '..')
export const PATTERNS = [
  ['alchemy', /alchemy/i],
  ['infura', /infura/i],
  ['sk_', /sk_[A-Za-z0-9]/],
  ['apiKey=', /api[_-]?key\s*[=:]\s*["']?[A-Za-z0-9_-]{8,}/i],
  ['key in RPC URL path', /https?:\/\/[^"'\s]+\/v[23]\/[A-Za-z0-9_-]{24,}/],
  ['key query parameter', /[?&](?:api[_-]?key|key|token)=[A-Za-z0-9_-]{16,}/i],
]
const files = (dir) => readdirSync(dir).flatMap((f) => { const p = join(dir, f); return statSync(p).isDirectory() ? files(p) : [p] })
export function scan(dir) {
  const hits = []
  for (const f of files(dir)) {
    if (/\.(woff2?|png|ico|jpg)$/.test(f)) continue
    const text = readFileSync(f, 'utf8')
    for (const [name, re] of PATTERNS) {
      const m = re.exec(text)
      if (m) hits.push(`${f.slice(dir.length + 1)}: ${name} → …${text.slice(Math.max(0, m.index - 30), m.index + 40).replace(/\s+/g, ' ')}…`)
    }
  }
  return hits
}

const results = []
const check = (n, ok, d = '') => { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'} | ${n}${d ? ' | ' + d : ''}`) }
const vite = resolve(APP, 'node_modules/vite/bin/vite.js')
const buildTo = (demo) => {
  const out = mkdtempSync(join(tmpdir(), demo ? 'fondaco-demo-' : 'fondaco-prod-'))
  execFileSync(process.execPath, [vite, 'build', '--outDir', out, '--emptyOutDir', '--logLevel', 'error'], { cwd: APP, env: { ...process.env, DEMO: demo ? 'true' : '' }, stdio: 'inherit' })
  return out
}

const dirs = process.argv.slice(2)
if (dirs.length) {
  for (const d of dirs) { const h = scan(resolve(d)); check(`K: no key-like strings in ${d}`, h.length === 0, h.slice(0, 5).join(' | ')) }
} else {
  const prod = buildTo(false), demo = buildTo(true)
  const hp = scan(prod), hd = scan(demo)
  check('K1: production build has no key-like strings (alchemy, infura, sk_, apiKey=, key-bearing RPC URLs)', hp.length === 0, hp.slice(0, 5).join(' | ') || `${files(prod).length} files`)
  check('K2: demo build has none either', hd.length === 0, hd.slice(0, 5).join(' | ') || `${files(demo).length} files`)
  // self-test: the scanner must catch each pattern when one is planted
  const planted = mkdtempSync(join(tmpdir(), 'fondaco-planted-'))
  cpSync(prod, planted, { recursive: true })
  const samples = ['https://eth-mainnet.g.alchemy.com/v2/abc', 'https://mainnet.infura.io/v3/x', 'const k="sk_live_123"', 'apiKey="0123456789abcdef"',
    'https://rpc.example.com/v2/AbCdEfGhIjKlMnOpQrStUvWxYz012345', 'https://rpc.example.com/?key=AbCdEfGhIjKlMnOp12']
  const caught = samples.map((s, i) => { writeFileSync(join(planted, 'assets', `planted-${i}.js`), `/*x*/${s}`); const h = scan(planted).filter((x) => x.includes(`planted-${i}.js`)); return h.length > 0 })
  check('K3: self-test — each planted pattern is detected', caught.every(Boolean), caught.map((c, i) => `${i}:${c ? 'ok' : 'MISSED'}`).join(' '))
  const allText = (d) => files(d).filter((f) => f.endsWith('.js')).map((f) => readFileSync(f, 'utf8')).join('\n')
  const pj = allText(prod), dj = allText(demo)
  check('K4: the simulated data source exists only in the DEMO=true build', !pj.includes('Wallet demo') && !pj.includes('app.fondaco.demo') && dj.includes('Wallet demo'), 'production bundle has no demo backend')
  const maps = files(prod).filter((f) => f.endsWith('.map')), refs = files(prod).filter((f) => /\.(js|css)$/.test(f) && /sourceMappingURL/.test(readFileSync(f, 'utf8')))
  check('K6: no source maps in the production build (no .map file, no sourceMappingURL)', maps.length === 0 && refs.length === 0, [...maps, ...refs].slice(0, 3).join(', ') || `${files(prod).length} files`)
  const cfg = readFileSync(join(prod, 'config.json'), 'utf8')
  check('K5: shipped config.json has no RPC with a key (empty or public RPCs only)', scan(prod).every((h) => !h.startsWith('config.json')) && JSON.parse(cfg).chains['1'].rpc === '', 'rpc ""')
}
const passed = results.filter(Boolean).length
console.log(`\n${passed}/${results.length} checks passed`)
process.exit(passed === results.length ? 0 : 1)
