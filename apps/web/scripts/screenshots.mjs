// Screenshots of the main views at 390 and 1440 px, from the DEMO=true build (simulated data, "Demo" label visible).
//   node scripts/screenshots.mjs [outDir=../../docs/screenshots]
import { execFileSync } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdtempSync, mkdirSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, extname, resolve } from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const { chromium } = (() => { try { return require('playwright') } catch { return require('/opt/node-tools/node_modules/playwright') } })()
const APP = resolve(fileURLToPath(new URL('.', import.meta.url)), '..')
const OUT = resolve(process.argv[2] ?? resolve(APP, '../../docs/screenshots'))
mkdirSync(OUT, { recursive: true })
const dist = mkdtempSync(join(tmpdir(), 'fondaco-shots-'))
execFileSync(process.execPath, [resolve(APP, 'node_modules/vite/bin/vite.js'), 'build', '--outDir', dist, '--emptyOutDir', '--logLevel', 'error'], { cwd: APP, env: { ...process.env, DEMO: 'true' }, stdio: 'inherit' })
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.woff2': 'font/woff2' }
const web = createServer((req, res) => {
  const p = new URL(req.url, 'http://x').pathname, f = join(dist, p === '/' ? 'index.html' : p)
  if (!f.startsWith(dist) || !existsSync(f)) { res.writeHead(404).end(); return }
  res.writeHead(200, { 'content-type': TYPES[extname(f)] ?? 'application/octet-stream' }).end(readFileSync(f))
})
await new Promise((r) => web.listen(0, '127.0.0.1', r))
const url = `http://127.0.0.1:${web.address().port}/`

const browser = await chromium.launch()
const errors = []
const saved = []
for (const w of [390, 1440]) {
  const ctx = await browser.newContext({ viewport: { width: w, height: w === 390 ? 844 : 900 }, deviceScaleFactor: 2, reducedMotion: 'reduce' })
  await ctx.addInitScript(() => sessionStorage.setItem('fondaco-splash', '1'))
  const p = await ctx.newPage()
  p.on('pageerror', (e) => errors.push(`${w}: ${e.message}`))
  await p.goto(url); await p.waitForTimeout(700)
  // the demo ticker keeps moving: freeze it for stable pictures
  await p.evaluate(() => { const id = setInterval(() => {}, 1e6); for (let i = 1; i <= id; i++) clearInterval(i) })
  const shot = async (name) => { await p.waitForTimeout(350); const f = join(OUT, `${name}-${w}.png`); await p.screenshot({ path: f }); saved.push(f) }
  await shot('scambia')
  await p.fill('#pay-in', '1.500'); await p.waitForTimeout(200)
  await shot('scambia-importo')
  await p.click('#review'); await p.waitForTimeout(900)
  await shot('conferma')
  await p.click('#c-close'); await p.waitForTimeout(400)
  await p.click('[data-m="make"]'); await p.fill('#mk-in', '0,4'); await p.click('[data-mode="custom"]'); await p.fill('#custom-in', '2.400')
  await shot('proponi-avviso')
  await p.fill('#custom-in', '2.510'); await p.click('[data-mode="custom"]')
  await shot('proponi')
  if (w === 390) {
    await p.click('[data-tab="markets"]'); await shot('mercati')
    await p.click('#m-list [data-mkt]'); await p.waitForTimeout(400); await shot('mercato')
    await p.click('[data-tab="offers"]'); await shot('offerte')
  } else {
    await p.locator('#offers-d').scrollIntoViewIfNeeded(); await shot('offerte')
    await p.evaluate(() => window.scrollTo(0, 0))
    const box = await p.locator('#chart').boundingBox()
    if (box) { await p.mouse.move(box.x + box.width * 0.6, box.y + box.height * 0.5); await shot('grafico') }
  }
  await p.click('#wal-chip'); await shot('wallet')
  await p.click('#w-settings'); await p.waitForTimeout(500); await shot('impostazioni')
  await ctx.close()
}
await browser.close(); web.close()
console.log(saved.map((f) => f.slice(OUT.length + 1)).join('\n'))
if (errors.length) { console.error(errors); process.exit(1) }
