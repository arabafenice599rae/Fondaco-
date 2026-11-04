// Accessibility of every view and sheet (DEMO build), at 390 and 1440 px:
//   A1 axe-core 4.14: zero serious/critical violations
//   A2 measured contrast of every visible text node against its effective background (ancestors composited): ≥ 4.5:1
//      (disabled controls and the decorative splash are excluded, as WCAG does for inactive components)
//   A3 keyboard: every sheet opens with Enter from its opener, Tab / Shift+Tab stay inside, Esc closes, focus returns to the opener
// Writes reports/a11y.json.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { resolve } from 'node:path'
import * as H from './harness.mjs'
import { STATES, demoApp, enter } from './states.mjs'

const AXE = readFileSync(resolve(H.APP, 'node_modules/axe-core/axe.min.js'), 'utf8')
const { check, finish } = H.reporter()
const app = await demoApp()
const report = { axe: [], contrast: [], keyboard: [] }

/** In the page: [{ text, ratio, fg, bg, size, weight, path }] for every visible text node. */
function contrast(sheetId) {
  const root = sheetId ? document.querySelector(`#${sheetId} .sheet`) : document.querySelector('#app')
  const parse = (c) => { const m = c.match(/rgba?\(([^)]+)\)/); if (!m) return null; const [r, g, b, a = 1] = m[1].split(/[ ,/]+/).filter(Boolean).map(Number); return [r, g, b, a] }
  const over = (top, under) => { const a = top[3] + under[3] * (1 - top[3]); if (a === 0) return [0, 0, 0, 0]; return [0, 1, 2].map((i) => (top[i] * top[3] + under[i] * under[3] * (1 - top[3])) / a).concat(a) }
  const lum = ([r, g, b]) => { const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4 }; return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b) }
  const bgOf = (el) => {
    const layers = []
    for (let e = el; e; e = e.parentElement) {
      const cs = getComputedStyle(e)
      if (cs.backgroundImage && cs.backgroundImage !== 'none' && !/gradient/.test(cs.backgroundImage)) return null
      const c = parse(cs.backgroundColor); if (c && c[3] > 0) layers.push(c)
      if (c && c[3] >= 1) break
    }
    let acc = parse(getComputedStyle(document.body).backgroundColor) ?? [255, 255, 255, 1]
    for (const l of layers.reverse()) acc = over(l, acc)
    return acc
  }
  const out = []
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, { acceptNode: (n) => (n.textContent.trim() ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT) })
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const el = n.parentElement
    if (!el || !el.checkVisibility({ opacityProperty: true, visibilityProperty: true })) continue
    if (el.closest('[disabled], [aria-disabled="true"], #splash, svg')) continue
    const r = el.getBoundingClientRect(); if (r.width < 1 || r.height < 1) continue
    const cs = getComputedStyle(el)
    let fg = parse(cs.color); const bg = bgOf(el)
    if (!fg || !bg) continue
    let op = 1; for (let e = el; e; e = e.parentElement) op *= Number(getComputedStyle(e).opacity)
    fg = over([fg[0], fg[1], fg[2], fg[3] * op], bg)
    const L1 = lum(fg), L2 = lum(bg), ratio = (Math.max(L1, L2) + 0.05) / (Math.min(L1, L2) + 0.05)
    const path = []; for (let e = el; e && path.length < 3; e = e.parentElement) path.unshift(e.id ? '#' + e.id : e.tagName.toLowerCase() + (e.classList[0] ? '.' + e.classList[0] : ''))
    out.push({ text: n.textContent.trim().slice(0, 30), ratio: Math.round(ratio * 100) / 100, size: cs.fontSize, weight: cs.fontWeight, path: path.join('>'), fg: cs.color })
  }
  return out
}

