// Every view and sheet of the app, as recipes run on the DEMO=true build (simulated data, no chain): shared by the overlap
// detector (layout.mjs), the accessibility checks (a11y.mjs) and the visual regression (visual.mjs).
import { createRequire } from 'node:module'
import * as H from './harness.mjs'

export const VIEWPORTS = [[320, 640], [360, 740], [390, 844], [430, 932], [900, 800], [1280, 800], [1440, 900]]
const wide = (p) => (p.viewportSize()?.width ?? 0) >= 860
const tab = async (p, t) => { if (!wide(p)) { await p.click(`[data-tab="${t}"]`); await p.waitForTimeout(250) } }

/** { id, sheet?: element id of the open sheet, go(page) } — go starts from a freshly loaded page. */
export const STATES = [
  { id: 'scambia', go: async () => {} },
  { id: 'scambia-importo', go: async (p) => { await p.fill('#pay-in', '1.500'); await p.click('#sum-btn'); await p.waitForTimeout(300) } },
  { id: 'proponi', go: async (p) => { await p.click('[data-m="make"]'); await p.fill('#mk-in', '0,4') } },
  { id: 'proponi-avvisi', go: async (p) => {
    await p.click('[data-m="make"]'); await p.fill('#mk-in', '0,4'); await p.click('[data-mode="custom"]'); await p.fill('#custom-in', '2.200')
    await p.click('[data-exp="7d"]'); await p.locator('label[for="mk-private"]').click(); await p.fill('#mk-cp', '0x12')
  } },
  { id: 'mercati', go: async (p) => { await tab(p, 'markets') } },
  { id: 'mercato', go: async (p) => { await tab(p, 'markets'); if (!wide(p)) await p.click('#m-list [data-mkt]'); await p.waitForTimeout(250) } },
  { id: 'offerte', go: async (p) => { await tab(p, 'offers') } },
  { id: 'storico', go: async (p) => { await tab(p, 'offers'); await p.locator(wide(p) ? '#offers-d [data-of="storico"]' : '#offers-m-list [data-of="storico"]').click() } },
  { id: 'conferma', sheet: 'confirm', go: async (p) => { await p.fill('#pay-in', '1.500'); await p.click('#review'); await H.until(async () => (await p.textContent('#c-qs'))?.trim() === 'Verificato', 10_000, 'verified') } },
  { id: 'esito', sheet: 'confirm', go: async (p) => {
    await p.fill('#pay-in', '1.500'); await p.click('#review'); await H.until(async () => !(await p.isDisabled('#c-go')), 10_000, 'go')
    await p.click('#c-go'); await H.until(async () => p.isVisible('#c-done'), 20_000, 'done')
  } },
  { id: 'scegli-moneta', sheet: 'picker', go: async (p) => { await p.click('#pay-tok') } },
  { id: 'scegli-mercato', sheet: 'mpicker', go: async (p) => { if (!wide(p)) { await tab(p, 'markets'); await p.click('#m-list [data-mkt]'); await p.waitForTimeout(250) } await p.click('#pair-btn') } },
  { id: 'wallet', sheet: 'wsheet', go: async (p) => { await p.click('#wal-chip') } },
  { id: 'impostazioni', sheet: 'ssheet', go: async (p) => { if (await p.isVisible('#set-chip')) await p.click('#set-chip'); else { await p.click('#wal-chip'); await p.waitForTimeout(300); await p.click('#w-settings') } } },
  { id: 'impostazioni-contratto', sheet: 'ssheet', go: async (p) => {
    if (await p.isVisible('#set-chip')) await p.click('#set-chip'); else { await p.click('#wal-chip'); await p.waitForTimeout(300); await p.click('#w-settings') }
    await p.waitForTimeout(300); await p.click('[data-edit="1"]'); await p.locator('#s-ack-1').check()
  } },
]

/** A demo build served locally; `page(w, h)` opens a fresh, motion-free page with the splash already seen. */
export async function demoApp() {
  const dir = H.buildApp({ demo: true })
  const srv = await H.serve(dir)
  const b = await H.launch()
  return {
    url: srv.url,
    async page([w, h], { scale = 1, freeze = true, deterministic = false, blockFonts = false } = {}) {
      const ctx = await b.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: scale, reducedMotion: 'reduce' })
      // blockFonts: the woff2 never arrive, so the page renders with the metric-matched local fallbacks (D-57)
      if (blockFonts) await ctx.route('**/*.woff2', (r) => r.abort())
      await ctx.addInitScript(() => { try { sessionStorage.setItem('fondaco-splash', '1'); localStorage.clear() } catch {} })
      if (deterministic) await ctx.addInitScript(() => {
        // same pixels on every run: seeded Math.random, no periodic updates (demo ticker, "ago" labels)
        let seed = 42; Math.random = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648 }
        window.setInterval = () => 0
      })
      const p = await ctx.newPage()
      if (deterministic) await p.clock.setFixedTime(new Date('2026-11-04T10:00:00Z'))
      const logs = []
      p.on('pageerror', (e) => logs.push('pageerror ' + e.message))
      p.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') logs.push(m.type() + ' ' + m.text()) })
      await p.goto(srv.url)
      await p.waitForSelector('#m-list [data-mkt]', { state: 'attached' })
      // (deterministic: intervals are already off; with the fake clock timer ids are huge, so no clearing loop)
      if (freeze && !deterministic) await p.evaluate(() => { const id = setInterval(() => {}, 1e6); for (let i = 1; i <= id; i++) clearInterval(i) }) // the demo ticker keeps moving
      return { p, ctx, logs }
    },
    async close() { await H.closeBrowser(); await srv.close() },
  }
}
export async function enter(app, vp, st, opts) {
  const { p, ctx, logs } = await app.page(vp, opts)
  await st.go(p)
  await fontsLoaded(p, { blocked: !!opts?.blockFonts })
  await p.waitForTimeout(450)
  return { p, ctx, logs }
}
/**
 * Waits until every bundled font face is loaded (the `local()` fallback faces are not checked: which ones exist depends on
 * the system). The faces use `font-display: swap` and load on first use, so a screenshot or a layout sample must not run
 * before them. With `blocked` (woff2 requests aborted) it checks the opposite: no bundled face loaded, a fallback in use.
 */
export async function fontsLoaded(p, { blocked = false } = {}) {
  const st = await p.evaluate(async () => {
    const web = [...document.fonts].filter((f) => !/Fallback/.test(f.family))
    await Promise.allSettled(web.map((f) => f.load()))
    await document.fonts.ready
    const fb = [...document.fonts].filter((f) => /Fallback/.test(f.family) && f.status === 'loaded').map((f) => f.family)
    return { bad: web.filter((f) => f.status !== 'loaded').map((f) => `${f.family} ${f.weight} ${f.status}`), loaded: web.filter((f) => f.status === 'loaded').length, fb: [...new Set(fb)] }
  })
  if (!blocked && st.bad.length) throw new Error('fonts not loaded: ' + st.bad.join(', '))
  if (blocked && (st.loaded || !st.fb.length)) throw new Error(`fonts blocked, but ${st.loaded} web faces loaded and fallbacks in use: ${st.fb.join(', ') || 'none'}`)
  return st
}
export const require_ = createRequire(import.meta.url)
