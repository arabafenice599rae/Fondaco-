// Performance of the production build, on the fork with a live book holding one offer:
//   P1 initial bundle (JS + CSS referenced by index.html, gzip) ≤ BUDGET.initialGzip; the wallet runtime is not in it
//   P2 fonts (all woff2) ≤ BUDGET.fontsBytes
//   P3 "Fast 3G" (DevTools: 562.5 ms RTT, 1.44 Mbit/s down, 675 kbit/s up): the book (an ask row) is on screen
//      ≤ 2000 ms after navigation — splash already seen in the session; median of 3 cold loads
//   P4 Lighthouse mobile (default: simulated slow 4G, 4× CPU): Performance ≥ 0.90 and Accessibility ≥ 0.90, median of 3
// Numbers are written to reports/perf.json (docs/PHASE6-RESULTS.md quotes them).
import { spawn } from 'node:child_process'
import { gzipSync } from 'node:zlib'
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import * as H from './harness.mjs'

export const BUDGET = { initialGzip: 60 * 1024, fontsBytes: 130 * 1024, fast3gMs: 2000, lighthouse: 0.9 }
const { check, finish } = H.reporter()
const report = { budget: BUDGET }

const [deployer, alice] = await H.accounts()
const { swap, block } = await H.deploySwap(deployer, deployer)
const [book] = await H.startBooks(1, swap, block)
// one ask in the book: alice sells 0.5 WETH at 2500 (signed through anvil's unlocked account)
await H.send(alice, { address: H.WETH, abi: H.ERC20, functionName: 'deposit', value: H.E18 })
await H.send(alice, { address: H.WETH, abi: H.ERC20, functionName: 'approve', args: [swap, 2n ** 255n] })
const cfg = (await book.api('/config')).body[1]
const now = (await H.pub.getBlock()).timestamp
const message = { nonce: 1n, expiry: now + 3600n, signerWallet: alice, signerToken: H.WETH, signerAmount: 5n * 10n ** 17n, protocolFee: H.FEE, senderWallet: H.ZERO, senderToken: H.USDC, senderAmount: 1250n * H.E6 }
const sig = await H.dev(alice).signTypedData({ domain: cfg.domain, types: cfg.types, primaryType: 'OrderERC20', message })
const posted = await book.api('/orders', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ chainId: 1, orders: [{ ...Object.fromEntries(Object.entries(message).map(([k, v]) => [k, String(v)])), v: parseInt(sig.slice(130, 132), 16), r: '0x' + sig.slice(2, 66), s: '0x' + sig.slice(66, 130) }] }) })
if (posted.body?.results?.[0]?.status !== 'open') throw new Error('setup: offer not open ' + JSON.stringify(posted.body))

const dir = H.buildApp()
const srv = await H.serve(dir, H.appConfig({ book: book.url, swap }))

// ------------------------------------------------------------------ P1, P2 bundle
const html = readFileSync(join(dir, 'index.html'), 'utf8')
const initial = [...html.matchAll(/<(?:script[^>]*src|link[^>]*rel="(?:stylesheet|modulepreload)"[^>]*href)="\.\/([^"]+\.(?:js|css))"/g)].map((m) => m[1])
const sizes = initial.map((f) => ({ file: f, gzip: gzipSync(readFileSync(join(dir, f)), { level: 9 }).length }))
const total = sizes.reduce((s, x) => s + x.gzip, 0)
report.initial = { files: sizes, totalGzip: total, html: gzipSync(Buffer.from(html), { level: 9 }).length }
const lazy = H.files(join(dir, 'assets')).filter((f) => f.endsWith('.js') && !initial.some((i) => f.endsWith(i))).map((f) => ({ file: f.split('/').pop(), gzip: gzipSync(readFileSync(f), { level: 9 }).length }))
report.lazy = lazy
check(`P1: initial bundle ${(total / 1024).toFixed(1)} kB gzip ≤ ${BUDGET.initialGzip / 1024} kB; wallet runtime loaded on demand`, total <= BUDGET.initialGzip && !initial.some((f) => /wallet-rt/.test(f)) && lazy.some((l) => /wallet-rt/.test(l.file)),
  sizes.map((s) => `${s.file.split('/').pop()} ${(s.gzip / 1024).toFixed(1)}`).join(', ') + ` · lazy: ${lazy.map((l) => `${l.file} ${(l.gzip / 1024).toFixed(1)}`).join(', ')}`)
const fonts = H.files(join(dir, 'assets')).filter((f) => f.endsWith('.woff2'))
const fontBytes = fonts.reduce((s, f) => s + readFileSync(f).length, 0)
report.fonts = { files: fonts.length, bytes: fontBytes }
check(`P2: fonts ${(fontBytes / 1024).toFixed(0)} kB (${fonts.length} Latin subsets) ≤ ${BUDGET.fontsBytes / 1024} kB`, fontBytes <= BUDGET.fontsBytes)

