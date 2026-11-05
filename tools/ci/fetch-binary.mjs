// Fetches a pinned CI binary (tools/ci/toolchain.json → <name>.file, .sources, .sha256|.sha512) into the cache directory
// the CI restores with actions/cache, under the key printed by --keys (name + version + checksum). The checksum is the only
// authority: a cached file, the primary source and the fallback must all give that hash.
//   node tools/ci/fetch-binary.mjs <name>          cached file with the right hash → used, no download; otherwise the
//                                                  sources in order, ATTEMPTS tries each (backoff), until one downloads
//   node tools/ci/fetch-binary.mjs --keys          name=bin-<name>-<version>-<checksum>, one per binary (GITHUB_OUTPUT)
//   node tools/ci/fetch-binary.mjs --check-sources every source of every binary, independently: all must give the hash
// Prints the path of the verified file on the last stdout line. A source is a URL, or { github: "owner/repo", tag } (the
// same release asset through api.github.com, GITHUB_TOKEN if set).
// A source that answers with other bytes is fatal: no other source is tried, nothing is kept.
// Env: FETCH_CONFIG (default tools/ci/toolchain.json), FETCH_CACHE (default .cache/bin), FETCH_ATTEMPTS (3),
//      FETCH_BACKOFF_MS (2000, doubled each try).
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, mkdtempSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)), '../..')
const CONFIG = resolve(ROOT, process.env.FETCH_CONFIG ?? 'tools/ci/toolchain.json')
const CACHE = resolve(ROOT, process.env.FETCH_CACHE ?? '.cache/bin')
const ATTEMPTS = Number(process.env.FETCH_ATTEMPTS ?? 3)
const BACKOFF = Number(process.env.FETCH_BACKOFF_MS ?? 2000)
const T = JSON.parse(readFileSync(CONFIG, 'utf8'))
const BINS = Object.keys(T).filter((k) => T[k]?.sources)
const log = (m) => process.stderr.write(m + '\n')
const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)

function want(name) {
  const e = T[name]
  if (!e?.sources?.length || !e.file) throw new Error(`${name}: no file/sources in ${CONFIG}`)
  const algo = e.sha512 ? 'sha512' : e.sha256 ? 'sha256' : null
  if (!algo) throw new Error(`${name}: no sha256/sha512 in ${CONFIG}`)
  return { e, algo, hash: e[algo] }
}
const digest = (algo, f) => createHash(algo).update(readFileSync(f)).digest('hex')
export const cacheKey = (name) => { const { e, hash } = want(name); return `bin-${name}-${e.version}-${hash}` }
const label = (s) => typeof s === 'string' ? s : `api.github.com ${s.github}@${s.tag}`

function curl(args) { execFileSync('curl', ['-fsSL', '--connect-timeout', '20', '--max-time', '900', ...args], { stdio: ['ignore', 'ignore', 'pipe'] }) }
function download(src, file, out) {
  if (typeof src === 'string') return curl(['-o', out, src])
  const auth = process.env.GITHUB_TOKEN ? ['-H', `Authorization: Bearer ${process.env.GITHUB_TOKEN}`] : []
  const rel = JSON.parse(execFileSync('curl', ['-fsSL', '--connect-timeout', '20', ...auth, `https://api.github.com/repos/${src.github}/releases/tags/${src.tag}`], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }))
  const asset = rel.assets?.find((a) => a.name === file)
  if (!asset) throw new Error(`asset ${file} not in ${src.github}@${src.tag}`)
  curl([...auth, '-H', 'Accept: application/octet-stream', '-o', out, asset.url])
}

/** One source, ATTEMPTS tries. Returns the verified temp file, or null when every try failed to download. Throws on a hash mismatch. */
function fromSource(name, src, dir) {
  const { e, algo, hash } = want(name)
  const out = join(dir, e.file)
  for (let i = 1; i <= ATTEMPTS; i++) {
    try { download(src, e.file, out) } catch (err) {
      log(`${name}: ${label(src)} try ${i}/${ATTEMPTS} failed: ${String(err.stderr || err.message).trim().split('\n').pop()}`)
      if (i < ATTEMPTS) sleep(BACKOFF * 2 ** (i - 1))
      continue
    }
    const got = digest(algo, out)
    if (got !== hash) { rmSync(out, { force: true }); throw new Error(`${name}: ${label(src)} gave ${algo} ${got}, toolchain.json wants ${hash}; nothing kept, no other source tried`) }
    return out
  }
  return null
}

export function fetchBinary(name) {
  const { e, algo, hash } = want(name)
  const dir = join(CACHE, name), dest = join(dir, e.file)
  if (existsSync(dest)) {
    if (digest(algo, dest) === hash) { log(`${name}: cache hit (${algo} verified), no download`); return dest }
    log(`${name}: cached file has another ${algo}, discarded`); rmSync(dest, { force: true })
  }
  mkdirSync(dir, { recursive: true })
  const tmp = mkdtempSync(join(dir, '.tmp-'))
  try {
    for (const [i, src] of e.sources.entries()) {
      if (i > 0) log(`${name}: primary source unavailable after ${ATTEMPTS} tries, using fallback ${i}: ${label(src)}`)
      const got = fromSource(name, src, tmp)
      if (got) { renameSync(got, dest); log(`${name}: ${i === 0 ? 'primary' : `fallback ${i}`} ${label(src)}, ${algo} verified`); return dest }
    }
    throw new Error(`${name}: no source could be downloaded (${e.sources.map(label).join(', ')})`)
  } finally { rmSync(tmp, { recursive: true, force: true }) }
}

function checkSources() {
  let bad = 0
  for (const name of BINS) for (const [i, src] of T[name].sources.entries()) {
    const tmp = mkdtempSync(join(tmpdir(), 'fetch-check-'))
    try { const ok = fromSource(name, src, tmp); if (!ok) bad++; console.log(`${ok ? 'PASS' : 'FAIL'} | ${name} ${i === 0 ? 'primary' : `fallback ${i}`} | ${label(src)}${ok ? ' | hash verified' : ' | not downloadable'}`) }
    catch (err) { bad++; console.log(`FAIL | ${name} ${i === 0 ? 'primary' : `fallback ${i}`} | ${err.message}`) }
    finally { rmSync(tmp, { recursive: true, force: true }) }
  }
  process.exit(bad ? 1 : 0)
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const arg = process.argv[2]
  try {
    if (arg === '--keys') for (const n of BINS) console.log(`${n}=${cacheKey(n)}`)
    else if (arg === '--check-sources') checkSources()
    else if (arg && BINS.includes(arg)) console.log(fetchBinary(arg))
    else { log(`usage: fetch-binary.mjs <${BINS.join('|')}> | --keys | --check-sources`); process.exit(2) }
  } catch (err) { log(`FAIL ${err.message}`); process.exit(1) }
}
