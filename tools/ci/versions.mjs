// Prints the version of every CI tool and fails if one differs from tools/ci/toolchain.json (or .nvmrc / package.json).
//   node tools/ci/versions.mjs [--need foundry,solc,playwright,docker,kubo,gitleaks]   (node, pnpm, lighthouse, axe always)
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, appendFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

const ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)), '../..')
const T = JSON.parse(readFileSync(resolve(ROOT, 'tools/ci/toolchain.json'), 'utf8'))
const web = JSON.parse(readFileSync(resolve(ROOT, 'apps/web/package.json'), 'utf8')).devDependencies
const need = new Set((process.argv[process.argv.indexOf('--need') + 1] ?? '').split(',').filter((x) => process.argv.includes('--need') && x))
const sh = (cmd, args) => { try { return execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim() } catch (e) { return `ERROR ${e.message.split('\n')[0]}` } }
const req = createRequire(resolve(ROOT, 'apps/web/package.json'))
const pkgVer = (name) => { try { return JSON.parse(readFileSync(req.resolve(`${name}/package.json`), 'utf8')).version } catch { return 'not installed' } }
const rows = []
const row = (tool, want, got, ok = got.includes(want)) => rows.push({ tool, want, got: got.split('\n')[0], ok })
row('node', readFileSync(resolve(ROOT, '.nvmrc'), 'utf8').trim(), process.version.slice(1))
row('pnpm', JSON.parse(readFileSync(resolve(ROOT, 'package.json'), 'utf8')).packageManager.split('@')[1], sh('pnpm', ['--version']))
row('lighthouse', web.lighthouse, pkgVer('lighthouse'))
row('axe-core', web['axe-core'], pkgVer('axe-core'))
if (need.has('playwright')) {
  row('playwright', web.playwright, pkgVer('playwright'))
  const exe = (() => { try { return req('playwright').chromium.executablePath() } catch { return '' } })()
  row('chromium (playwright)', 'present', exe && existsSync(exe) ? `present ${exe}` : 'missing')
}
if (need.has('foundry')) {
  row('forge', T.foundry.commit, sh('forge', ['--version']).replace(/\n/g, ' '))
  row('anvil', T.foundry.version.slice(1), sh('anvil', ['--version']))
}
if (need.has('solc')) {
  const f = resolve(ROOT, '.cache/verify-source', T.solc.build)
  row('solc', T.solc.sha256, existsSync(f) ? createHash('sha256').update(readFileSync(f)).digest('hex') : 'missing')
}
if (need.has('docker')) row('docker buildx', 'buildx', sh('docker', ['buildx', 'version']))
if (need.has('kubo')) row('kubo (ipfs)', T.kubo.version, sh(process.env.IPFS_BIN || 'ipfs', ['version']))
if (need.has('gitleaks')) row('gitleaks', T.gitleaks.version, sh('gitleaks', ['version']))
for (const r of rows) console.log(`${r.ok ? 'PASS' : 'FAIL'} | ${r.tool.padEnd(22)} want ${r.want} | got ${r.got}`)
if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, ['### Toolchain', '', '| Tool | Expected | Installed | |', '|---|---|---|---|', ...rows.map((r) => `| ${r.tool} | ${r.want} | ${r.got.slice(0, 80)} | ${r.ok ? '✅' : '❌'} |`), ''].join('\n') + '\n')
const bad = rows.filter((r) => !r.ok)
console.log(`\n${rows.length - bad.length}/${rows.length} checks passed`)
process.exit(bad.length ? 1 : 0)
