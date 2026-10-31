// Runs every fork suite against its OWN fresh anvil fork (same fixed block), so suites cannot leak state into each
// other (automine toggles, time travel, snapshots). Prints and stores the per-suite counts.
//   node tools/testkit/run-fork-suites.mjs [suite ...]
import { spawn } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { startFork } from './anvil.js'
import { ROOT, loadEnv } from './env.js'

export const SUITES = [
  { name: 'testkit', pkg: 'tools/testkit', file: 'testkit.test.js' },
  { name: 'fee', pkg: 'packages/contracts', file: 'test/fee-side.test.js' },
  { name: 'deploy', pkg: 'packages/contracts', file: 'test/deploy.test.js' },
  { name: 'e2e', pkg: 'packages/book-server', file: 'test/e2e.js' },
  { name: 'engine', pkg: 'packages/book-server', file: 'test/engine.test.js' },
  { name: 'taker', pkg: 'packages/client', file: 'test/taker.test.js' },
  { name: 'protect', pkg: 'packages/client', file: 'test/protect.test.js' },
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
const only = process.argv.slice(2)
const suites = only.length ? SUITES.filter((s) => only.includes(s.name)) : SUITES
const summary = []
for (const s of suites) {
  console.log(`\n=== ${s.name} (${s.pkg}/${s.file}) ===`)
  const fork = await startFork()
  const t0 = Date.now()
  let r
  try {
    r = await run(process.execPath, ['--no-warnings=ExperimentalWarning', s.file], { cwd: resolve(ROOT, s.pkg), env: { ...process.env, FORK_URL: fork.url } })
  } finally {
    await fork.stop()
  }
  const m = r.out.match(/(\d+)\/(\d+) checks passed/)
  const passed = m ? Number(m[1]) : 0, total = m ? Number(m[2]) : 0
  summary.push({ suite: s.name, passed, total, ok: r.code === 0 && m && passed === total, seconds: Math.round((Date.now() - t0) / 1000), forkBlock: fork.forkBlock.toString() })
}
console.log('\nsuite      result   time')
for (const x of summary) console.log(`${x.suite.padEnd(10)} ${`${x.passed}/${x.total}`.padEnd(8)} ${x.seconds}s ${x.ok ? 'OK' : 'FAIL'}`)
mkdirSync(resolve(ROOT, 'reports'), { recursive: true })
writeFileSync(resolve(ROOT, 'reports/fork-tests.json'), JSON.stringify(summary, null, 2))
process.exit(summary.every((x) => x.ok) ? 0 : 1)
