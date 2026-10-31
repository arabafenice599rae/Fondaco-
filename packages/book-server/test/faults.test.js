// Fault injection through a scriptable RPC proxy in front of the fork: timeouts, 429/5xx, partial multicall results,
// missing blocks, out-of-order logs, failover. Expected: fail-closed (never 'open' without verification, never a terminal
// status from a failed read), no crash, recovery once the RPC behaves.
import { createPublicClient, createWalletClient, createTestClient, http, parseAbi, encodeAbiParameters, keccak256, toHex, parseEther, decodeFunctionData,
  decodeFunctionResult, encodeFunctionResult, toFunctionSelector, multicall3Abi } from 'viem'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import { deploy } from '@fondaco/contracts/deploy'
import { startRpcProxy } from '@fondaco/testkit'
import { start } from '../dist/index.js'

const FORK_URL = process.env.FORK_URL || 'http://127.0.0.1:8545'
const USDC = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', WETH = '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2'
const chain = { id: 1, name: 'fork', nativeCurrency: { name: 'ETH', symbol: 'ETH', decimals: 18 }, rpcUrls: { default: { http: [FORK_URL] } } }
const pub = createPublicClient({ chain, transport: http(FORK_URL) })
const test = createTestClient({ chain, mode: 'anvil', transport: http(FORK_URL) })
const ERC20 = parseAbi(['function approve(address,uint256)', 'function transfer(address,uint256)'])
const results = []
const check = (n, ok, d = '') => { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'} | ${n}${d ? ' | ' + d : ''}`) }
const SEL = { nonceUsed: toFunctionSelector('nonceUsed(address,uint256)'), authorized: toFunctionSelector('authorized(address)'), balanceOf: toFunctionSelector('balanceOf(address)') }

const pk = generatePrivateKey()
await test.setBalance({ address: privateKeyToAccount(pk).address, value: parseEther('10') })
const startBlock = await pub.getBlockNumber()
const { swap: SWAP } = await deploy({ rpc: FORK_URL, privateKey: pk, feeBps: 30, feeWallet: privateKeyToAccount(generatePrivateKey()).address, owner: privateKeyToAccount(generatePrivateKey()).address, log: () => {} })
const alice = privateKeyToAccount(generatePrivateKey())
await test.setBalance({ address: alice.address, value: parseEther('10') })
const aw = createWalletClient({ account: alice, chain, transport: http(FORK_URL) })
await test.setStorageAt({ address: USDC, index: keccak256(encodeAbiParameters([{ type: 'address' }, { type: 'uint256' }], [alice.address, 9n])), value: toHex(10n ** 12n, { size: 32 }) })
await pub.waitForTransactionReceipt({ hash: await aw.writeContract({ address: USDC, abi: ERC20, functionName: 'approve', args: [SWAP, 2n ** 256n - 1n] }) })

const proxy = await startRpcProxy(FORK_URL)
const logs = []
const app = await start({
  port: 0, db: ':memory:', rateLimit: { capacity: 10000, refillPerSec: 1000 }, log: { level: 'debug' },
  chains: { 1: { rpc: ['http://127.0.0.1:1', proxy.url], rpcTimeoutMs: 400, maxStalenessMs: 3000, swap: SWAP, startBlock: startBlock.toString(), pollMs: 3_600_000, fullSweepMs: 3_600_000,
    tokens: { [USDC]: { symbol: 'USDC', decimals: 6 }, [WETH]: { symbol: 'WETH', decimals: 18 } } } },
}, { log: (l) => logs.push(JSON.parse(l)) })
const { engine } = app
const base = `http://127.0.0.1:${app.server.address().port}`
const cfg = (await (await fetch(`${base}/config`)).json())[1]
const tick = async () => { while (engine.chain(1).busy) await new Promise((r) => setTimeout(r, 20)); try { return { ok: true, r: await engine.tick(1) } } catch (e) { return { ok: false, e } } }
const statuses = () => Object.fromEntries(engine.db.bySigner(1, alice.address).map((r) => [r.hash, r.status]))
let nonce = 1n
async function bid(usdc) {
  const now = (await pub.getBlock()).timestamp
  const message = { nonce: nonce++, expiry: now + 3600n, signerWallet: alice.address, signerToken: USDC, signerAmount: usdc, protocolFee: 30n, senderWallet: '0x0000000000000000000000000000000000000000', senderToken: WETH, senderAmount: 4n * 10n ** 16n }
  const sig = await alice.signTypedData({ domain: cfg.domain, types: cfg.types, primaryType: 'OrderERC20', message })
  return { ...Object.fromEntries(Object.entries(message).map(([k, x]) => [k, String(x)])), v: parseInt(sig.slice(130, 132), 16), r: '0x' + sig.slice(2, 66), s: '0x' + sig.slice(66, 130) }
}
const submit = async (os) => (await (await fetch(`${base}/orders`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ chainId: 1, orders: os }) })).json()).results