let minRatio = Infinity, texts = 0
for (const vp of [[390, 844], [1440, 900]]) {
  for (const st of STATES) {
    const { p, ctx } = await enter(app, vp, st)
    await p.evaluate(AXE)
    const res = await p.evaluate(async (sheet) => {
      const r = await window.axe.run(sheet ? { include: [[`#${sheet}`]] } : { exclude: [['#splash']] }, { resultTypes: ['violations'] })
      return r.violations.map((v) => ({ id: v.id, impact: v.impact, help: v.help, nodes: v.nodes.slice(0, 3).map((n) => n.target.join(' ')) }))
    }, st.sheet ?? null)
    for (const v of res) report.axe.push({ vp: vp.join('×'), state: st.id, ...v })
    const cs = await p.evaluate(contrast, st.sheet ?? null)
    texts += cs.length
    for (const c of cs) { minRatio = Math.min(minRatio, c.ratio); if (c.ratio < 4.5) report.contrast.push({ vp: vp.join('×'), state: st.id, ...c }) }
    await ctx.close()
  }
}
const serious = report.axe.filter((v) => v.impact === 'serious' || v.impact === 'critical')
const uniq = (arr, f) => [...new Map(arr.map((x) => [f(x), x])).values()]
check(`A1: axe-core — zero serious/critical violations in ${STATES.length} views/sheets × 2 viewports`, serious.length === 0,
  uniq(serious, (v) => v.id + v.nodes[0]).slice(0, 4).map((v) => `${v.state}@${v.vp} ${v.id}: ${v.nodes[0]}`).join(' | ') || `${report.axe.length} minor/moderate`)
check(`A2: measured contrast ≥ 4.5:1 on every visible text (${texts} text nodes, minimum ${minRatio.toFixed(2)}:1)`, report.contrast.length === 0,
  uniq(report.contrast, (c) => c.path + c.fg).slice(0, 5).map((c) => `${c.ratio}:1 "${c.text}" ${c.path} ${c.fg}`).join(' | '))

// ------------------------------------------------------------------ keyboard
const SHEETS = [
  { sheet: 'confirm', opener: '#review', before: async (p) => { await p.fill('#pay-in', '1.500'); await p.waitForTimeout(200) } },
  { sheet: 'picker', opener: '#pay-tok' },
  { sheet: 'mpicker', opener: '#pair-btn' },
  { sheet: 'wsheet', opener: '#wal-chip' },
  { sheet: 'ssheet', opener: '#set-chip' },
]
for (const s of SHEETS) {
  const { p, ctx } = await app.page([1440, 900])
  await s.before?.(p)
  await p.focus(s.opener); await p.keyboard.press('Enter'); await p.waitForTimeout(500)
  const opened = await p.isVisible(`#${s.sheet}`)
  const inside = []
  for (let i = 0; i < 25; i++) { await p.keyboard.press('Tab'); inside.push(await p.evaluate((id) => document.getElementById(id).contains(document.activeElement), s.sheet)) }
  for (let i = 0; i < 10; i++) { await p.keyboard.press('Shift+Tab'); inside.push(await p.evaluate((id) => document.getElementById(id).contains(document.activeElement), s.sheet)) }
  await p.keyboard.press('Escape'); await p.waitForTimeout(500)
  const closed = await p.isHidden(`#${s.sheet}`)
  const back = await p.evaluate((sel) => document.activeElement === document.querySelector(sel), s.opener)
  report.keyboard.push({ sheet: s.sheet, opened, trapped: inside.every(Boolean), closed, focusBack: back })
  await ctx.close()
}
const kb = report.keyboard
check('A3: keyboard — each sheet opens with Enter, Tab and Shift+Tab stay inside (35 presses), Esc closes it, focus returns to the opener',
  kb.every((k) => k.opened && k.trapped && k.closed && k.focusBack), kb.map((k) => `${k.sheet}:${k.opened ? 'o' : '-'}${k.trapped ? 't' : '-'}${k.closed ? 'c' : '-'}${k.focusBack ? 'f' : '-'}`).join(' '))

await app.close()
mkdirSync(resolve(H.ROOT, 'reports'), { recursive: true })
writeFileSync(resolve(H.ROOT, 'reports/a11y.json'), JSON.stringify({ ...report, minContrast: minRatio, texts }, null, 2))
process.exit(finish() ? 0 : 1)
