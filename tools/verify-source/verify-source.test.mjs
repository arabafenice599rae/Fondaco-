// The build rule is documented by tests: the official settings reproduce the fixture, and anything else must FAIL.
//   V1 official settings (evmVersion paris) → exit 0, identical bytecode
//   V2 evmVersion shanghai (solc's own default for 0.8.23) → exit 1, bytecode differs
//   V3 fixture altered by one nibble → exit 1
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '../..')
const tool = (...args) => spawnSync(process.execPath, [join(HERE, 'verify-source.mjs'), ...args], { cwd: ROOT, encoding: 'utf8' })
const results = []
const check = (n, ok, d = '') => { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'} | ${n}${d ? ' | ' + d : ''}`) }
const last = (r) => (r.stdout + r.stderr).trim().split('\n').filter(Boolean).pop()

const settings = JSON.parse(readFileSync(join(ROOT, 'packages/contracts/compiler-settings.json'), 'utf8'))
const ok = tool()
check('V1: official settings (paris, 999999 runs) reproduce the fixture', ok.status === 0 && ok.stdout.includes('IDENTICAL') && settings.settings.evmVersion === 'paris', last(ok))

const sh = tool('--evm-version', 'shanghai')
check('V2: evmVersion shanghai → verification FAILS (bytecode differs)', sh.status === 1 && /creation bytecode differs/.test(sh.stderr), last(sh))

const fx = JSON.parse(readFileSync(join(ROOT, 'packages/contracts', settings.fixtures.SwapERC20.file), 'utf8'))
const i = 4000
fx.bytecode = fx.bytecode.slice(0, i) + (fx.bytecode[i] === '0' ? '1' : '0') + fx.bytecode.slice(i + 1)
const bad = join(mkdtempSync(join(tmpdir(), 'vs-')), 'bad.json')
writeFileSync(bad, JSON.stringify(fx))
const tam = tool('--fixture', bad)
check('V3: fixture altered by one nibble → verification FAILS', tam.status === 1 && /differs/.test(tam.stderr), last(tam))

const failed = results.filter((x) => !x).length
console.log(`\n${results.length - failed}/${results.length} checks passed`)
process.exit(failed ? 1 : 0)
