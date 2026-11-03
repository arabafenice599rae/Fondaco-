// Rebuilds AirSwap SwapERC20 (tag v4.3, the source AirSwap deployed as "V5.0") from the tagged source and compares it,
// byte for byte, with the fixture the project deploys, then with the code AirSwap deployed on-chain. Stops (exit 1) on any mismatch.
//
//  1. fetch airswap-protocols at the pinned commit and check HEAD (and the tag) is exactly that commit
//  2. SHA-256 of source/swap-erc20/contracts/SwapERC20.sol must match compiler-settings.json
//  3. dependencies exactly as in the tag's yarn.lock (solady 0.0.173), tarball checked against the lockfile integrity
//  4. solc 0.8.23 official static build, SHA-256 pinned here and cross-checked with binaries.soliditylang.org/list.json
//  5. compile with the repository's Hardhat settings (optimizer on, 999999 runs; Hardhat's default evmVersion for
//     0.8.23 is "paris"; source unit names as Hardhat names them, so even the metadata hash must match)
//  6. creation bytecode and ABI must equal packages/contracts/fixtures/SwapERC20.json
//  7. runtime bytecode, CBOR metadata excluded and immutables masked, must equal eth_getCode of the AirSwap deployment
//     (compiler-settings.json "deployed") on every listed chain; immutable values are decoded and DOMAIN_CHAIN_ID checked
//
// Usage: node tools/verify-source/verify-source.mjs [--solc /path/to/solc-0.8.23] [--fixture other.json]
//        [--evm-version X]  override, for the negative test only: anything but 'paris' must FAIL
//        [--write-fixture]  (re)write the fixture from this build, after steps 1–5 passed
//        [--skip-deployed]  skip step 7 (only for the negative tests, which fail before it)
// Needs: git, tar, network access to github.com, registry.npmjs.org, binaries.soliditylang.org (or --solc), and public
// JSON-RPC endpoints for step 7 (MAINNET_RPC_URL, BASE_RPC_URL from .env; defaults in compiler-settings.json).
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from 'node:fs'
import { dirname, resolve, posix } from 'node:path'
import { fileURLToPath } from 'node:url'
import { isDeepStrictEqual } from 'node:util'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const CACHE = resolve(ROOT, '.cache/verify-source')

// Single source of truth for the official build settings (also read by the deploy script).
const OFFICIAL = JSON.parse(readFileSync(resolve(ROOT, 'packages/contracts/compiler-settings.json'), 'utf8'))
export const EXPECTED = {
  ...OFFICIAL.source,
  solc: OFFICIAL.solc,
  settings: OFFICIAL.settings,
  fixture: `packages/contracts/${OFFICIAL.fixtures.SwapERC20.file}`,
  fixtureSha256: OFFICIAL.fixtures.SwapERC20.creationBytecodeSha256,
}

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex')
const log = (...a) => console.log(...a)
const fail = (msg) => { console.error(`\nFAIL: ${msg}`); process.exit(1) }
const sh = (cmd, args, opts = {}) => execFileSync(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], ...opts }).toString().trim()

async function download(url) {
  const r = await fetch(url)
  if (!r.ok) throw new Error(`GET ${url} → ${r.status}`)
  return Buffer.from(await r.arrayBuffer())
}

