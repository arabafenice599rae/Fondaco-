// /metrics on a local mainnet fork: off by default; protected by network allowlist or bearer token (never X-Forwarded-For);
// metric values: RPC per round (idle / incremental / full), round duration, orders by status, reorgs, API latency; JSON logs.
import { createPublicClient, createWalletClient, createTestClient, http, parseAbi, encodeAbiParameters, keccak256, toHex, parseEther } from 'viem'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import { deploy } from '@fondaco/contracts/deploy'
import { start } from '../dist/index.js'

const FORK_URL = process.env.FORK_URL || 'http://127.0.0.1:8545'
const USDC = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', WETH = '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2'
const chain = { id: 1, name: 'fork', nativeCurrency: { name: 'ETH', symbol: 'ETH', decimals: 18 }, rpcUrls: { default: { http: [FORK_URL] } } }
const pub = createPublicClient({ chain, transport: http(FORK_URL) })
const test = createTestClient({ chain, mode: 'anvil', transport: http(FORK_URL) })
const ERC20 = parseAbi(['function approve(address,uint256)', 'function transfer(address,uint256)'])
const results = []
const check = (n, ok, d = '') => { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'} | ${n}${d ? ' | ' + d : ''}`) }
const TOKEN = 'metrics-token-0123456789abcdef'

const pk = generatePrivateKey()
await test.setBalance({ address: privateKeyToAccount(pk).address, value: parseEther('10') })
const startBlock = await pub.getBlockNumber()
const { swap: SWAP } = await deploy({ rpc: FORK_URL, privateKey: pk, feeBps: 30, feeWallet: privateKeyToAccount(generatePrivateKey()).address, owner: privateKeyToAccount(generatePrivateKey()).address, log: () => {} })
const alice = privateKeyToAccount(generatePrivateKey())
await test.setBalance({ address: alice.address, value: parseEther('10') })
const aw = createWalletClient({ account: alice, chain, transport: http(FORK_URL) })
await test.setStorageAt({ address: USDC, index: keccak256(encodeAbiParameters([{ type: 'address' }, { type: 'uint256' }], [alice.address, 9n])), value: toHex(10n ** 12n, { size: 32 }) })
await pub.waitForTransactionReceipt({ hash: await aw.writeContract({ address: USDC, abi: ERC20, functionName: 'approve', args: [SWAP, 2n ** 256n - 1n] }) })

const base = (extra = {}) => ({
  port: 0, db: ':memory:', rateLimit: { capacity: 1000, refillPerSec: 100 },
  chains: { 1: { rpc: FORK_URL, swap: SWAP, startBlock: startBlock.toString(), pollMs: 3_600_000, fullSweepMs: 3_600_000,
    tokens: { [USDC]: { symbol: 'USDC', decimals: 6 }, [WETH]: { symbol: 'WETH', decimals: 18 } } } },
  ...extra,
})
const url = (app) => `http://127.0.0.1:${app.server.address().port}`

// X1 off by default
const off = await start(base(), { log: () => {} })
const r1 = await fetch(`${url(off)}/metrics`)
await off.stop()
check('X1: /metrics is off by default (404)', r1.status === 404)

// X2 token only (empty allowlist), with trustProxy=1 so X-Forwarded-For is read for rate limits — but never for /metrics
const logs = []
const app = await start(base({ trustProxy: 1, metrics: { enabled: true, token: TOKEN, allow: [] } }), { log: (l) => logs.push(JSON.parse(l)) })
const m = (h = {}) => fetch(`${url(app)}/metrics`, { headers: h })
const codes = [(await m()).status, (await m({ authorization: 'Bearer wrong-token-0123456789' })).status, (await m({ 'x-forwarded-for': '127.0.0.1' })).status]
const ok2 = await m({ authorization: `Bearer ${TOKEN}` })
check('X2: no token / wrong token / spoofed X-Forwarded-For → 401; right bearer token → 200 Prometheus text', codes.every((c) => c === 401) && ok2.status === 200 &&
  ok2.headers.get('content-type') === 'text/plain; version=0.0.4; charset=utf-8', `${codes.join(',')} → ${ok2.status}`)

// X3 allowlisted network without token
const lan = await start(base({ metrics: { enabled: true, allow: ['127.0.0.0/8'] } }), { log: () => {} })
const r3 = await fetch(`${url(lan)}/metrics`)
await lan.stop()
check('X3: allowlisted source network (127.0.0.0/8) reads /metrics without a token', r3.status === 200)

// metric values
const scrape = async () => (await m({ authorization: `Bearer ${TOKEN}` })).text()
const val = (text, line) => { const l = text.split('\n').find((x) => x.startsWith(line + ' ')); return l ? Number(l.split(' ').pop()) : null }
const tick = async () => { while (app.engine.chain(1).busy) await new Promise((r) => setTimeout(r, 20)); return app.engine.tick(1) }
const cfg = (await (await fetch(`${url(app)}/config`)).json())[1]
let nonce = 1n
async function bid(usdc) {
  const now = (await pub.getBlock()).timestamp
  const message = { nonce: nonce++, expiry: now + 3600n, signerWallet: alice.address, signerToken: USDC, signerAmount: usdc, protocolFee: 30n, senderWallet: '0x0000000000000000000000000000000000000000', senderToken: WETH, senderAmount: 4n * 10n ** 16n }
  const sig = await alice.signTypedData({ domain: cfg.domain, types: cfg.types, primaryType: 'OrderERC20', message })
  return { ...Object.fromEntries(Object.entries(message).map(([k, x]) => [k, String(x)])), v: parseInt(sig.slice(130, 132), 16), r: '0x' + sig.slice(2, 66), s: '0x' + sig.slice(66, 130) }
}
await fetch(`${url(app)}/orders`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ chainId: 1, orders: [await bid(100n * 10n ** 6n), await bid(101n * 10n ** 6n)] }) })
await tick() // first round = full sweep
await tick() // idle
await aw.writeContract({ address: USDC, abi: ERC20, functionName: 'transfer', args: ['0x000000000000000000000000000000000000dEaD', 10n ** 12n - 150n * 10n ** 6n] })
await test.mine({ blocks: 1 })
await tick() // incremental: a Transfer of a live signer
for (let i = 0; i < 5; i++) await fetch(`${url(app)}/book?chainId=1&base=${WETH}&quote=${USDC}`)
const t = await scrape()
const L = (k) => `{chain="1",kind="${k}"}`
const idleRpc = val(t, `fondaco_tick_rpc_requests_sum${L('idle')}`) / val(t, `fondaco_tick_rpc_requests_count${L('idle')}`)
const incRpc = val(t, `fondaco_tick_rpc_requests_sum${L('incremental')}`) / val(t, `fondaco_tick_rpc_requests_count${L('incremental')}`)
const fullN = val(t, `fondaco_ticks_total${L('full')}`)
check('X4: RPC per round measured by kind (idle = 1 request, incremental ≈ 4), full sweeps counted, round duration recorded',
  idleRpc === 1 && incRpc >= 2 && incRpc <= 6 && fullN >= 1 && val(t, `fondaco_tick_duration_seconds_count${L('incremental')}`) >= 1 && val(t, 'fondaco_rpc_requests_total{chain="1"}') > 0,
  `idle ${idleRpc} RPC, incremental ${incRpc} RPC, full ${fullN}×`)
