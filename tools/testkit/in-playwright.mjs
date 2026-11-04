#!/usr/bin/env node
// Runs a command inside the pinned Playwright image (tools/ci/toolchain.json → playwrightImage.ref), the image the CI
// web-e2e job runs in. The visual baselines are generated and compared only there (D-54), so they are one set for every
// machine. The repository is mounted at the same path; on linux-x64 the host's Node (the .nvmrc version) and Foundry are
// mounted too, otherwise the image's Node is used.
//   node tools/testkit/in-playwright.mjs <command> [args…]
//   e.g. node tools/testkit/in-playwright.mjs node apps/web/test/visual.mjs --update
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { foundryBin } from './anvil.js'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
export const PW_IMAGE = JSON.parse(readFileSync(resolve(ROOT, 'tools/ci/toolchain.json'), 'utf8')).playwrightImage.ref

/** Arguments for `docker run` (exported for the visual suite, which re-runs itself in the image). */
export function dockerArgs(cmd, { cwd = process.cwd() } = {}) {
  const a = ['run', '--rm', '--init', '--ipc=host', '--network', 'host', '-v', `${ROOT}:${ROOT}`, '-w', cwd,
    '-e', `FONDACO_PW_IMAGE=${PW_IMAGE}`, '-e', 'PLAYWRIGHT_BROWSERS_PATH=/ms-playwright', '-e', 'HOME=/tmp', '-e', 'CI']
  if (process.getuid) a.push('--user', `${process.getuid()}:${process.getgid()}`)
  let path = '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin'
  if (process.platform === 'linux' && process.arch === 'x64') {
    a.push('-v', `${resolve(dirname(process.execPath), '..')}:/opt/fondaco-node:ro`); path = `/opt/fondaco-node/bin:${path}`
    const anvil = foundryBin('anvil'), foundry = dirname(anvil)
    if (anvil !== 'anvil' && existsSync(anvil)) a.push('-v', `${foundry}:/opt/fondaco-foundry:ro`, '-e', 'ANVIL_BIN=/opt/fondaco-foundry/anvil', '-e', 'FORGE_BIN=/opt/fondaco-foundry/forge', '-e', 'CAST_BIN=/opt/fondaco-foundry/cast')
  }
  a.push('-e', `PATH=${path}`)
  for (const k of ['MAINNET_RPC_URL', 'FORK_BLOCK', 'HTTPS_PROXY', 'HTTP_PROXY', 'NO_PROXY', 'https_proxy', 'http_proxy', 'no_proxy', 'NODE_EXTRA_CA_CERTS']) if (process.env[k]) a.push('-e', k)
  if (process.env.NODE_EXTRA_CA_CERTS && existsSync(process.env.NODE_EXTRA_CA_CERTS)) a.push('-v', `${process.env.NODE_EXTRA_CA_CERTS}:${process.env.NODE_EXTRA_CA_CERTS}:ro`)
  // FONDACO_PW_DOCKER_ARGS: extra `docker run` arguments for the local machine (e.g. a corporate CA), space-separated
  if (process.env.FONDACO_PW_DOCKER_ARGS) a.push(...process.env.FONDACO_PW_DOCKER_ARGS.split(' ').filter(Boolean))
  return [...a, PW_IMAGE, ...cmd]
}

/** Runs `cmd` in the image, inheriting stdio; returns the exit code. */
export function runInImage(cmd, opts) {
  const r = spawnSync('docker', dockerArgs(cmd, opts), { stdio: 'inherit' })
  if (r.error) { console.error(`docker is needed to run this in ${PW_IMAGE}: ${r.error.message}`); return 2 }
  return r.status ?? 1
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const cmd = process.argv.slice(2)
  if (!cmd.length) { console.error('usage: node tools/testkit/in-playwright.mjs <command> [args…]'); process.exit(2) }
  process.exit(runInImage(cmd))
}