/** after-hook: make the multicall sub-calls whose selector is in `sels` fail (success = false). */
const failSubcalls = (sels) => async (req, result) => {
  if (req.method !== 'eth_call' || !req.params?.[0]?.data?.startsWith(toFunctionSelector('aggregate3((address,bool,bytes)[])'))) return result
  const { args: [calls] } = decodeFunctionData({ abi: multicall3Abi, data: req.params[0].data })
  const out = decodeFunctionResult({ abi: multicall3Abi, functionName: 'aggregate3', data: result })
  return encodeFunctionResult({ abi: multicall3Abi, functionName: 'aggregate3', result: out.map((o, i) => (sels.includes(calls[i].callData.slice(0, 10)) ? { success: false, returnData: '0x' } : o)) })
}

const hs = (await submit([await bid(100n * 10n ** 6n), await bid(101n * 10n ** 6n)])).map((r) => r.hash)
await tick()
const s0 = statuses()
check('F0: baseline through the proxy (first RPC in the list is dead: automatic failover)', hs.every((h) => s0[h] === 'open') && proxy.counts.eth_call > 0, JSON.stringify(Object.values(s0)))

// F1 timeouts: the multicall hangs → round fails, no crash, statuses unchanged; recovers after
proxy.set({ before: (req) => (req.method === 'eth_call' ? { hang: true } : undefined) })
await test.mine({ blocks: 1 })
const t0 = Date.now(), f1 = await engine.revalidate(1).then(() => ({ ok: true }), (e) => ({ ok: false, e }))
proxy.clear()
const f1b = await tick()
check('F1: hanging RPC → the round fails after the timeout (no crash, nothing changed), the next round recovers', !f1.ok && Date.now() - t0 < 30_000 && f1b.ok && hs.every((h) => statuses()[h] === 'open'),
  `failed after ${((Date.now() - t0) / 1000).toFixed(1)} s: ${f1.e?.shortMessage ?? f1.e?.message}`)

// F2 429 / 5xx: transient ones are retried; persistent ones fail the round, then recovery
let n429 = 0
proxy.set({ before: (req) => (req.method === 'eth_call' && n429++ < 2 ? { status: n429 === 1 ? 429 : 503 } : undefined) })
await test.mine({ blocks: 1 })
const f2a = await engine.revalidate(1).then(() => true, () => false)
proxy.set({ before: () => ({ status: 503 }) })
const f2b = await tick()
proxy.clear()
const f2c = await tick()
check('F2: one 429 + one 503 are retried transparently; a persistent 503 fails the round without crashing; recovery afterwards', f2a && !f2b.ok && f2c.ok && hs.every((h) => statuses()[h] === 'open'))

// F3 partial multicall: nonceUsed unreadable → must NOT stay open (unverified) and must NOT become terminal
proxy.set({ after: failSubcalls([SEL.nonceUsed]) })
await engine.revalidate(1)
const s3 = statuses()
proxy.clear()
await engine.revalidate(1)
const s3b = statuses()
check('F3: unreadable nonceUsed in a partial multicall → orders not open (fail-closed), not terminal; open again once readable',
  hs.every((h) => s3[h] === 'unfunded') && hs.every((h) => s3b[h] === 'open'), `${Object.values(s3)} → ${Object.values(s3b)}`)

// F4 partial multicall: authorized() unreadable → must NOT become invalid_signer (terminal since A-02)
proxy.set({ after: failSubcalls([SEL.authorized]) })
await engine.revalidate(1)
const s4 = statuses()
proxy.clear()
await engine.revalidate(1)
const s4b = statuses()
check('F4: unreadable authorized() → orders unfunded for the round, never invalid_signer; open again afterwards',
  hs.every((h) => s4[h] === 'unfunded') && hs.every((h) => s4b[h] === 'open'), `${Object.values(s4)} → ${Object.values(s4b)}`)

// F5 partial multicall during intake: a new order whose nonce cannot be read is refused (not stored as open)
proxy.set({ after: failSubcalls([SEL.nonceUsed]) })
const [r5] = await submit([await bid(102n * 10n ** 6n)])
proxy.clear()
check('F5: intake with an unreadable nonceUsed → refused with a retryable error, nothing stored', r5.error === 'chain_unavailable' && !r5.hash, `${r5.error}: ${r5.message}`)

// F6 missing block (null) → round fails, recovers
proxy.set({ after: (req, result) => (req.method === 'eth_getBlockByNumber' ? null : result) })
await test.mine({ blocks: 1 })
const f6 = await tick()
proxy.clear()
const f6b = await tick()
check('F6: missing block (null) → the round fails cleanly, the next one recovers', !f6.ok && f6b.ok, f6.e?.shortMessage ?? f6.e?.message)