const st = Object.fromEntries(app.db.countByStatus().map((r) => [r.status, r.n]))
check('X5: orders by status = database counts; API latency histogram per route; SSE gauge; head and indexed block',
  Object.entries(st).every(([s, n]) => val(t, `fondaco_orders{chain="1",status="${s}"}`) === n) && val(t, 'fondaco_http_request_duration_seconds_count{route="GET /book",code="200"}') >= 5 &&
  val(t, 'fondaco_sse_clients') === 0 && val(t, 'fondaco_chain_head_block{chain="1"}') >= Number(startBlock) && val(t, 'fondaco_indexed_block{chain="1"}') >= Number(startBlock), JSON.stringify(st))

// X6 reorg counted and logged
const snap = await test.snapshot()
await test.mine({ blocks: 2 })
await tick()
await test.revert({ id: snap })
await test.mine({ blocks: 3 })
await tick()
const t6 = await scrape()
check('X6: reorg counter and structured warn log', val(t6, 'fondaco_reorgs_total{chain="1"}') === 1 && logs.some((l) => l.level === 'warn' && l.msg === 'reorg' && l.chainId === 1),
  `reorgs ${val(t6, 'fondaco_reorgs_total{chain="1"}')}`)
check('X7: startup log is JSON with url, chains and metrics flag', logs.some((l) => l.msg === 'book listening' && l.metrics === true && Array.isArray(l.chains) && typeof l.ts === 'string'))

await app.stop()
const failed = results.filter((x) => !x).length
console.log(`\n${results.length - failed}/${results.length} checks passed`)
process.exit(failed ? 1 : 0)
