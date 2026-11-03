// Indexed fills on the fork: /trades (newest first, taker side, price), /candles (OHLCV buckets, prev price, ETag/304),
// SSE 'trade', rollback of fills on a reorg; governance: protocolFeeLight in /config, SSE 'governance' on admin events;
// markets derived from the whitelist.
import { createPublicClient, createWalletClient, createTestClient, http, parseAbi, encodeAbiParameters, keccak256, toHex, parseEther } from 'viem'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import { deploy } from '@fondaco/contracts/deploy'
import { swapErc20Abi } from '@fondaco/contracts'
import { start } from '../dist/index.js'

const FORK_URL = process.env.FORK_URL || 'http://127.0.0.1:8545'
const USDC = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', WETH = '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2', ZERO = '0x0000000000000000000000000000000000000000'
const chain = { id: 1, name: 'fork', nativeCurrency: { name: 'ETH', symbol: 'ETH', decimals: 18 }, rpcUrls: { default: { http: [FORK_URL] } } }
const pub = createPublicClient({ chain, transport: http(FORK_URL), cacheTime: 0 })
const test = createTestClient({ chain, mode: 'anvil', transport: http(FORK_URL) })
const ERC20 = parseAbi(['function approve(address,uint256)', 'function deposit() payable'])
const results = []
const check = (n, ok, d = '') => { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'} | ${n}${d ? ' | ' + d : ''}`) }
const wait = async (h) => { const rc = await pub.waitForTransactionReceipt({ hash: h }); if (rc.status !== 'success') throw new Error('reverted'); return rc }
async function wallet() { const account = privateKeyToAccount(generatePrivateKey()); await test.setBalance({ address: account.address, value: parseEther('100') }); return { account, address: account.address, client: createWalletClient({ account, chain, transport: http(FORK_URL) }) } }
const U = (n) => BigInt(Math.round(n * 1e6)), W = (n) => BigInt(Math.round(n * 1e6)) * 10n ** 12n

const pk = generatePrivateKey()
await test.setBalance({ address: privateKeyToAccount(pk).address, value: parseEther('10') })
const safe = privateKeyToAccount(generatePrivateKey()).address
const startBlock = await pub.getBlockNumber()
const { swap: SWAP } = await deploy({ rpc: FORK_URL, privateKey: pk, feeBps: 30, feeWallet: safe, owner: safe, log: () => {} })
const [alice, bob] = [await wallet(), await wallet()]
for (const w of [alice, bob]) {
  await test.setStorageAt({ address: USDC, index: keccak256(encodeAbiParameters([{ type: 'address' }, { type: 'uint256' }], [w.address, 9n])), value: toHex(10n ** 12n, { size: 32 }) })
  await wait(await w.client.writeContract({ address: WETH, abi: ERC20, functionName: 'deposit', value: 20n * 10n ** 18n }))
  for (const t of [USDC, WETH]) await wait(await w.client.writeContract({ address: t, abi: ERC20, functionName: 'approve', args: [SWAP, 2n ** 256n - 1n] }))
}
const app = await start({ port: 0, db: ':memory:', rateLimit: { capacity: 1e6, refillPerSec: 1e6 },
  chains: { 1: { rpc: FORK_URL, swap: SWAP, startBlock: (await pub.getBlockNumber()).toString(), pollMs: 3_600_000, fullSweepMs: 3_600_000,
    tokens: { [WETH]: { symbol: 'WETH', decimals: 18 }, [USDC]: { symbol: 'USDC', decimals: 6 } } } } }, { log: () => {} })
const { engine } = app
const base = `http://127.0.0.1:${app.server.address().port}`
const get = async (path, headers = {}) => { const r = await fetch(base + path, { headers }); return { status: r.status, etag: r.headers.get('etag'), body: r.status === 200 ? await r.json() : null } }
const cfg = (await get('/config')).body[1]
const tick = () => engine.tick(1)
check('T1: /config — markets derived from the whitelist (WETH/USDC, quote USDC), protocolFeeLight = protocolFee', cfg.markets.length === 1 && cfg.markets[0].base === WETH && cfg.markets[0].quote === USDC &&
  cfg.protocolFeeLight === '30' && cfg.protocolFee === '30', JSON.stringify(cfg.markets))

// SSE
const sse = []
const ctrl = new AbortController()
fetch(base + '/stream', { signal: ctrl.signal }).then(async (r) => { const rd = r.body.getReader(); for (;;) { const { value, done } = await rd.read(); if (done) break; sse.push(Buffer.from(value).toString()) } }).catch(() => {})

let nonce = 1n
async function sign(w, signerToken, signerAmount, senderToken, senderAmount) {
  const now = (await pub.getBlock()).timestamp
  const message = { nonce: nonce++, expiry: now + 86400n, signerWallet: w.address, signerToken, signerAmount, protocolFee: 30n, senderWallet: ZERO, senderToken, senderAmount }
  const sig = await w.account.signTypedData({ domain: cfg.domain, types: cfg.types, primaryType: 'OrderERC20', message })
  const o = { ...Object.fromEntries(Object.entries(message).map(([k, x]) => [k, String(x)])), v: parseInt(sig.slice(130, 132), 16), r: '0x' + sig.slice(2, 66), s: '0x' + sig.slice(66, 130) }
  const [r] = await engine.submit(1, [o]); if (!r.hash) throw new Error(JSON.stringify(r))
  return o
}
const fill = async (o) => wait(await bob.client.writeContract({ address: SWAP, abi: swapErc20Abi, functionName: 'swapAnySender',
  args: [bob.address, BigInt(o.nonce), BigInt(o.expiry), o.signerWallet, o.signerToken, BigInt(o.signerAmount), o.senderToken, BigInt(o.senderAmount), o.v, o.r, o.s] }))

// three fills: two asks taken (taker BUYS WETH at 2500 and 2510) in one 5-min bucket, then a bid taken (taker SELLS at 2490) 10 min later
const a1 = await sign(alice, WETH, W(0.1), USDC, U(250)), a2 = await sign(alice, WETH, W(0.2), USDC, U(502)), b1 = await sign(alice, USDC, U(249), WETH, W(0.1))
await tick()
const t0 = Number((await pub.getBlock()).timestamp)
const bucket = Math.floor(t0 / 300) * 300
await test.setNextBlockTimestamp({ timestamp: BigInt(bucket + 300 + 10) }) // start of a fresh bucket
await fill(a1)
await test.setNextBlockTimestamp({ timestamp: BigInt(bucket + 300 + 70) })
await fill(a2)
await tick()
await test.setNextBlockTimestamp({ timestamp: BigInt(bucket + 900 + 5) })
await fill(b1)
await tick()
const tr = await get(`/trades?chainId=1&base=${WETH}&quote=${USDC}`)
const t = tr.body.trades
check('T2: /trades newest first, taker side and price from the signed amounts (buy 2500, buy 2510, sell 2490)', t.length === 3 && t[0].side === 'sell' && Math.abs(t[0].price - 2490) < 1e-9 &&
  t[1].side === 'buy' && Math.abs(t[1].price - 2510) < 1e-9 && t[2].side === 'buy' && Math.abs(t[2].price - 2500) < 1e-9 && t[2].base === 0.1 && t[0].ts === bucket + 905,
  t.map((x) => `${x.side}@${x.price}`).join(', '))

const cd = await get(`/candles?chainId=1&base=${WETH}&quote=${USDC}&interval=300&limit=288`)
const k = cd.body.candles
check('T3: /candles — 5-min OHLCV buckets (open 2500, high 2510, low 2500, close 2510, volume 0.3) then a bucket at 2490; prev null', k.length === 2 && k[0].t === bucket + 300 &&
  k[0].o === 2500 && k[0].h === 2510 && k[0].l === 2500 && k[0].c === 2510 && k[0].v === 0.3 && k[0].n === 2 && k[1].t === bucket + 900 && k[1].c === 2490 && cd.body.prev === null && cd.body.interval === 300,
  JSON.stringify(k.map((x) => [x.t - bucket, x.o, x.h, x.l, x.c, x.v])))
const narrow = await get(`/candles?chainId=1&base=${WETH}&quote=${USDC}&interval=300&limit=1`)
check('T3b: a window that starts after earlier fills carries the previous price in prev (window = current bucket: 2490; prev = 2510)', narrow.body.candles.length === 1 && narrow.body.candles[0].c === 2490 && narrow.body.prev === 2510, `prev ${narrow.body.prev}`)

// ETag / 304 and change after a new fill
const n304 = (await get(`/candles?chainId=1&base=${WETH}&quote=${USDC}`, { 'if-none-match': cd.etag })).status
const t304 = (await get(`/trades?chainId=1&base=${WETH}&quote=${USDC}`, { 'if-none-match': tr.etag })).status
const a3 = await sign(alice, WETH, W(0.1), USDC, U(252))
await tick()
await fill(a3)
await tick()
const after = await get(`/candles?chainId=1&base=${WETH}&quote=${USDC}`, { 'if-none-match': cd.etag })
check('T4: ETag → 304 while unchanged (trades and candles); a new fill changes it (200)', n304 === 304 && t304 === 304 && after.status === 200 && after.etag !== cd.etag, `${n304}/${t304} → ${after.status}`)
await new Promise((r) => setTimeout(r, 200))
check('T5: SSE pushes a trade event for every indexed fill', sse.join('').split('event: trade').length - 1 === 4)

// reorg removes the fills of abandoned blocks
const snap = await test.snapshot()
const a4 = await sign(alice, WETH, W(0.1), USDC, U(260))
await tick()
await fill(a4)
await tick()
const before = (await get(`/trades?chainId=1&base=${WETH}&quote=${USDC}`)).body.trades.length
await test.revert({ id: snap })
await test.mine({ blocks: 3 })
await tick()
const tr6 = await get(`/trades?chainId=1&base=${WETH}&quote=${USDC}`)
check('T6: reorg → fills of the abandoned branch removed from /trades (and the ETag moves)', before === 5 && tr6.body.trades.length === 4 && !tr6.body.trades.some((x) => x.price === 2600), `${before} → ${tr6.body.trades.length}`)

// governance
await test.impersonateAccount({ address: safe })
await test.setBalance({ address: safe, value: parseEther('1') })
const sw = createWalletClient({ account: safe, chain, transport: http(FORK_URL) })
await wait(await sw.writeContract({ address: SWAP, abi: swapErc20Abi, functionName: 'setProtocolFeeLight', args: [25n] }))
await tick()
const cfg7 = (await get('/config')).body[1]
await new Promise((r) => setTimeout(r, 200))
const gov = sse.join('').split('event: governance\ndata: ').slice(1).map((x) => JSON.parse(x.split('\n')[0]))
check('T7: setProtocolFeeLight → /config protocolFeeLight 25 ≠ protocolFee 30, SSE governance event with the new value', cfg7.protocolFeeLight === '25' && cfg7.protocolFee === '30' &&
  gov.some((g) => g.event === 'SetProtocolFeeLight' && g.args.protocolFeeLight === '25'), JSON.stringify(gov))
await wait(await sw.writeContract({ address: SWAP, abi: swapErc20Abi, functionName: 'transferOwnership', args: [bob.address] }))
await tick()
await new Promise((r) => setTimeout(r, 200))
const gov2 = sse.join('').split('event: governance\ndata: ').slice(1).map((x) => JSON.parse(x.split('\n')[0]))
check('T8: ownership transfer → SSE governance event (OwnershipTransferred)', gov2.some((g) => g.event === 'OwnershipTransferred' && g.args.newOwner.toLowerCase() === bob.address.toLowerCase()))
const bad = await get(`/candles?chainId=1&base=${WETH}&quote=0x6B175474E89094C44Da98b954EedeAC495271d0F`)
check('T9: candles/trades for a non-whitelisted pair → 400', bad.status === 400)

ctrl.abort()
await app.stop()
const failed = results.filter((x) => !x).length
console.log(`\n${results.length - failed}/${results.length} checks passed`)
process.exit(failed ? 1 : 0)
