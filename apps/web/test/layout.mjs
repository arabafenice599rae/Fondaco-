// Overlap detector (point sampling) on every view and sheet × 7 viewports × 4 scroll positions (DEMO build):
//   covered  — a text or control element whose visible area, sampled on a 3×3 grid, is hit by an unrelated element
//              (sticky header, bottom dock and toast are chrome: they may cover content, never each other's controls)
//   clipped  — text that overflows the box that clips it (overflow hidden/clip), unless truncated on purpose (text-overflow: ellipsis)
//   h-scroll — the page is wider than the viewport
// Writes reports/layout.json; fails on any covered/clipped element or horizontal scroll.
import { writeFileSync, mkdirSync } from 'node:fs'
import { resolve } from 'node:path'
import * as H from './harness.mjs'
import { STATES, VIEWPORTS, demoApp, enter } from './states.mjs'

/** Runs in the page. `sheetId`: only the open sheet is inspected (the page under the scrim is covered on purpose). */
function detect(sheetId) {
  const root = sheetId ? document.querySelector(`#${sheetId} .sheet`) : document.body
  const vw = document.documentElement.clientWidth, vh = innerHeight
  const path = (el) => { const parts = []; for (let e = el; e && e !== document.body && parts.length < 4; e = e.parentElement) parts.unshift(e.id ? '#' + e.id : e.tagName.toLowerCase() + (e.classList[0] ? '.' + e.classList[0] : '')); return parts.join('>') }
  const chromeSel = sheetId ? '' : 'header.top, #dock, #toast.show, .ch-tip'
  const chrome = chromeSel ? [...document.querySelectorAll(chromeSel)].filter((c) => c.checkVisibility()) : []
  const inChrome = (el) => chrome.some((c) => c.contains(el))
  // 2 px of tolerance: hit testing snaps to whole pixels at the edge of a fixed bar
  const underChrome = (x, y) => chrome.some((c) => { const r = c.getBoundingClientRect(); return x >= r.left - 2 && x <= r.right + 2 && y >= r.top - 2 && y <= r.bottom + 2 })
  const clipsOf = (el) => { const out = []; for (let e = el.parentElement; e && e !== document.documentElement; e = e.parentElement) { const cs = getComputedStyle(e); if (cs.overflowX !== 'visible' || cs.overflowY !== 'visible') out.push({ e, cs }) } return out }
  const hasText = (el) => [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim())
  const cand = [...root.querySelectorAll('button, a, input, select, textarea, label, svg.ic, [role="switch"], *')].filter((el) => {
    if (!(el instanceof HTMLElement) && !(el instanceof SVGElement)) return false
    const tag = el.tagName.toLowerCase()
    if (tag === 'svg') return el.classList.contains('ic') // icons; charts are graphics with labels drawn over them on purpose
    return ['button', 'a', 'input', 'select', 'textarea'].includes(tag) || hasText(el)
  })
  const covered = [], clipped = [], ellipsis = []
  const seen = new Set()
  for (const el of new Set(cand)) {
    if (!el.checkVisibility({ opacityProperty: true, visibilityProperty: true })) continue
    const r = el.getBoundingClientRect()
    if (r.width < 2 || r.height < 2) continue
    // visible region: viewport ∩ every clipping ancestor
    let L = Math.max(0, r.left), T = Math.max(0, r.top), R = Math.min(vw, r.right), B = Math.min(vh, r.bottom)
    const clips = clipsOf(el)
    for (const { e } of clips) { const c = e.getBoundingClientRect(); L = Math.max(L, c.left); T = Math.max(T, c.top); R = Math.min(R, c.right); B = Math.min(B, c.bottom) }
    if (R - L >= 2 && B - T >= 2) {
      let hits = 0, bad = null
      for (const fx of [0.2, 0.5, 0.8]) for (const fy of [0.2, 0.5, 0.8]) {
        const x = L + (R - L) * fx, y = T + (B - T) * fy
        if (!inChrome(el) && underChrome(x, y)) continue
        const hit = document.elementFromPoint(x, y)
        if (!hit) continue
        if (hit === el || el.contains(hit) || hit.contains(el)) continue
        // parts of one control overlap by design (a badge on its icon, a pair of coins, a label's switch)
        const unit = (n) => n.closest('button, a, label, .coins2')
        if (unit(hit) && unit(hit) === unit(el)) continue
        hits++; bad = hit
      }
      if (hits >= 2) { const k = path(el) + '|' + path(bad); if (!seen.has(k)) { seen.add(k); covered.push({ el: path(el), by: path(bad), text: (el.textContent || el.getAttribute('aria-label') || '').trim().slice(0, 40) }) } }
    }
    // clipped text: the text's own boxes against the nearest clipping ancestor
    if (hasText(el)) {
      const range = document.createRange(); range.selectNodeContents(el)
      const tr = range.getBoundingClientRect()
      const cs = getComputedStyle(el)
      const own = (cs.overflowX !== 'visible') ? [{ e: el, cs }] : []
      for (const { e, cs: ccs } of [...own, ...clips.slice(0, 2)]) {
        if (ccs.overflowX === 'auto' || ccs.overflowX === 'scroll' || ccs.overflowY === 'auto' || ccs.overflowY === 'scroll') break // scrollable: reachable
        const c = e.getBoundingClientRect()
        if (c.width < 2 || c.height < 2) break // a collapsed box (closed details): hidden, not cut
        const out = tr.right - c.right > 1.5 || c.left - tr.left > 1.5 || tr.bottom - c.bottom > 1.5 || c.top - tr.top > 1.5
        if (out) {
          const item = { el: path(el), clip: path(e), text: el.textContent.trim().slice(0, 40), over: Math.round(Math.max(tr.right - c.right, tr.bottom - c.bottom, c.left - tr.left, c.top - tr.top)) }
          if (cs.textOverflow === 'ellipsis' || ccs.textOverflow === 'ellipsis') ellipsis.push(item); else clipped.push(item)
          break
        }
      }
    }
  }
  const hscroll = document.documentElement.scrollWidth > vw + 1 ? document.documentElement.scrollWidth - vw : 0
  return { covered, clipped, ellipsis, hscroll, checked: cand.length }
}

