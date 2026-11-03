// Loads the repository .env (if present) without overriding variables already set by the shell or CI.
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..')

export function loadEnv() {
  const file = resolve(ROOT, '.env')
  if (existsSync(file)) process.loadEnvFile(file) // never overrides existing process.env keys
  return process.env
}
