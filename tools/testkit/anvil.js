// Starts a local anvil node that forks Ethereum mainnet at a FIXED block (reproducible state, cached on disk by anvil).
// The upstream RPC comes from MAINNET_RPC_URL; it is only read from, never sent transactions.
import { spawn } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { createServer } from 'node:net'
import { loadEnv, ROOT } from './env.js'

/** The fixed fork (block, chain) lives in fork.config.json at the repository root: same baseline locally and in CI. */
export const FORK_CONFIG = JSON.parse(readFileSync(resolve(ROOT, 'fork.config.json'), 'utf8'))

/** Foundry binaries: ANVIL_BIN / FORGE_BIN, then ~/.foundry/bin, then /opt/tools/bin, then PATH. */
export function foundryBin(name) {
  const env = process.env[`${name.toUpperCase()}_BIN`]
  if (env) return env
  for (const p of [`${process.env.HOME}/.foundry/bin/${name}`, `/opt/tools/bin/${name}`]) if (existsSync(p)) return p
  return name
}

export const freePort = () => new Promise((res, rej) => {
  const s = createServer()
  s.unref()
  s.on('error', rej)
  s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => res(port)) })
})

async function waitReady(url, child, timeoutMs) {
  const t0 = Date.now()
  for (;;) {
    if (child.exitCode != null) throw new Error(`anvil exited with code ${child.exitCode}`)
    try {
      const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_chainId', params: [] }) })
      if (r.ok) return
    } catch { /* not up yet */ }
    if (Date.now() - t0 > timeoutMs) throw new Error('anvil did not become ready')
    await new Promise((r) => setTimeout(r, 150))
  }
}

/**
 * @param opts { port?, forkUrl?, forkBlock?, chainId = 1, extraArgs = [], log? }
 * @returns { url, port, forkBlock, stop() }
 */
export async function startFork(opts = {}) {
  const env = loadEnv()
  const forkUrl = opts.forkUrl ?? env.MAINNET_RPC_URL
  if (!forkUrl) throw new Error('MAINNET_RPC_URL is not set (see .env.example): an archive-capable mainnet RPC is required to fork')
  const forkBlock = BigInt(opts.forkBlock ?? FORK_CONFIG.forkBlock)
  const port = opts.port ?? (await freePort())
  const args = [
    '--fork-url', forkUrl, '--fork-block-number', forkBlock.toString(), '--chain-id', String(opts.chainId ?? FORK_CONFIG.chainId),
    '--port', String(port), '--host', '127.0.0.1',
    // free/public RPCs throttle: retry patiently instead of failing a test run
    '--retries', '10', '--fork-retry-backoff', '1000', '--timeout', '60000',
    ...(opts.extraArgs ?? []),
  ]
  const child = spawn(foundryBin('anvil'), args, { stdio: ['ignore', 'pipe', 'pipe'] })
  const out = []
  child.stdout.on('data', (d) => { out.push(String(d)); if (out.length > 200) out.shift(); opts.log?.(String(d)) })
  child.stderr.on('data', (d) => { out.push(String(d)); opts.log?.(String(d)) })
  const url = `http://127.0.0.1:${port}`
  try { await waitReady(url, child, opts.readyTimeoutMs ?? 60_000) } catch (e) { child.kill('SIGKILL'); throw new Error(`${e.message}\n${out.join('')}`) }
  return {
    url, port, forkBlock,
    output: () => out.join(''),
    stop: () => new Promise((r) => { if (child.exitCode != null) return r(); child.once('exit', () => r()); child.kill('SIGTERM') }),
  }
}
