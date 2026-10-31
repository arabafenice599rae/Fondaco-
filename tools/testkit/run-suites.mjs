// Runs every fork suite against its OWN fresh anvil fork (same fixed block), so suites cannot leak state into each
// other (automine toggles, time travel, snapshots). Prints and stores the per-suite counts.
//   node tools/testkit/run-suites.mjs [suite ...]
import { spawn } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { startFork, foundryBin } from './anvil.js'
import { ROOT, loadEnv } from './env.js'

export const SUITES = [
  { name: 'wallet', pkg: 'packages/client', file: 'test/wallet.test.js', unit: true },
  { name: 'client-guards', pkg: 'packages/client', file: 'test/guards.test.js', unit: true },
  { name: 'client-smoke', pkg: 'tools/client-smoke', file: 'smoke.mjs', unit: true },
  { name: 'verify-source', pkg: 'tools/verify-source', file: 'verify-source.test.mjs', unit: true },
  { name: 'config', pkg: 'packages/book-server', file: 'test/config.test.js', unit: true },
  { name: 'allocation', pkg: 'packages/book-server', file: 'test/allocation.test.js', unit: true },
  { name: 'migrations', pkg: 'packages/book-server', file: 'test/migrations.test.js', unit: true },
  { name: 'observability', pkg: 'packages/book-server', file: 'test/observability.test.js', unit: true },
  { name: 'testkit', pkg: 'tools/testkit', file: 'testkit.test.js' },
  { name: 'fee', pkg: 'packages/contracts', file: 'test/fee-side.test.js' },
  { name: 'foundry', pkg: 'packages/contracts', forge: true },
  { name: 'addresses', pkg: 'packages/contracts', file: 'test/addresses.test.js' },
  { name: 'deploy', pkg: 'packages/contracts', file: 'test/deploy.test.js' },
  { name: 'e2e', pkg: 'packages/book-server', file: 'test/e2e.js' },
  { name: 'engine', pkg: 'packages/book-server', file: 'test/engine.test.js' },
  { name: 'signers', pkg: 'packages/book-server', file: 'test/signers.test.js' },
  { name: 'metrics', pkg: 'packages/book-server', file: 'test/metrics.test.js' },
  { name: 'faults', pkg: 'packages/book-server', file: 'test/faults.test.js' },
  { name: 'reorg', pkg: 'packages/book-server', file: 'test/reorg.test.js' },
  { name: 'pinned-read', pkg: 'packages/book-server', file: 'test/pinned-read.test.js' },
  { name: 'differential', pkg: 'packages/book-server', file: 'test/differential.test.js' },
  { name: 'event-order', pkg: 'packages/book-server', file: 'test/event-order.test.js' },
  { name: 'http-security', pkg: 'packages/book-server', file: 'test/http-security.test.js' },
  { name: 'taker', pkg: 'packages/client', file: 'test/taker.test.js' },
  { name: 'protect', pkg: 'packages/client', file: 'test/protect.test.js' },
  { name: 'taker-advanced', pkg: 'packages/client', file: 'test/taker-advanced.test.js' },
]

function run(cmd, args, opts) {
  return new Promise((res) => {
    const child = spawn(cmd, args, { ...opts, stdio: ['ignore', 'pipe', 'pipe'] })
    let out = ''
    child.stdout.on('data', (d) => { out += d; process.stdout.write(d) })
    child.stderr.on('data', (d) => { out += d; process.stderr.write(d) })
    child.on('exit', (code) => res({ code, out }))
  })
}

loadEnv()
const args = process.argv.slice(2)
const only = args.filter((a) => !a.startsWith('--'))
const suites = SUITES.filter((s) => (only.length ? only.includes(s.name) : true) &&
  (!args.includes('--unit') || s.unit) && (!args.includes('--fork') || !s.unit))
const summary = []
for (const s of suites) {
  console.log(`\n=== ${s.name} (${s.pkg}/${s.file}) ===`)
  const fork = s.unit ? null : await startFork()
  const t0 = Date.now()
  let r
  try {
    const env = { ...process.env, ...(fork ? { FORK_URL: fork.url } : {}) }
    r = s.forge
      ? await run(foundryBin('forge'), ['test', '--fork-url', fork?.url ?? ''], { cwd: resolve(ROOT, s.pkg), env })
      : await run(process.execPath, ['--no-warnings=ExperimentalWarning', s.file], { cwd: resolve(ROOT, s.pkg), env })
  } finally {
    await fork?.stop()
  }
  let passed = 0, total = 0
  const m = r.out.match(/(\d+)\/(\d+) checks passed/)
  const f = r.out.match(/(\d+) tests passed, (\d+) failed, (\d+) skipped \((\d+) total tests\)/)
  if (m) { passed = Number(m[1]); total = Number(m[2]) } else if (f) { passed = Number(f[1]); total = Number(f[4]) }
  summary.push({ suite: s.name, passed, total, ok: r.code === 0 && total > 0 && passed === total, seconds: Math.round((Date.now() - t0) / 1000), forkBlock: fork ? fork.forkBlock.toString() : null })
}
console.log('\nsuite          result   time')
for (const x of summary) console.log(`${x.suite.padEnd(14)} ${`${x.passed}/${x.total}`.padEnd(8)} ${x.seconds}s ${x.ok ? 'OK' : 'FAIL'}`)
mkdirSync(resolve(ROOT, 'reports'), { recursive: true })
writeFileSync(resolve(ROOT, only.length || args.length ? 'reports/tests-partial.json' : 'reports/tests.json'), JSON.stringify(summary, null, 2))
process.exit(summary.every((x) => x.ok) ? 0 : 1)
