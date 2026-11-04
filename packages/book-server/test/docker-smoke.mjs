// Smoke test of the book image and the compose stack, self-contained (no external RPC, no secrets):
//   anvil (local chain) + SwapERC20 from the fixture + an S3 stub that VERIFIES SigV4 on every request, all on the host;
//   docker compose (deploy/compose.yaml + compose.smoke.yaml): book + Caddy (TLS, localhost CA) + backup.
// Checks /health, /config and /book through Caddy over HTTPS, a backup uploaded (signature verified by the stub),
// `backup list` and `backup restore` inside the backup container, log rotation configured. Tears everything down.
//   node packages/book-server/test/docker-smoke.mjs [image]          (default fondaco-book:smoke, built beforehand)
import { spawn, execFileSync, execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { createServer } from 'node:http'
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createPublicClient, createWalletClient, http, getAddress } from 'viem'
import { signV4 } from '../scripts/backup.mjs'
import { foundryBin, freePort } from '../../../tools/testkit/anvil.js'

const ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)), '../../..')
const [repo, tag] = (process.argv[2] || 'fondaco-book:smoke').split(':')
const results = []
const check = (n, ok, d = '') => { results.push(!!ok); console.log(`${ok ? 'PASS' : 'FAIL'} | ${n}${d ? ' | ' + d : ''}`) }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const dir = mkdtempSync(join(tmpdir(), 'book-smoke-'))
const project = 'fondacosmoke' + process.pid

// ---------------------------------------------------------------- chain
const port = await freePort()
const anvil = spawn(foundryBin('anvil'), ['--host', '0.0.0.0', '--port', String(port), '--chain-id', '31337', '--silent'], { stdio: 'ignore' })
const chain = { id: 31337, name: 'anvil', nativeCurrency: { name: 'ETH', symbol: 'ETH', decimals: 18 }, rpcUrls: { default: { http: [`http://127.0.0.1:${port}`] } } }
const pub = createPublicClient({ chain, transport: http() })
for (let i = 0; i < 50; i++) { try { await pub.getChainId(); break } catch { await sleep(200) } }
const [acct] = await pub.request({ method: 'eth_accounts' })
const art = JSON.parse(readFileSync(resolve(ROOT, 'packages/contracts/fixtures/SwapERC20.json'), 'utf8'))
const wc = createWalletClient({ account: getAddress(acct), chain, transport: http() })
const rc = await pub.waitForTransactionReceipt({ hash: await wc.deployContract({ abi: art.abi, bytecode: art.bytecode, args: [30n, 30n, getAddress(acct), 0n, 0n] }) })
const swap = rc.contractAddress

// ---------------------------------------------------------------- S3 stub (path-style, SigV4 verified)
const CRED = { accessKeyId: 'SMOKETESTKEY', secretAccessKey: 'smoke-test-secret', region: 'us-east-1' }
const objects = new Map(); let badSig = 0
const s3port = await freePort()
const s3 = createServer(async (req, res) => {
  const chunks = []; for await (const c of req) chunks.push(c)
  const body = Buffer.concat(chunks)
  const url = `http://${req.headers.host}${req.url}`
  const extra = {}
  const date = req.headers['x-amz-date']
  const d = new Date(`${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6, 8)}T${date.slice(9, 11)}:${date.slice(11, 13)}:${date.slice(13, 15)}Z`)
  const want = signV4({ method: req.method, url, body, date: d, extra, ...CRED }).headers.authorization
  if (req.headers.authorization !== want) { badSig++; res.writeHead(403).end('SignatureDoesNotMatch'); return }
  const u = new URL(url), key = decodeURIComponent(u.pathname.replace(/^\/bucket\/?/, ''))
  if (req.method === 'PUT') { objects.set(key, body); res.writeHead(200).end(); return }
  if (req.method === 'DELETE') { objects.delete(key); res.writeHead(204).end(); return }
  if (req.method === 'GET' && u.searchParams.get('list-type') === '2') {
    const p = u.searchParams.get('prefix') ?? ''
    res.writeHead(200, { 'content-type': 'application/xml' }).end(`<ListBucketResult>${[...objects.keys()].filter((k) => k.startsWith(p)).map((k) => `<Contents><Key>${k}</Key></Contents>`).join('')}</ListBucketResult>`); return
  }
  if (req.method === 'GET' && objects.has(key)) { res.writeHead(200).end(objects.get(key)); return }
  res.writeHead(404).end()
})
await new Promise((r) => s3.listen(s3port, '0.0.0.0', r))

// ---------------------------------------------------------------- compose
const A = '0x00000000000000000000000000000000000000a1', Bt = '0x00000000000000000000000000000000000000b2'
writeFileSync(join(dir, 'book.json'), JSON.stringify({ port: 8080, host: '0.0.0.0', db: '/data/book.sqlite', trustProxy: 1,
  chains: { 31337: { rpc: `http://host.docker.internal:${port}`, swap, startBlock: Number(rc.blockNumber), pollMs: 500, tokens: { [A]: { symbol: 'AAA', decimals: 18 }, [Bt]: { symbol: 'BBB', decimals: 6 } } } } }))