const { check, finish } = H.reporter()
const app = await demoApp()
// L0 self-test: the detector must see a panel over the main button and a text cut by its box
{
  const { p, ctx } = await enter(app, [390, 844], STATES[0])
  await p.evaluate(() => {
    const r = document.getElementById('review').getBoundingClientRect()
    const d = document.createElement('div'); d.id = 'planted-cover'; d.style.cssText = `position:fixed;left:${r.left}px;top:${r.top}px;width:${r.width}px;height:${r.height}px;background:red;z-index:5`
    const c = document.createElement('div'); c.id = 'planted-clip'; c.style.cssText = 'position:fixed;left:10px;top:200px;width:60px;height:20px;overflow:hidden;white-space:nowrap;z-index:6;background:#000'
    c.innerHTML = '<span id="planted-text">testo molto lungo che non entra</span>'
    document.body.append(d, c)
  })
  const r = await p.evaluate(detect, null)
  check('L0: self-test — a planted cover and a planted cut text are detected', r.covered.some((x) => /review/.test(x.el) && /planted-cover/.test(x.by)) && r.clipped.some((x) => /planted-text/.test(x.el)),
    `${r.covered.length} covered, ${r.clipped.length} clipped`)
  await ctx.close()
}
// Every view is sampled twice (D-57): with the web fonts, and with the woff2 blocked so the metric-matched local fallbacks
// render. Both must be clean, and the geometry must not move between the two (L5).
const report = []
const samples = { webfont: 0, fallback: 0 }
const geo = { webfont: new Map(), fallback: new Map() }
const rects = () => [...document.querySelectorAll('[id]')].filter((e) => e.getClientRects().length && !e.closest('[hidden],.sheet-wrap:not(.open)'))
  .map((e) => { const r = e.getBoundingClientRect(); return [e.id, Math.round(r.x * 10) / 10, Math.round(r.y * 10) / 10, Math.round(r.width * 10) / 10, Math.round(r.height * 10) / 10] })