// ------------------------------------------------------------------ P3 Fast 3G
const FAST3G = { offline: false, latency: 562.5, downloadThroughput: (1.6 * 1000 * 1000) / 8 * 0.9, uploadThroughput: (750 * 1000) / 8 * 0.9 }
const browser = await H.launch()
const runs = []
for (let i = 0; i < 3; i++) {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } })
  await ctx.addInitScript(() => {
    try { sessionStorage.setItem('fondaco-splash', '1') } catch {}
    window.__bookAt = null
    const mo = new MutationObserver(() => { if (window.__bookAt == null && document.querySelector('#asks .lvl') && !document.documentElement.classList.contains('booting')) window.__bookAt = performance.now() })
    document.addEventListener('DOMContentLoaded', () => mo.observe(document.documentElement, { subtree: true, childList: true, attributes: true }), { once: true })
  })
  const page = await ctx.newPage()
  const cdp = await ctx.newCDPSession(page)
  await cdp.send('Network.enable'); await cdp.send('Network.setCacheDisabled', { cacheDisabled: true })
  await cdp.send('Network.emulateNetworkConditions', FAST3G)
  await page.goto(srv.url)
  const at = await H.until(() => page.evaluate(() => window.__bookAt), 20_000, 'book on screen')
  runs.push(Math.round(at))
  await ctx.close()
}
const med = [...runs].sort((a, b) => a - b)[1]
report.fast3g = { conditions: FAST3G, runsMs: runs, medianMs: med }
check(`P3: Fast 3G — book on screen in ${med} ms (median of 3) ≤ ${BUDGET.fast3gMs} ms`, med <= BUDGET.fast3gMs, `runs ${runs.join(', ')} ms; splash already seen in the session (first visit: under the ~2.8 s splash)`)
await H.closeBrowser()

// ------------------------------------------------------------------ P4 Lighthouse (async spawn: this process serves the page)
const lh = (out) => new Promise((res) => {
  const p = spawn(process.execPath, [resolve(H.APP, 'node_modules/lighthouse/cli/index.js'), srv.url, '--quiet', '--chrome-flags=--headless=new --no-sandbox --disable-background-networking --disable-component-update --no-first-run',
    '--only-categories=performance,accessibility', '--max-wait-for-load=20000', '--output=json', `--output-path=${out}`], { env: { ...process.env, CHROME_PATH: process.env.CHROME_PATH || '/opt/pw-browsers/chromium' }, stdio: 'ignore' })
  const t = setTimeout(() => p.kill('SIGKILL'), 180_000)
  p.on('exit', (code) => { clearTimeout(t); res(code) })
})
mkdirSync(resolve(H.ROOT, 'reports'), { recursive: true })
const lhRuns = []
for (let i = 0; i < 3; i++) {
  const out = resolve(H.ROOT, `reports/lighthouse-${i}.json`)
  const code = await lh(out)
  if (code !== 0) { lhRuns.push(null); continue }
  const d = JSON.parse(readFileSync(out, 'utf8'))
  lhRuns.push({ performance: d.categories.performance.score, accessibility: d.categories.accessibility.score,
    fcp: d.audits['first-contentful-paint'].numericValue, lcp: d.audits['largest-contentful-paint'].numericValue, tbt: d.audits['total-blocking-time'].numericValue, cls: d.audits['cumulative-layout-shift'].numericValue, si: d.audits['speed-index'].numericValue })
}
const ok = lhRuns.filter(Boolean)
const median = (k) => { const v = ok.map((r) => r[k]).sort((a, b) => a - b); return v[Math.floor(v.length / 2)] }
report.lighthouse = { runs: lhRuns, median: ok.length ? { performance: median('performance'), accessibility: median('accessibility'), fcp: median('fcp'), lcp: median('lcp'), tbt: median('tbt'), cls: median('cls'), si: median('si') } : null }
const m = report.lighthouse.median
check(`P4: Lighthouse mobile — Performance ${m?.performance} and Accessibility ${m?.accessibility} ≥ ${BUDGET.lighthouse} (median of ${ok.length})`, ok.length === 3 && m.performance >= BUDGET.lighthouse && m.accessibility >= BUDGET.lighthouse,
  m ? `FCP ${(m.fcp / 1000).toFixed(1)} s, LCP ${(m.lcp / 1000).toFixed(1)} s (splash wordmark), TBT ${Math.round(m.tbt)} ms, CLS ${m.cls.toFixed(3)}, SI ${(m.si / 1000).toFixed(1)} s` : 'lighthouse failed')

writeFileSync(resolve(H.ROOT, 'reports/perf.json'), JSON.stringify(report, null, 2))
await srv.close(); await book.stop()
process.exit(finish() ? 0 : 1)