// ---------------------------------------------------------------- 1. source at the exact commit
function fetchSource() {
  const dir = resolve(CACHE, `airswap-${EXPECTED.commit.slice(0, 12)}`)
  if (!existsSync(resolve(dir, '.git'))) {
    mkdirSync(dir, { recursive: true })
    sh('git', ['init', '-q'], { cwd: dir })
    sh('git', ['remote', 'add', 'origin', EXPECTED.repo], { cwd: dir })
  }
  sh('git', ['fetch', '-q', '--depth', '1', 'origin', EXPECTED.commit], { cwd: dir })
  sh('git', ['checkout', '-q', '--force', 'FETCH_HEAD'], { cwd: dir })
  const head = sh('git', ['rev-parse', 'HEAD'], { cwd: dir })
  if (head !== EXPECTED.commit) fail(`checked out ${head}, expected ${EXPECTED.commit}`)
  // the tag must point at the same commit (annotated or lightweight)
  let tagCommit = null
  try {
    const lines = sh('git', ['ls-remote', '--tags', EXPECTED.repo, `refs/tags/${EXPECTED.tag}`, `refs/tags/${EXPECTED.tag}^{}`]).split('\n')
    const peeled = lines.find((l) => l.endsWith('^{}')) || lines[0]
    tagCommit = peeled ? peeled.split(/\s+/)[0] : null
  } catch { /* offline ls-remote: reported below */ }
  return { dir, head, tagCommit }
}

// ---------------------------------------------------------------- 3. dependencies from the tag's yarn.lock
function lockEntry(lock, name, version) {
  const re = new RegExp(`^"?${name.replace(/[/@.]/g, (c) => '\\' + c)}@[^\\n]*:\\n  version "${version.replace(/\./g, '\\.')}"\\n  resolved "([^"]+)"\\n  integrity (\\S+)`, 'm')
  const m = lock.match(re)
  if (!m) fail(`${name}@${version} not found in yarn.lock`)
  return { resolved: m[1], integrity: m[2] }
}

async function fetchNpmPackage(lock, name, version) {
  const { integrity } = lockEntry(lock, name, version)
  const dir = resolve(CACHE, `${name.replace('/', '__')}-${version}`)
  const tgz = `${dir}.tgz`
  if (!existsSync(tgz)) {
    const bare = name.split('/').pop()
    writeFileSync(tgz, await download(`https://registry.npmjs.org/${name}/-/${bare}-${version}.tgz`))
  }
  const [algo, b64] = integrity.split('-')
  const got = createHash(algo).update(readFileSync(tgz)).digest('base64')
  if (got !== b64) fail(`${name}@${version} tarball integrity ${algo}-${got} ≠ yarn.lock ${integrity}`)
  if (!existsSync(dir)) { mkdirSync(dir, { recursive: true }); sh('tar', ['xzf', tgz, '-C', dir, '--strip-components', '1']) }
  return { dir, integrity }
}

// ---------------------------------------------------------------- 4. compiler
async function getSolc(override) {
  if (override) {
    const s = sha256(readFileSync(override))
    if (s !== EXPECTED.solc.sha256) fail(`solc at ${override} has SHA-256 ${s}, expected ${EXPECTED.solc.sha256}`)
    return { path: override, sha256: s, listMatches: null }
  }
  const path = resolve(CACHE, EXPECTED.solc.build)
  if (!existsSync(path)) writeFileSync(path, await download(`https://binaries.soliditylang.org/linux-amd64/${EXPECTED.solc.build}`))
  chmodSync(path, 0o755)
  const s = sha256(readFileSync(path))
  if (s !== EXPECTED.solc.sha256) fail(`downloaded solc SHA-256 ${s} ≠ pinned ${EXPECTED.solc.sha256}`)
  let listMatches = null
  try {
    const list = JSON.parse(await download('https://binaries.soliditylang.org/linux-amd64/list.json'))
    const b = list.builds.find((x) => x.path === EXPECTED.solc.build)
    listMatches = b ? b.sha256 === `0x${s}` : false
    if (listMatches === false) fail('solc SHA-256 does not match binaries.soliditylang.org/list.json')
  } catch (e) { if (e?.message?.startsWith('GET')) listMatches = null; else throw e }
  return { path, sha256: s, listMatches }
}

