// IPFS for the web app's static build (kubo CLI, no long-running node).
//   node tools/ipfs.mjs cid <dir>              CID (v1, raw leaves) of the directory, computed offline: no upload
//   node tools/ipfs.mjs pin <dir> --confirm    upload through an IPFS Pinning Service API provider (PUBLISHES the build:
//                                              irreversible, run only after explicit approval). A temporary kubo node adds
//                                              the files, the provider fetches them from it, the command returns when pinned.
// env: IPFS_BIN (default `ipfs`), PINNING_ENDPOINT (e.g. https://api.pinata.cloud/psa), PINNING_TOKEN, PIN_NAME
// The CID depends only on the bytes: the reproducible build (tools/build-hash.mjs) gives the same CID on every machine.
import { execFileSync, spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const BIN = process.env.IPFS_BIN || 'ipfs'
const ADD = ['--cid-version', '1', '--raw-leaves', '-r', '-Q']
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
function repo() {
  const dir = mkdtempSync(join(tmpdir(), 'ipfs-repo-'))
  const env = { ...process.env, IPFS_PATH: dir }
  execFileSync(BIN, ['init', '--profile', 'test'], { env, stdio: 'ignore' })
  return { dir, env, run: (...a) => execFileSync(BIN, a, { env, encoding: 'utf8' }).trim() }
}
export function cid(dir) {
  const r = repo()
  try { return r.run('add', '--only-hash', ...ADD, resolve(dir)) } finally { rmSync(r.dir, { recursive: true, force: true }) }
}
async function pin(dir) {
  if (!process.argv.includes('--confirm')) throw new Error('pin publishes the build: pass --confirm (after explicit approval)')
  const { PINNING_ENDPOINT: ep, PINNING_TOKEN: token, PIN_NAME: name = 'fondaco-web' } = process.env
  if (!ep || !token) throw new Error('PINNING_ENDPOINT and PINNING_TOKEN are required')
  const r = repo()
  // the "test" profile has no swarm listeners: re-enable the default ones so the provider can fetch from this node
  r.run('config', '--json', 'Addresses.Swarm', '["/ip4/0.0.0.0/tcp/0","/ip4/0.0.0.0/udp/0/quic-v1"]')
  r.run('config', '--json', 'Bootstrap', JSON.stringify(['/dnsaddr/bootstrap.libp2p.io/p2p/QmNnooDu7bfjPFoTZYxMNLWUQJyrVwtbZg5gBMjTezGAJN']))
  const c = r.run('add', ...ADD, resolve(dir))
  const d = spawn(BIN, ['daemon'], { env: r.env, stdio: 'ignore' })
  try {
    for (let i = 0; i < 60; i++) { try { r.run('id'); break } catch { await sleep(500) } }
    r.run('pin', 'remote', 'service', 'add', 'fondaco', ep, token)
    r.run('pin', 'remote', 'add', '--service=fondaco', `--name=${name}`, c) // waits until the provider reports "pinned"
    const st = r.run('pin', 'remote', 'ls', '--service=fondaco', `--cid=${c}`, '--status=pinned')
    if (!st.includes(c)) throw new Error(`provider does not report ${c} as pinned: ${st}`)
    return c
  } finally { d.kill(); rmSync(r.dir, { recursive: true, force: true }) }
}
if (import.meta.url === `file://${process.argv[1]}`) {
  const [cmd, dir] = process.argv.slice(2)
  const f = cmd === 'cid' ? async () => cid(dir) : cmd === 'pin' ? () => pin(dir) : null
  if (!f || !dir) { console.error('usage: ipfs.mjs cid|pin <dir> [--confirm]'); process.exit(2) }
  f().then((c) => console.log(c)).catch((e) => { console.error(e.message); process.exit(1) })
}
