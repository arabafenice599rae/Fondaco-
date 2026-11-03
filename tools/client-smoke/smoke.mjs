// Packs @fondaco/client, installs the tarball with npm in a fresh project OUTSIDE the workspace, then:
//   C1 the published package depends on viem only and ships only dist/ (+ package.json)
//   C2 npm resolves no dependency other than viem's own tree
//   C3 every entry point (., ./taker, ./protect, ./wallet-protection) imports and works from plain ESM
//   C4 strict TypeScript (NodeNext) type-checks a consumer using the exported types and unions exhaustively
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync, copyFileSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url)), ROOT = resolve(HERE, '../..')
const results = []
const check = (n, ok, d = '') => { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'} | ${n}${d ? ' | ' + d : ''}`) }
const run = (cmd, args, cwd) => execFileSync(cmd, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })

const dir = mkdtempSync(join(tmpdir(), 'fondaco-client-smoke-'))
run('pnpm', ['--filter', '@fondaco/client', 'pack', '--pack-destination', dir], ROOT)
const tgz = readdirSync(dir).find((f) => f.endsWith('.tgz'))
const files = run('tar', ['tzf', join(dir, tgz)], dir).trim().split('\n')
const pkg = JSON.parse(run('tar', ['xzf', join(dir, tgz), '-O', 'package/package.json'], dir))
const extra = files.filter((f) => !f.startsWith('package/dist/') && f !== 'package/package.json' && f !== 'package/README.md')
check('C1: published package — dependencies = { viem } only, no dev/peer leftovers, only dist/ + package.json (+ README)',
  JSON.stringify(Object.keys(pkg.dependencies || {})) === '["viem"]' && !pkg.peerDependencies && extra.length === 0 && files.some((f) => f === 'package/dist/index.d.ts'),
  `deps ${JSON.stringify(pkg.dependencies)}; ${files.length} files${extra.length ? '; extra: ' + extra.join(', ') : ''}`)

const app = join(dir, 'app')
run('mkdir', ['-p', app], dir)
writeFileSync(join(app, 'package.json'), JSON.stringify({ name: 'external-app', private: true, type: 'module', dependencies: { '@fondaco/client': `file:../${tgz}` } }, null, 2))
for (const f of ['consumer.mjs', 'consumer.ts']) copyFileSync(join(HERE, f), join(app, f))
run('npm', ['install', '--no-audit', '--no-fund', '--loglevel=error'], app)
const tree = JSON.parse(run('npm', ['ls', '--all', '--json'], app))
const direct = Object.keys(tree.dependencies['@fondaco/client'].dependencies || {})
check('C2: npm installs @fondaco/client with viem as its only dependency', direct.join() === 'viem', `@fondaco/client → ${direct.join(', ')} (viem ${tree.dependencies['@fondaco/client'].dependencies?.viem?.version})`)

const out = JSON.parse(run(process.execPath, ['consumer.mjs'], app))
check('C3: all entry points import and work from an external ESM project', out.plan.kind === 'indicative' && out.plan.legs === 1 && out.plan.left === '500' && out.price === 'warn' && out.stale === true &&
  out.protection === 'user_rpc' && out.wallets === 0 && out.fns === 'function,function', JSON.stringify(out))

writeFileSync(join(app, 'tsconfig.json'), JSON.stringify({ compilerOptions: { target: 'ES2022', module: 'NodeNext', moduleResolution: 'NodeNext', strict: true, exactOptionalPropertyTypes: true,
  noUncheckedIndexedAccess: true, noEmit: true, lib: ['ES2023', 'DOM'], types: [], skipLibCheck: false }, files: ['consumer.ts'] }))
let tsOut = '', tsOk = true
try { tsOut = run(process.execPath, [join(ROOT, 'node_modules/typescript/bin/tsc'), '-p', 'tsconfig.json'], app) } catch (e) { tsOk = false; tsOut = (e.stdout || '') + (e.stderr || '') }
check('C4: strict TypeScript consumer type-checks against the published declarations (exhaustive switches over Quote and TakerEvent)', tsOk, tsOk ? 'tsc: 0 errors' : tsOut.split('\n').slice(0, 5).join(' / '))

const failed = results.filter((x) => !x).length
console.log(`\n${results.length - failed}/${results.length} checks passed`)
process.exit(failed ? 1 : 0)