// ---------------------------------------------------------------- 5. compile (Hardhat-equivalent standard JSON)
/** Collect the transitive import closure with Hardhat's source unit names ("contracts/…", "solady/src/…"). */
function collectSources(projectDir, nodeModules, entryUnit) {
  const sources = {}
  const read = (unit) => {
    const p = unit.startsWith('contracts/') ? resolve(projectDir, unit) : resolve(nodeModules[unit.split('/')[0]], unit.split('/').slice(1).join('/'))
    return readFileSync(p, 'utf8')
  }
  const visit = (unit) => {
    if (sources[unit]) return
    const content = read(unit)
    sources[unit] = { content }
    for (const m of content.matchAll(/^\s*import\s+(?:[^'"]*from\s+)?["']([^"']+)["']\s*;/gm)) {
      const spec = m[1]
      visit(spec.startsWith('.') ? posix.normalize(posix.join(posix.dirname(unit), spec)) : spec)
    }
  }
  visit(entryUnit)
  return sources
}

function compile(solcPath, sources, settings) {
  const input = {
    language: 'Solidity',
    sources,
    settings: { ...settings, outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object', 'evm.deployedBytecode.object', 'evm.deployedBytecode.immutableReferences', 'metadata'] } } },
  }
  const out = JSON.parse(execFileSync(solcPath, ['--standard-json'], { input: JSON.stringify(input), maxBuffer: 64 << 20 }).toString())
  const errors = (out.errors || []).filter((e) => e.severity === 'error')
  if (errors.length) fail(`solc errors:\n${errors.map((e) => e.formattedMessage).join('\n')}`)
  return out.contracts['contracts/SwapERC20.sol'].SwapERC20
}

function firstDiff(a, b) {
  const n = Math.min(a.length, b.length)
  for (let i = 0; i < n; i++) if (a[i] !== b[i]) return i
  return a.length === b.length ? -1 : n
}

// ---------------------------------------------------------------- 7. deployed code
/** Runtime code without the trailing CBOR metadata (its length is the last 2 bytes) and with immutable ranges zeroed. */
export function normalizeRuntime(hex, immutableRefs) {
  const b = Buffer.from(hex.replace(/^0x/, ''), 'hex')
  const metaLen = b.readUInt16BE(b.length - 2) + 2
  const body = Buffer.from(b.subarray(0, b.length - metaLen))
  for (const refs of Object.values(immutableRefs)) for (const { start, length } of refs) body.fill(0, start, start + length)
  return { body, metadata: b.subarray(b.length - metaLen).toString('hex') }
}
async function rpc(url, method, params) {
  const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) })
  const j = await r.json()
  if (j.error) throw new Error(`${method}: ${j.error.message}`)
  return j.result
}
function envFile() {
  try { return Object.fromEntries(readFileSync(resolve(ROOT, '.env'), 'utf8').split('\n').map((l) => l.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/)).filter(Boolean).map((m) => [m[1], m[2]])) } catch { return {} }
}

// ---------------------------------------------------------------- main
async function main() {
  const argv = process.argv.slice(2)
  const solcOverride = argv.includes('--solc') ? argv[argv.indexOf('--solc') + 1] : process.env.SOLC_0_8_23
  mkdirSync(CACHE, { recursive: true })
  const report = { expected: EXPECTED, steps: {} }

  log(`1) airswap-protocols @ ${EXPECTED.commit}`)
  const src = fetchSource()
  report.steps.source = { head: src.head, tag: EXPECTED.tag, tagCommit: src.tagCommit }
  if (src.tagCommit && src.tagCommit !== EXPECTED.commit) fail(`tag ${EXPECTED.tag} points to ${src.tagCommit}, not ${EXPECTED.commit}`)
  log(`   HEAD ${src.head}${src.tagCommit ? ` (tag ${EXPECTED.tag} → ${src.tagCommit})` : ' (tag not checked: ls-remote unavailable)'}`)

  log(`2) SHA-256 ${EXPECTED.file}`)
  const fileSha = sha256(readFileSync(resolve(src.dir, EXPECTED.file)))
  report.steps.fileSha256 = fileSha
  if (fileSha !== EXPECTED.fileSha256) fail(`SHA-256 ${fileSha} ≠ ${EXPECTED.fileSha256}`)
  log(`   ${fileSha} OK`)

  log('3) dependencies from the tag\'s yarn.lock')
  const lock = readFileSync(resolve(src.dir, 'yarn.lock'), 'utf8')
  const pkg = JSON.parse(readFileSync(resolve(src.dir, 'source/swap-erc20/package.json'), 'utf8'))
  const soladyVersion = pkg.devDependencies.solady
  const solady = await fetchNpmPackage(lock, 'solady', soladyVersion)
  report.steps.solady = { version: soladyVersion, integrity: solady.integrity }
  log(`   solady ${soladyVersion} ${solady.integrity.slice(0, 30)}… OK`)

  log(`4) solc ${EXPECTED.solc.version}`)
  const solc = await getSolc(solcOverride)
  const version = sh(solc.path, ['--version'])
  if (!version.includes(`Version: ${EXPECTED.solc.version}+commit.f704f362`)) fail(`unexpected compiler: ${version}`)
  report.steps.solc = { sha256: solc.sha256, matchesOfficialList: solc.listMatches }
  log(`   ${solc.sha256} OK${solc.listMatches ? ' (matches binaries.soliditylang.org list.json)' : ''}`)

  const evmOverride = argv.includes('--evm-version') ? argv[argv.indexOf('--evm-version') + 1] : null
  const settings = evmOverride ? { ...EXPECTED.settings, evmVersion: evmOverride } : EXPECTED.settings
  if (evmOverride) log(`   NOTE: evmVersion overridden to '${evmOverride}' (negative test)`)
  log(`5) compile: optimizer ${settings.optimizer.runs} runs, evmVersion ${settings.evmVersion}`)
  const sources = collectSources(resolve(src.dir, 'source/swap-erc20'), { solady: solady.dir }, 'contracts/SwapERC20.sol')
  report.steps.sources = Object.fromEntries(Object.entries(sources).map(([k, v]) => [k, sha256(v.content)]))
  for (const [k, v] of Object.entries(report.steps.sources)) log(`   ${v.slice(0, 16)}…  ${k}`)
  const built = compile(solc.path, sources, settings)

  if (argv.includes('--write-fixture')) {
    const out = { contractName: 'SwapERC20', source: `airswap-protocols tag ${EXPECTED.tag} (${EXPECTED.commit.slice(0, 7)}), solc ${EXPECTED.solc.version}, optimizer ${settings.optimizer.runs} runs, evmVersion ${settings.evmVersion}`, abi: built.abi, bytecode: `0x${built.evm.bytecode.object}` }
    writeFileSync(resolve(ROOT, EXPECTED.fixture), JSON.stringify(out))
    const b = Buffer.from(built.evm.bytecode.object, 'hex')
    log(`   fixture written: ${b.length} bytes, sha256 ${sha256(b)} — update compiler-settings.json accordingly`)
  }
  log(`6) compare with ${EXPECTED.fixture}`)
  const fixturePath = argv.includes('--fixture') ? resolve(argv[argv.indexOf('--fixture') + 1]) : resolve(ROOT, EXPECTED.fixture)
  const fixture = JSON.parse(readFileSync(fixturePath, 'utf8'))
  const ours = `0x${built.evm.bytecode.object}`
  const same = ours.toLowerCase() === fixture.bytecode.toLowerCase()
  const abiSame = isDeepStrictEqual(built.abi, fixture.abi)
  report.result = { bytecodeIdentical: same, abiIdentical: abiSame, bytes: (ours.length - 2) / 2, bytecodeSha256: sha256(Buffer.from(ours.slice(2), 'hex')), metadataHash: JSON.parse(built.metadata).sources['contracts/SwapERC20.sol'].keccak256 }
  mkdirSync(resolve(ROOT, 'reports'), { recursive: true })
  if (!evmOverride && !argv.includes('--fixture')) writeFileSync(resolve(ROOT, 'reports/verify-source.json'), JSON.stringify(report, null, 2))
  if (!same) {
    const i = firstDiff(ours.toLowerCase(), fixture.bytecode.toLowerCase())
    fail(`creation bytecode differs (ours ${(ours.length - 2) / 2} bytes, fixture ${(fixture.bytecode.length - 2) / 2} bytes, first difference at hex char ${i})`)
  }
  if (!abiSame) fail('ABI differs from the fixture')
  if (!evmOverride && report.result.bytecodeSha256 !== EXPECTED.fixtureSha256) fail(`bytecode SHA-256 ${report.result.bytecodeSha256} ≠ compiler-settings.json ${EXPECTED.fixtureSha256}`)
  log(`   creation bytecode IDENTICAL (${report.result.bytes} bytes, sha256 ${report.result.bytecodeSha256}), ABI identical`)

  if (!argv.includes('--skip-deployed') && !evmOverride && !argv.includes('--fixture')) {
    const dep = OFFICIAL.deployed
    log(`7) compare runtime with the AirSwap deployment ${dep.address}`)
    const env = { ...envFile(), ...process.env }
    const refs = built.evm.deployedBytecode.immutableReferences
    const ownRuntime = `0x${built.evm.deployedBytecode.object}`
    const mine = normalizeRuntime(ownRuntime, refs)
    report.steps.deployed = { address: dep.address, runtimeBytes: (ownRuntime.length - 2) / 2, ownMetadata: mine.metadata, chains: {} }
    for (const [chainId, c] of Object.entries(dep.chains)) {
      const url = env[c.rpcEnv] || c.defaultRpc
      const host = new URL(url).host
      const [code, cid] = await Promise.all([rpc(url, 'eth_getCode', [dep.address, 'latest']), rpc(url, 'eth_chainId', [])])
      if (Number(cid) !== Number(chainId)) fail(`${c.name}: RPC ${host} is chain ${Number(cid)}, expected ${chainId}`)
      const theirs = normalizeRuntime(code, refs)
      const same = Buffer.compare(mine.body, theirs.body) === 0
      // immutables: decode each range from the on-chain code (all are 32-byte words)
      const raw = Buffer.from(code.slice(2), 'hex')
      const imm = Object.fromEntries(Object.entries(refs).map(([id, rs]) => [id, rs.map((x) => raw.subarray(x.start, x.start + x.length).toString('hex'))]))
      const consistent = Object.values(imm).every((vals) => vals.every((v) => v === vals[0]))
      const values = Object.values(imm).map((vals) => vals[0])
      const hasChainId = values.some((v) => BigInt('0x' + v) === BigInt(chainId))
      const entry = { rpcHost: host, runtimeBytes: raw.length, runtimeEqualExcludingMetadata: same, metadataEqual: theirs.metadata === mine.metadata, immutables: values, immutablesConsistent: consistent, domainChainIdMatches: hasChainId, codeSha256: sha256(raw) }
      report.steps.deployed.chains[chainId] = entry
      if (!same) fail(`${c.name}: runtime bytecode (metadata excluded, immutables masked) differs from eth_getCode at ${dep.address} (first difference at byte ${firstDiff(mine.body.toString('hex'), theirs.body.toString('hex')) / 2})`)
      if (!consistent || !hasChainId) fail(`${c.name}: immutables inconsistent or no immutable equals the chain id`)
      log(`   ${c.name} (${chainId}, via ${host}): ${raw.length} bytes, runtime IDENTICAL excluding metadata; metadata ${entry.metadataEqual ? 'identical too' : 'differs'}; DOMAIN_CHAIN_ID = ${chainId}`)
    }
    if (!argv.includes('--write-fixture')) writeFileSync(resolve(ROOT, 'reports/verify-source.json'), JSON.stringify(report, null, 2))
  }
  log('\nverify-source: OK')
}

main().catch((e) => fail(e.stack || e.message))
