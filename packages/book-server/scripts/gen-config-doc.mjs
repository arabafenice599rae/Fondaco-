// Writes docs/CONFIG.md from the configuration schema (dist/config.js). --check: exit 1 if the file is out of date.
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { configDoc } from '../dist/config.js'
const file = new URL('../../../docs/CONFIG.md', import.meta.url)
const doc = configDoc() + '\n'
if (process.argv.includes('--check')) {
  if (!existsSync(file) || readFileSync(file, 'utf8') !== doc) { console.error('docs/CONFIG.md is out of date: run pnpm --filter @fondaco/book-server docs:config'); process.exit(1) }
  console.log('docs/CONFIG.md matches the schema')
} else writeFileSync(file, doc)