// F7 out-of-order logs: a fill and an allowance change in the same range, logs returned reversed → same result
const fillArgs = async (o) => [alice.address, BigInt(o.nonce), BigInt(o.expiry), o.signerWallet, o.signerToken, BigInt(o.signerAmount), o.senderToken, BigInt(o.senderAmount), o.v, o.r, o.s]
const o7 = await bid(103n * 10n ** 6n)
const [h7] = (await submit([o7])).map((r) => r.hash)
await tick()
const bob = privateKeyToAccount(generatePrivateKey())
await test.setBalance({ address: bob.address, value: parseEther('10') })
const bw = createWalletClient({ account: bob, chain, transport: http(FORK_URL) })
await bw.writeContract({ address: WETH, abi: parseAbi(['function deposit() payable']), functionName: 'deposit', value: 10n ** 18n })
await bw.writeContract({ address: WETH, abi: ERC20, functionName: 'approve', args: [SWAP, 2n ** 256n - 1n] })
const SwapAbi = (await import('@fondaco/contracts')).swapErc20Abi
await pub.waitForTransactionReceipt({ hash: await bw.writeContract({ address: SWAP, abi: SwapAbi, functionName: 'swapAnySender', args: await fillArgs(o7) }) })
await pub.waitForTransactionReceipt({ hash: await aw.writeContract({ address: USDC, abi: ERC20, functionName: 'approve', args: [SWAP, 201n * 10n ** 6n] }) })
proxy.set({ after: (req, result) => (req.method === 'eth_getLogs' && Array.isArray(result) ? [...result].reverse() : result) })
await tick()
proxy.clear()
const s7 = statuses()
// allowance 201 USDC covers only the first order (100 USDC + fee): the second (101 + fee) no longer fits
check('F7: logs delivered out of order → fill indexed, allowance change applied, same result as in order', s7[h7] === 'filled' && s7[hs[0]] === 'open' && s7[hs[1]] === 'unfunded', JSON.stringify(Object.values(s7)))

// F9 long outage: once verification is older than maxStalenessMs, /book refuses (503 stale) instead of serving old offers
const bookUrl = `${base}/book?chainId=1&base=${WETH}&quote=${USDC}`
await tick()
const b9a = (await fetch(bookUrl)).status
proxy.set({ before: () => ({ status: 503 }) })
await new Promise((r) => setTimeout(r, 3200))
await tick()
const r9 = await fetch(bookUrl), b9b = r9.status, e9 = (await r9.json()).error
proxy.clear()
await tick()
const b9c = (await fetch(bookUrl)).status
check('F9: outage longer than maxStalenessMs → /book 503 stale (fail-closed); served again after a successful round', b9a === 200 && b9b === 503 && e9 === 'stale' && b9c === 200, `${b9a} → ${b9b} ${e9} → ${b9c}`)

// F8 the polling loop survives failing rounds: each failure is a structured error log and a metric, then it recovers
const loopLogs = []
const loopApp = await start({
  port: 0, db: ':memory:', chains: { 1: { rpc: proxy.url, rpcTimeoutMs: 400, swap: SWAP, startBlock: startBlock.toString(), pollMs: 150,
    tokens: { [USDC]: { symbol: 'USDC', decimals: 6 }, [WETH]: { symbol: 'WETH', decimals: 18 } } } },
}, { log: (l) => loopLogs.push(JSON.parse(l)) })
const okTicks = () => loopApp.metrics.render().split('\n').filter((l) => l.startsWith('fondaco_ticks_total{')).reduce((n, l) => n + Number(l.split(' ').pop()), 0)
proxy.set({ before: () => ({ status: 503 }) })
await new Promise((r) => setTimeout(r, 300)) // let an in-flight round finish
const okAtOutage = okTicks()
const until = async (cond, ms) => { const t = Date.now(); while (!cond() && Date.now() - t < ms) await new Promise((r) => setTimeout(r, 50)) }
await until(() => loopLogs.filter((l) => l.msg === 'tick error').length >= 2, 15_000)
proxy.clear()
const errs = loopLogs.filter((l) => l.msg === 'tick error').length
const errMetric = loopApp.metrics.render().split('\n').find((l) => l.startsWith('fondaco_tick_errors_total{chain="1"}'))
const okDuringOutage = okTicks() - okAtOutage
await test.mine({ blocks: 1 })
await until(() => okTicks() > okAtOutage, 10_000)
const recovered = okDuringOutage === 0 && okTicks() > okAtOutage
await loopApp.stop()
check('F8: polling loop keeps running through failing rounds (JSON error logs + fondaco_tick_errors_total), then recovers',
  errs >= 2 && loopLogs.filter((l) => l.msg === 'tick error').every((l) => l.level === 'error' && typeof l.error === 'string' && l.chain === 1) && !!errMetric && recovered,
  `${errs} error lines; ${errMetric}`)

await app.stop()
await proxy.close()
const failed = results.filter((x) => !x).length
console.log(`\n${results.length - failed}/${results.length} checks passed`)
process.exit(failed ? 1 : 0)
