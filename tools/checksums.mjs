// SHA256SUMS of the artefacts the project ships unchanged: the contract fixture, the audit report and its diffs, the fonts.
//   node tools/checksums.mjs           verify every listed file (exit 1 on any mismatch, missing or unlisted file)
//   node tools/checksums.mjs --write   regenerate the SHA256SUMS files (review the diff before committing)
// Same format as `sha256sum`, so `sha256sum -c SHA256SUMS` works in each directory.
import { createHash } from 'node:crypto'
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)), '..')
export const DIRS = [
  { dir: 'packages/contracts/fixtures', match: /\.json$/ },
  { dir: 'docs/audits', match: /\.(pdf|diff)$/ },
  { dir: 'apps/web/src/fonts', match: /\.(woff2|txt)$/ },
]
const sha = (f) => createHash('sha256').update(readFileSync(f)).digest('hex')
const results = []
const check = (n, ok, d = '') => { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'} | ${n}${d ? ' | ' + d : ''}`) }
for (const { dir, match } of DIRS) {
  const abs = join(ROOT, dir), sums = join(abs, 'SHA256SUMS')
  const files = readdirSync(abs).filter((f) => match.test(f)).sort()
  if (process.argv.includes('--write')) { writeFileSync(sums, files.map((f) => `${sha(join(abs, f))}  ${f}`).join('\n') + '\n'); console.log(`written ${dir}/SHA256SUMS (${files.length} files)`) }
  if (!existsSync(sums)) { check(`${dir}: SHA256SUMS present`, false); continue }
  const listed = Object.fromEntries(readFileSync(sums, 'utf8').trim().split('\n').map((l) => { const [h, f] = l.split(/\s+\*?/); return [f, h] }))
  const bad = files.filter((f) => listed[f] !== sha(join(abs, f))).concat(Object.keys(listed).filter((f) => !files.includes(f)).map((f) => `${f} (missing)`))
  check(`${dir}: ${files.length} files match SHA256SUMS`, bad.length === 0, bad.join(', '))
}
const p = results.filter(Boolean).length
console.log(`\n${p}/${results.length} checks passed`)
process.exit(p === results.length ? 0 : 1)
