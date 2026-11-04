// Reproducible build of the web app: one hash for the whole static tree.
//   node tools/build-hash.mjs              build apps/web (production) into a temp dir, print the tree hash
//   node tools/build-hash.mjs <dir>        hash an existing build
//   node tools/build-hash.mjs --twice      build twice in different directories and compare (exit 1 if they differ)
// Tree hash = sha256 of "<sha256>  <path>\n" lines, sorted by path (the same lines are written to reports/build-manifest.txt,
// which tools/verify-served.mjs compares with what a host or an IPFS gateway serves).
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)), '..')
const APP = resolve(ROOT, 'apps/web')
const walk = (d) => readdirSync(d).flatMap((f) => { const p = join(d, f); return statSync(p).isDirectory() ? walk(p) : [p] })
export function manifest(dir) {
  const lines = walk(dir).map((f) => `${createHash('sha256').update(readFileSync(f)).digest('hex')}  ${relative(dir, f).split('\\').join('/')}`).sort((a, b) => a.slice(66).localeCompare(b.slice(66)))
  const text = lines.join('\n') + '\n'
  return { text, files: lines.length, hash: createHash('sha256').update(text).digest('hex') }
}
export function build() {
  const out = mkdtempSync(join(tmpdir(), 'fondaco-repro-'))
  execFileSync(process.execPath, [resolve(APP, 'node_modules/vite/bin/vite.js'), 'build', '--outDir', out, '--emptyOutDir', '--logLevel', 'error'], { cwd: APP, env: { ...process.env, DEMO: '' }, stdio: 'inherit' })
  return out
}
const arg = process.argv[2]
mkdirSync(resolve(ROOT, 'reports'), { recursive: true })
if (arg === '--twice') {
  const a = manifest(build()), b = manifest(build())
  writeFileSync(resolve(ROOT, 'reports/build-manifest.txt'), a.text)
  const ok = a.hash === b.hash
  console.log(`${ok ? 'PASS' : 'FAIL'} | reproducible build: two builds in different directories give the same tree hash | ${a.hash} (${a.files} files)${ok ? '' : ' vs ' + b.hash}`)
  console.log(`\n${ok ? 1 : 0}/1 checks passed`)
  process.exit(ok ? 0 : 1)
}
const dir = arg ? resolve(arg) : build()
const m = manifest(dir)
writeFileSync(resolve(ROOT, 'reports/build-manifest.txt'), m.text)
console.log(m.hash)