for (const mode of ['webfont', 'fallback']) {
  for (const vp of VIEWPORTS) {
    for (const st of STATES) {
      const { p, ctx, logs } = await enter(app, vp, st, { blockFonts: mode === 'fallback' })
      geo[mode].set(`${vp.join('×')} ${st.id}`, await p.evaluate(rects))
      const scroller = st.sheet ? `#${st.sheet} .sheet` : null
      for (const f of [0, 1 / 3, 2 / 3, 1]) {
        await p.evaluate(([sel, f]) => { const s = sel ? document.querySelector(sel) : document.scrollingElement; s.scrollTop = (s.scrollHeight - s.clientHeight) * f }, [scroller, f])
        await p.waitForTimeout(120)
        const r = await p.evaluate(detect, st.sheet ?? null)
        samples[mode]++
        if (r.covered.length || r.clipped.length || r.hscroll) report.push({ mode, vp: vp.join('×'), state: st.id, scroll: f, covered: r.covered, clipped: r.clipped, hscroll: r.hscroll })
        if (r.ellipsis.length) report.push({ mode, vp: vp.join('×'), state: st.id, scroll: f, ellipsis: r.ellipsis })
      }
      // with the woff2 blocked Chrome logs the aborted requests; nothing else is allowed
      const con = mode === 'fallback' ? logs.filter((l) => !/\.woff2|ERR_FAILED/.test(l)) : logs
      if (con.length) report.push({ mode, vp: vp.join('×'), state: st.id, console: con })
      await ctx.close()
    }
  }
}
await app.close()
mkdirSync(resolve(H.ROOT, 'reports'), { recursive: true })
writeFileSync(resolve(H.ROOT, 'reports/layout.json'), JSON.stringify(report, null, 2))
const bad = report.filter((x) => x.covered?.length || x.clipped?.length || x.hscroll)
const per = (k, mode) => bad.filter((x) => !mode || x.mode === mode).reduce((s, x) => s + (x[k]?.length ?? (k === 'hscroll' && x.hscroll ? 1 : 0)), 0)
const show = (x) => `${x.mode} ${x.vp} ${x.state}@${x.scroll.toFixed(2)}: ${[...(x.covered ?? []).map((c) => `covered ${c.el} by ${c.by} "${c.text}"`), ...(x.clipped ?? []).map((c) => `clipped ${c.el} in ${c.clip} +${c.over}px "${c.text}"`), x.hscroll ? `h-scroll ${x.hscroll}px` : ''].filter(Boolean).slice(0, 2).join('; ')}`
const views = `${STATES.length} views/sheets × ${VIEWPORTS.length} viewports × 4 scroll positions`
check(`L1: no element covered, web fonts — ${views} (${samples.webfont} samples)`, per('covered', 'webfont') === 0, bad.filter((x) => x.mode === 'webfont' && x.covered?.length).slice(0, 4).map(show).join(' || '))
check(`L1b: no element covered, woff2 blocked (metric-matched fallback) — ${views} (${samples.fallback} samples)`, per('covered', 'fallback') === 0, bad.filter((x) => x.mode === 'fallback' && x.covered?.length).slice(0, 4).map(show).join(' || '))
check('L2: no text clipped, both font modes (truncation with an ellipsis is allowed and listed in reports/layout.json)', per('clipped') === 0, bad.filter((x) => x.clipped?.length).slice(0, 4).map(show).join(' || '))
check('L3: no horizontal scroll at any viewport, both font modes', bad.every((x) => !x.hscroll), bad.filter((x) => x.hscroll).slice(0, 4).map(show).join(' || '))
const con = report.filter((x) => x.console)
check('L4: clean console in every state (demo build; with the woff2 blocked only the aborted font requests)', con.length === 0, con.slice(0, 2).map((x) => `${x.mode} ${x.vp} ${x.state}: ${x.console[0]}`).join(' | '))
// L5: the fallback keeps the layout — every element with an id at the same place and size (±GEO_TOL px)
const GEO_TOL = 2
let worst = { d: 0, at: '' }, compared = 0
for (const [k, a] of geo.webfont) {
  const b = new Map((geo.fallback.get(k) ?? []).map((r) => [r[0], r]))
  for (const r of a) { const q = b.get(r[0]); if (!q) continue; compared++; const d = Math.max(...[1, 2, 3, 4].map((i) => Math.abs(r[i] - q[i]))); if (d > worst.d) worst = { d, at: `${k} #${r[0]} ${JSON.stringify(r.slice(1))} vs ${JSON.stringify(q.slice(1))}` } }
}
check(`L5: same geometry with the fallback fonts — ${compared} element boxes, max difference ≤ ${GEO_TOL} px`, compared > 0 && worst.d <= GEO_TOL, `max ${worst.d.toFixed(1)} px${worst.d ? ' at ' + worst.at : ''}`)
const ell = report.filter((x) => x.ellipsis).reduce((s, x) => s + x.ellipsis.length, 0)
console.log(`(info) ${ell} intentional ellipsis truncations`)
process.exit(finish() ? 0 : 1)
