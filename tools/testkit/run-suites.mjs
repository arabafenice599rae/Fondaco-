// Runs every fork suite against its OWN fresh anvil fork (same fixed block), so suites cannot leak state into each
// other (automine toggles, time travel, snapshots). Prints and stores the per-suite counts.
//   node tools/testkit/run-suites.mjs [suite ...] [--unit | --fork] [--group contracts,book-server,client,web,tools]
//        [--profile quick]   skip the suites marked slow (pull requests)
//        [--retries N]       re-run a failed FORK suite up to N times (public RPCs time out; each attempt is reported)
//        [--report name]     write reports/<name>.json (default tests.json / tests-partial.json)
//        [--skip a,b]        leave these suites out (e.g. foundry, which has its own CI job)
// FORK_BLOCK overrides fork.config.json; FOUNDRY_PROFILE selects the Foundry profile (ci-quick on pull requests).
// With GITHUB_STEP_SUMMARY set, a Markdown table of the suites is appended to the job summary.
import { spawn } from 'node:child_process'
import { mkdirSync, writeFileSync, appendFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { startFork, foundryBin, FORK_CONFIG } from './anvil.js'
import { ROOT, loadEnv } from './env.js'

export const SUITES = [
  { name: 'lint', pkg: 'tools', file: 'lint.mjs', unit: true, group: 'tools' },
  { name: 'checksums', pkg: 'tools', file: 'checksums.mjs', unit: true, group: 'tools' },
  { name: 'fetch-binary', pkg: 'tools', file: 'ci/fetch-binary.test.mjs', unit: true, group: 'tools' },
  { name: 'wallet', pkg: 'packages/client', file: 'test/wallet.test.js', unit: true, group: 'client' },
  { name: 'client-guards', pkg: 'packages/client', file: 'test/guards.test.js', unit: true, group: 'client' },
  { name: 'client-smoke', pkg: 'tools/client-smoke', file: 'smoke.mjs', unit: true, group: 'client' },
  { name: 'verify-source', pkg: 'tools/verify-source', file: 'verify-source.test.mjs', unit: true, group: 'contracts' },
  { name: 'backup', pkg: 'packages/book-server', file: 'test/backup.test.js', unit: true, group: 'book-server' },
  { name: 'docker-smoke', pkg: 'packages/book-server', file: 'test/docker-smoke.mjs', unit: true, group: 'docker', explicit: true },
  { name: 'config', pkg: 'packages/book-server', file: 'test/config.test.js', unit: true, group: 'book-server' },
  { name: 'allocation', pkg: 'packages/book-server', file: 'test/allocation.test.js', unit: true, group: 'book-server' },
  { name: 'migrations', pkg: 'packages/book-server', file: 'test/migrations.test.js', unit: true, group: 'book-server' },
  { name: 'observability', pkg: 'packages/book-server', file: 'test/observability.test.js', unit: true, group: 'book-server' },
  { name: 'testkit', pkg: 'tools/testkit', file: 'testkit.test.js', group: 'tools' },
  { name: 'fee', pkg: 'packages/contracts', file: 'test/fee-side.test.js', group: 'contracts' },
  { name: 'foundry', pkg: 'packages/contracts', forge: true, group: 'contracts' },
  { name: 'addresses', pkg: 'packages/contracts', file: 'test/addresses.test.js', group: 'contracts' },
  { name: 'deploy', pkg: 'packages/contracts', file: 'test/deploy.test.js', group: 'contracts' },
  { name: 'e2e', pkg: 'packages/book-server', file: 'test/e2e.js', group: 'book-server' },
  { name: 'engine', pkg: 'packages/book-server', file: 'test/engine.test.js', group: 'book-server' },
  { name: 'signers', pkg: 'packages/book-server', file: 'test/signers.test.js', group: 'book-server' },
  { name: 'metrics', pkg: 'packages/book-server', file: 'test/metrics.test.js', group: 'book-server' },
  { name: 'trades', pkg: 'packages/book-server', file: 'test/trades.test.js', group: 'book-server' },
  { name: 'faults', pkg: 'packages/book-server', file: 'test/faults.test.js', group: 'book-server', slow: true },
  { name: 'reorg', pkg: 'packages/book-server', file: 'test/reorg.test.js', group: 'book-server' },
  { name: 'pinned-read', pkg: 'packages/book-server', file: 'test/pinned-read.test.js', group: 'book-server' },
  { name: 'differential', pkg: 'packages/book-server', file: 'test/differential.test.js', group: 'book-server', slow: true },
  { name: 'event-order', pkg: 'packages/book-server', file: 'test/event-order.test.js', group: 'book-server' },
  { name: 'http-security', pkg: 'packages/book-server', file: 'test/http-security.test.js', group: 'book-server' },
  { name: 'taker', pkg: 'packages/client', file: 'test/taker.test.js', group: 'client' },
  { name: 'protect', pkg: 'packages/client', file: 'test/protect.test.js', group: 'client' },
  { name: 'taker-advanced', pkg: 'packages/client', file: 'test/taker-advanced.test.js', group: 'client' },
  { name: 'web-model', pkg: 'apps/web', file: 'test/model.test.mjs', unit: true, group: 'web' },
  { name: 'web-keys', pkg: 'apps/web', file: 'scripts/scan-keys.mjs', unit: true, group: 'web' },
  { name: 'reproducible-build', pkg: 'tools', file: 'build-hash.mjs', args: ['--twice'], unit: true, group: 'web' },
  { name: 'web-layout', pkg: 'apps/web', file: 'test/layout.mjs', unit: true, group: 'web', slow: true },
  { name: 'web-a11y', pkg: 'apps/web', file: 'test/a11y.mjs', unit: true, group: 'web' },
  { name: 'web-visual', pkg: 'apps/web', file: 'test/visual.mjs', unit: true, group: 'web' },
  { name: 'web-e2e', pkg: 'apps/web', file: 'test/e2e.mjs', group: 'web' },
  { name: 'web-flows', pkg: 'apps/web', file: 'test/flows.mjs', group: 'web', slow: true },
  { name: 'web-perf', pkg: 'apps/web', file: 'test/perf.mjs', group: 'web', slow: true },
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
const opt = (k) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : null }
const valued = new Set(['--group', '--profile', '--retries', '--report', '--skip'])
const only = args.filter((a, i) => !a.startsWith('--') && !valued.has(args[i - 1]))
const groups = opt('--group')?.split(',').filter(Boolean) ?? null
const quick = opt('--profile') === 'quick'
const retries = Number(opt('--retries') ?? 0)
const skip = new Set(opt('--skip')?.split(',').filter(Boolean) ?? [])
// explicit suites (docker-smoke: needs a Docker daemon) run only when named or when their group is selected
const suites = SUITES.filter((s) => !skip.has(s.name) && (only.length ? only.includes(s.name) : true) && (!s.explicit || only.includes(s.name) || groups?.includes(s.group)) && (!groups || groups.includes(s.group)) && (!quick || !s.slow) &&
  (!args.includes('--unit') || s.unit) && (!args.includes('--fork') || !s.unit))
if (!suites.length) { console.error('no suite selected'); process.exit(2) }
const forkBlock = process.env.FORK_BLOCK ? BigInt(process.env.FORK_BLOCK) : undefined
const summary = []
for (const s of suites) {
  let r, passed = 0, total = 0, attempts = 0, fork = null, t0
  for (;;) {
    attempts++
    console.log(`\n=== ${s.name} (${s.pkg}/${s.file ?? 'forge'})${attempts > 1 ? ` — attempt ${attempts}` : ''} ===`)
    // anvil's own log of this suite: reports/anvil/<suite>.log (uploaded by the CI)
    const anvilLog = s.unit ? null : resolve(ROOT, 'reports/anvil', `${s.name}${attempts > 1 ? '-' + attempts : ''}.log`)
    if (anvilLog) { mkdirSync(resolve(ROOT, 'reports/anvil'), { recursive: true }); writeFileSync(anvilLog, '') }
    fork = s.unit ? null : await startFork({ ...(forkBlock ? { forkBlock } : {}), log: (l) => appendFileSync(anvilLog, l) }).catch((e) => ({ error: e }))
    t0 = Date.now()
    if (fork?.error) { r = { code: 1, out: `anvil failed to start: ${fork.error.message}` }; console.error(r.out); fork = null } else {
      try {
        const env = { ...process.env, ...(fork ? { FORK_URL: fork.url } : {}) }
        r = s.forge
          ? await run(foundryBin('forge'), ['test', '--fork-url', fork?.url ?? ''], { cwd: resolve(ROOT, s.pkg), env })
          : await run(process.execPath, ['--no-warnings=ExperimentalWarning', s.file, ...(s.args ?? [])], { cwd: resolve(ROOT, s.pkg), env })
      } finally {
        await fork?.stop()
      }
    }
    passed = 0; total = 0
    const m = r.out.match(/(\d+)\/(\d+) checks passed/)
    const f = r.out.match(/(\d+) tests passed, (\d+) failed, (\d+) skipped \((\d+) total tests\)/)
    if (m) { passed = Number(m[1]); total = Number(m[2]) } else if (f) { passed = Number(f[1]); total = Number(f[4]) }
    const ok = r.code === 0 && total > 0 && passed === total
    if (ok || s.unit || attempts > retries) break
    console.log(`--- ${s.name} failed (${passed}/${total}); retrying (${attempts}/${retries})`)
  }
  summary.push({ suite: s.name, group: s.group, passed, total, ok: r.code === 0 && total > 0 && passed === total, attempts, seconds: Math.round((Date.now() - t0) / 1000), forkBlock: s.unit ? null : (forkBlock ?? BigInt(FORK_CONFIG.forkBlock)).toString() })
}
console.log('\nsuite          result   time')
for (const x of summary) console.log(`${x.suite.padEnd(14)} ${`${x.passed}/${x.total}`.padEnd(8)} ${x.seconds}s ${x.ok ? 'OK' : 'FAIL'}${x.attempts > 1 ? ` (attempt ${x.attempts})` : ''}`)
mkdirSync(resolve(ROOT, 'reports'), { recursive: true })
const name = opt('--report') ?? (only.length || args.length ? 'tests-partial' : 'tests')
writeFileSync(resolve(ROOT, `reports/${name}.json`), JSON.stringify(summary, null, 2))
if (process.env.GITHUB_STEP_SUMMARY) {
  const p = summary.reduce((a, x) => a + x.passed, 0), t = summary.reduce((a, x) => a + x.total, 0)
  const md = [`### Suite ${name}: ${summary.filter((x) => x.ok).length}/${summary.length} OK — ${p}/${t} checks`, '', '| Suite | Group | Checks | Time | Result |', '|---|---|---|---|---|',
    ...summary.map((x) => `| ${x.suite} | ${x.group} | ${x.passed}/${x.total} | ${x.seconds} s | ${x.ok ? '✅' : '❌'}${x.attempts > 1 ? ` (attempt ${x.attempts})` : ''} |`), ''].join('\n')
  appendFileSync(process.env.GITHUB_STEP_SUMMARY, md + '\n')
}
process.exit(summary.every((x) => x.ok) ? 0 : 1)
