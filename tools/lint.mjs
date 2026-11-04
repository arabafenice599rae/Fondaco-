// Lightweight lint, no dependencies: every JS/MJS file parses (node --check), and the sources carry no debugging
// leftovers: no `debugger`, no `.only(` in tests, no console.log in production sources (packages/*/src, apps/web/src).
// Types are checked by `pnpm typecheck` (strict TypeScript); generated files by `pnpm check:generated`.
import { execFileSync } from 'node:child_process'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)), '..')
const SKIP = /(^|\/)(node_modules|dist|dist-demo|\.cache|reports|foundry\/(lib|out|cache)|\.git)(\/|$)/
const walk = (d) => readdirSync(d).flatMap((f) => { const p = join(d, f), r = relative(ROOT, p); if (SKIP.test(r)) return []; return statSync(p).isDirectory() ? walk(p) : [r] })
const all = walk(ROOT)
const problems = []
for (const f of all.filter((f) => /\.(mjs|js)$/.test(f) && !f.startsWith('apps/web/public/'))) {
  try { execFileSync(process.execPath, ['--check', join(ROOT, f)], { stdio: 'pipe' }) } catch (e) { problems.push(`${f}: syntax: ${String(e.stderr).split('\n').find(Boolean)}`) }
}
for (const f of all.filter((f) => /\.(ts|mjs|js)$/.test(f))) {
  const src = readFileSync(join(ROOT, f), 'utf8')
  if (/^\s*debugger\s*;?\s*$/m.test(src)) problems.push(`${f}: debugger statement`)
  if (/\b(describe|it|test)\.only\(/.test(src)) problems.push(`${f}: .only( in a test`)
  if (/^(packages\/[^/]+\/src|apps\/web\/src)\//.test(f) && /console\.log\(/.test(src)) problems.push(`${f}: console.log in production source`)
}
const n = all.filter((f) => /\.(ts|mjs|js)$/.test(f)).length
for (const p of problems) console.log('FAIL | ' + p)
console.log(`${problems.length ? 'FAIL' : 'PASS'} | lint: ${n} files, ${problems.length} problems`)
console.log(`\n${problems.length ? 0 : 1}/1 checks passed`)
process.exit(problems.length ? 1 : 0)