const httpsPort = await freePort()
const env = { ...process.env, BOOK_IMAGE: repo, BOOK_VERSION: tag, DOMAIN: 'localhost', SMOKE_DIR: dir, SMOKE_HTTPS_PORT: String(httpsPort),
  S3_ENDPOINT: `http://host.docker.internal:${s3port}`, S3_BUCKET: 'bucket', S3_ACCESS_KEY_ID: CRED.accessKeyId, S3_SECRET_ACCESS_KEY: CRED.secretAccessKey }
const compose = (...a) => execFileSync('docker', ['compose', '-p', project, '-f', resolve(ROOT, 'deploy/compose.yaml'), '-f', resolve(ROOT, 'deploy/compose.smoke.yaml'), ...a], { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
// async: the S3 stub lives in this process, a synchronous exec would block it (and hang the backup container)
const composeAsync = async (...a) => (await promisify(execFile)('docker', ['compose', '-p', project, '-f', resolve(ROOT, 'deploy/compose.yaml'), '-f', resolve(ROOT, 'deploy/compose.smoke.yaml'), ...a], { env, encoding: 'utf8' })).stdout
const get = async (path) => { try { const out = (await promisify(execFile)('curl', ['-sk', '-m', '5', '-w', '\n%{http_code}', `https://localhost:${httpsPort}${path}`], { encoding: 'utf8' })).stdout; const i = out.lastIndexOf('\n'); return { status: Number(out.slice(i + 1)), body: out.slice(0, i) } } catch { return { status: 0, body: '' } } }
try {
  compose('up', '-d')
  let h = { status: 0 }
  for (let i = 0; i < 60 && h.status !== 200; i++) { await sleep(1000); h = await get('/health') }
  check('S1: /health through Caddy over HTTPS (local CA)', h.status === 200 && JSON.parse(h.body).ok === true, `HTTP ${h.status}`)
  const cfg = await get('/config'), bk = await get(`/book?chainId=31337&base=${A}&quote=${Bt}`)
  check('S2: /config and /book through the proxy (book indexing the local chain)', cfg.status === 200 && JSON.parse(cfg.body)['31337']?.swap?.toLowerCase() === swap.toLowerCase() && bk.status === 200 && Array.isArray(JSON.parse(bk.body).asks),
    `config ${cfg.status}, book ${bk.status}`)
  for (let i = 0; i < 40 && objects.size === 0; i++) await sleep(500)
  const key = [...objects.keys()][0] ?? ''
  check('S3: hourly backup job uploaded a gzip snapshot; every S3 request carried a valid SigV4 signature', objects.size === 1 && /^book\/book-.*\.sqlite\.gz$/.test(key) && badSig === 0, `${key} (${objects.get(key)?.length ?? 0} bytes), bad signatures ${badSig}`)
  const listed = (await composeAsync('exec', '-T', 'backup', 'node', 'scripts/backup.mjs', 'list')).trim()
  const restored = await composeAsync('exec', '-T', 'backup', 'node', 'scripts/backup.mjs', 'restore', 'latest', '/tmp/restored.sqlite')
  check('S4: backup list and restore (download, integrity_check) work inside the container', listed === key && /"msg":"restored"/.test(restored), restored.trim().slice(0, 120))
  const ids = compose('ps', '-q').trim().split('\n')
  const logcfg = ids.map((id) => JSON.parse(execFileSync('docker', ['inspect', id, '--format', '{{json .HostConfig.LogConfig}}'], { encoding: 'utf8' })))
  check('S5: log rotation on every service (json-file, 10m × 5)', logcfg.length === 3 && logcfg.every((l) => l.Type === 'json-file' && l.Config['max-size'] === '10m' && l.Config['max-file'] === '5'))
  const user = execFileSync('docker', ['inspect', `${project}-book-1`, '--format', '{{.Config.User}}'], { encoding: 'utf8' }).trim()
  const bindings = JSON.parse(execFileSync('docker', ['inspect', `${project}-book-1`, '--format', '{{json .HostConfig.PortBindings}}'], { encoding: 'utf8' }))
  check('S6: the book runs as the unprivileged "node" user, with no port published on the host', user === 'node' && Object.keys(bindings ?? {}).length === 0, `user ${user}, bindings ${JSON.stringify(bindings)}`)
} catch (e) {
  check('S!: unexpected error', false, String(e.stderr || e.message).slice(0, 300))
  try { console.log(compose('logs', '--no-color', '--tail', '40')) } catch {}
} finally {
  try { compose('down', '-v', '--remove-orphans') } catch {}
  anvil.kill(); s3.close()
}
const p = results.filter(Boolean).length
console.log(`\n${p}/${results.length} checks passed`)
process.exit(p === results.length ? 0 : 1)
