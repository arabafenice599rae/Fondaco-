// Visual regression of the main views at 390 and 1440 px (DEMO build, fixed clock, seeded randomness, no periodic
// updates): each screenshot is compared with test/visual/baseline/<name>.png using pixelmatch (per-pixel threshold 0.1);
// the check fails above MAX_DIFF of differing pixels. Baselines change only with an explicit command:
//   node test/visual.mjs --update        (or: pnpm --filter @fondaco/web test:visual:update)
// Differences are written to reports/visual/<name>-diff.png.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { PNG } from 'pngjs'
import pixelmatch from 'pixelmatch'
import * as H from './harness.mjs'
import { STATES, demoApp, enter } from './states.mjs'

export const MAX_DIFF = 0.001 // 0.1 % of the pixels
const UPDATE = process.argv.includes('--update')
const BASE = resolve(H.APP, 'test/visual/baseline'), OUT = resolve(H.ROOT, 'reports/visual')
mkdirSync(BASE, { recursive: true }); mkdirSync(OUT, { recursive: true })
const VIEWS = ['scambia', 'scambia-importo', 'proponi', 'proponi-avvisi', 'mercati', 'mercato', 'offerte', 'conferma', 'wallet', 'impostazioni']
const { check, finish } = H.reporter()
const app = await demoApp()
const rows = []
for (const vp of [[390, 844], [1440, 900]]) {
  for (const id of VIEWS) {
    const st = STATES.find((s) => s.id === id)
    const { p, ctx } = await enter(app, vp, st, { deterministic: true })
    await p.mouse.move(0, 0)
    const name = `${id}-${vp[0]}`
    const shot = await p.screenshot({ animations: 'disabled', caret: 'hide', mask: [p.locator('#toast')] })
    await ctx.close()
    const file = join(BASE, name + '.png')
    if (UPDATE || !existsSync(file)) { writeFileSync(file, shot); rows.push({ name, status: UPDATE ? 'updated' : 'created' }); continue }
    const a = PNG.sync.read(readFileSync(file)), b = PNG.sync.read(shot)
    if (a.width !== b.width || a.height !== b.height) { rows.push({ name, status: 'size', ratio: 1 }); continue }
    const diff = new PNG({ width: a.width, height: a.height })
    const n = pixelmatch(a.data, b.data, diff.data, a.width, a.height, { threshold: 0.1 })
    const ratio = n / (a.width * a.height)
    if (n) writeFileSync(join(OUT, name + '-diff.png'), PNG.sync.write(diff))
    rows.push({ name, status: ratio <= MAX_DIFF ? 'same' : 'changed', ratio })
  }
}
// V0 self-test: a planted visual change (the main button's colour) must be caught against its baseline
if (!UPDATE && existsSync(join(BASE, 'scambia-390.png'))) {
  const { p, ctx } = await enter(app, [390, 844], STATES.find((x) => x.id === 'scambia'), { deterministic: true })
  await p.addStyleTag({ content: '.cta { background: #1f7a3a !important }' }); await p.mouse.move(0, 0)
  const shot = await p.screenshot({ animations: 'disabled', caret: 'hide', mask: [p.locator('#toast')] })
  await ctx.close()
  const a = PNG.sync.read(readFileSync(join(BASE, 'scambia-390.png'))), b = PNG.sync.read(shot)
  const n = pixelmatch(a.data, b.data, null, a.width, a.height, { threshold: 0.1 })
  check('V0: self-test — a planted change of the main button colour exceeds the threshold', n / (a.width * a.height) > MAX_DIFF, `${((n / (a.width * a.height)) * 100).toFixed(2)}% of pixels`)
}
await app.close()
const created = rows.filter((r) => r.status === 'created' || r.status === 'updated')
if (created.length) console.log(`baselines ${UPDATE ? 'updated' : 'created'}: ${created.map((r) => r.name).join(', ')}`)
const bad = rows.filter((r) => r.status === 'changed' || r.status === 'size')
check(`V1: ${rows.length} screenshots (${VIEWS.length} views × 390/1440) match the baseline within ${MAX_DIFF * 100}% of pixels`, bad.length === 0 && (UPDATE || created.length < rows.length),
  bad.map((r) => `${r.name} ${(r.ratio * 100).toFixed(2)}%`).join(', ') || `max ${(Math.max(0, ...rows.map((r) => r.ratio ?? 0)) * 100).toFixed(3)}%`)
writeFileSync(join(OUT, 'result.json'), JSON.stringify(rows, null, 2))
process.exit(finish() ? 0 : 1)
