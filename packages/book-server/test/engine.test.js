// Engine hardening & performance on a local mainnet fork (hardhat, chainId 1):
// event-driven revalidation, WETH deposit/withdraw, idle ticks, reorg rollback, expiry buffer, dust/fee floor,
// capacity, ETag, HTTP limits, private listings, client keys.
import { readFileSync } from 'node:fs'
import net from 'node:net'
import { createPublicClient, createWalletClient, createTestClient, http, parseAbi, encodeAbiParameters, keccak256, toHex, getAddress } from 'viem'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import { start } from '../dist/index.js'
import { clientKeys, rateLimiter } from '../dist/index.js'

const FORK_URL = process.env.FORK_URL || 'http://127.0.0.1:8545'
const USDC = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48'
const WETH = '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2'
const ZERO = '0x0000000000000000000000000000000000000000'
const FEE = 30n
const chain = { id: 1, name: 'fork', nativeCurrency: { name: 'ETH', symbol: 'ETH', decimals: 18 }, rpcUrls: { default: { http: [FORK_URL] } } }
const transport = () => http(FORK_URL, { timeout: 180_000 })
const ERC20 = parseAbi(['function approve(address,uint256)', 'function transfer(address,uint256)', 'function balanceOf(address) view returns (uint256)', 'function deposit() payable', 'function withdraw(uint256)'])
const pub = createPublicClient({ chain, transport: transport() })
const test = createTestClient({ chain, mode: 'hardhat', transport: transport() })
const SwapArt = JSON.parse(readFileSync(new URL(import.meta.resolve('@fondaco/contracts/fixtures/SwapERC20.json'))))
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const results = []
const check = (n, ok, d = '') => { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'} | ${n}${d ? ' | ' + d : ''}`) }

async function wallet() {
  const account = privateKeyToAccount(generatePrivateKey())
  await test.setBalance({ address: account.address, value: 10n ** 21n })
  return { account, address: account.address, client: createWalletClient({ account, chain, transport: transport() }) }
}
async function send(w, req) {
  const rc = await pub.waitForTransactionReceipt({ hash: await w.client.writeContract(req) })
  if (rc.status !== 'success') throw new Error('tx reverted')
  return rc
}
const giveUsdc = (addr, amount) => test.setStorageAt({ address: USDC, index: keccak256(encodeAbiParameters([{ type: 'address' }, { type: 'uint256' }], [addr, 9n])), value: toHex(amount, { size: 32 }) })
const U = (n) => BigInt(n) * 10n ** 6n

async function main() {
  const [owner, alice, bob, carol, feeWallet, sink] = await Promise.all(Array.from({ length: 6 }, wallet))
  const SWAP = getAddress((await pub.waitForTransactionReceipt({ hash: await owner.client.deployContract({ abi: SwapArt.abi, bytecode: SwapArt.bytecode, args: [FEE, FEE, feeWallet.address, 0n, 0n] }) })).contractAddress)
  const startBlock = await pub.getBlockNumber()
  for (const w of [alice, bob, carol]) {
    await giveUsdc(w.address, U(1_000_000))
    await send(w, { address: USDC, abi: ERC20, functionName: 'approve', args: [SWAP, 2n ** 256n - 1n] })
  }
  await send(alice, { address: WETH, abi: ERC20, functionName: 'deposit', value: 10n ** 19n })
  await send(alice, { address: WETH, abi: ERC20, functionName: 'approve', args: [SWAP, 2n ** 256n - 1n] })

  const config = {
    port: 0, db: ':memory:', rateLimit: { capacity: 5000, refillPerSec: 1000 }, ssePerClient: 4,
    chains: { 1: { rpc: FORK_URL, swap: SWAP, startBlock: startBlock.toString(), pollMs: 3_600_000, fullSweepMs: 3_600_000, minExpirySec: 10, maxExpirySec: 7 * 86400,
      expiryBufferSec: 30, maxLiveOrders: 200,
      tokens: { [USDC]: { symbol: 'USDC', decimals: 6, min: '1000000' }, [WETH]: { symbol: 'WETH', decimals: 18 } } } },
  }
  const app = await start(config, { log: () => {} })
  const { engine, counter } = app
  const base = `http://127.0.0.1:${app.server.address().port}`
  const api = async (method, path, body, headers = {}) => {
    const r = await fetch(base + path, { method, headers: { 'content-type': 'application/json', ...headers }, body: body ? JSON.stringify(body) : undefined })
    return { status: r.status, headers: r.headers, body: r.status === 304 ? null : await r.json() }
  }
  const cfg = (await api('GET', '/config')).body[1]
  const tick = async () => { while (engine.chain(1).busy) await sleep(20); return engine.tick(1) }
  const rpc = async (fn) => { const b = counter.n[1] || 0; const r = await fn(); return { r, calls: (counter.n[1] || 0) - b } }

  let nonceSeq = 1n
  async function sign(w, o) {
    const now = (await pub.getBlock()).timestamp
    const message = { nonce: nonceSeq++, expiry: now + 3600n, signerWallet: w.address, protocolFee: FEE, senderWallet: ZERO, ...o }
    const sig = await w.account.signTypedData({ domain: cfg.domain, types: cfg.types, primaryType: 'OrderERC20', message })
    return { ...Object.fromEntries(Object.entries(message).map(([k, x]) => [k, String(x)])), v: parseInt(sig.slice(130, 132), 16), r: '0x' + sig.slice(2, 66), s: '0x' + sig.slice(66, 130) }
  }
  const bid = (w, usdc, weth, extra = {}) => sign(w, { signerToken: USDC, signerAmount: usdc, senderToken: WETH, senderAmount: weth, ...extra })
  const ask = (w, weth, usdc, extra = {}) => sign(w, { signerToken: WETH, signerAmount: weth, senderToken: USDC, senderAmount: usdc, ...extra })
  const submit = async (orders) => (await api('POST', '/orders', { chainId: 1, orders: [orders].flat() })).body.results
  const status = async (h) => (await api('GET', `/orders/${h}`)).body.status

  // background liquidity: 150 orders from 15 signers (they must NOT be re-read on unrelated changes)
  const crowd = await Promise.all(Array.from({ length: 15 }, wallet))
  for (const w of crowd) { await giveUsdc(w.address, U(100_000)); await send(w, { address: USDC, abi: ERC20, functionName: 'approve', args: [SWAP, 2n ** 256n - 1n] }) }
  const many = []
  for (const w of crowd) for (let i = 0; i < 10; i++) many.push(await bid(w, U(100 + i), 4n * 10n ** 16n))
  for (let i = 0; i < many.length; i += 50) await submit(many.slice(i, i + 50))
  const [hA] = (await submit(await bid(alice, U(500), 2n * 10n ** 17n))).map((r) => r.hash)
  await tick() // first tick = full sweep (startup)

  // H1 event-driven: alice moves her USDC away → only alice's pair is re-read, cost independent of book size
  const full = await rpc(() => engine.revalidate(1))
  await send(alice, { address: USDC, abi: ERC20, functionName: 'transfer', args: [sink.address, U(1_000_000)] })
  const inc = await rpc(tick)
  const sA = await status(hA)
  check('H1: transfer out → only the touched pair re-read (event-driven), order unfunded', sA === 'unfunded' && inc.r.full === false && inc.r.checked === 1 && full.r.checked > 150,
    `incremental: ${inc.r.checked} order(s), ${inc.calls} RPC; full sweep: ${full.r.checked} orders, ${full.calls} RPC`)
  await giveUsdc(alice.address, U(1_000_000)) // storage write: no event → only the full sweep can see it
  const t1b = await tick()
  const s1b = await status(hA)
  await engine.revalidate(1)
  const s1c = await status(hA)
  check('H1b: change without an event (storage write ≈ blacklist/pause) is caught by the full sweep', t1b.checked === 0 && s1b === 'unfunded' && s1c === 'open', `${s1b} → ${s1c}`)

  // H2 WETH9 moves balances with Deposit/Withdrawal, not Transfer
  const [hW] = (await submit(await ask(alice, 9n * 10n ** 18n, U(22_500)))).map((r) => r.hash)
  await send(alice, { address: WETH, abi: ERC20, functionName: 'withdraw', args: [10n ** 18n] })
  await tick()
  const s2a = await status(hW)
  await send(alice, { address: WETH, abi: ERC20, functionName: 'deposit', value: 10n ** 18n })
  await tick()
  const s2b = await status(hW)
  check('H2: WETH Withdrawal → unfunded, Deposit → open (incremental)', s2a === 'unfunded' && s2b === 'open', `${s2a} → ${s2b}`)

  // H3 idle tick: no new block → one request (head), nothing else
  await tick()
  const idle = await rpc(tick)
  check('H3: idle tick costs 1 RPC request', idle.calls === 1, `${idle.calls} request(s)`)

  // H4 reorg: a fill on a block that is then replaced → order back to open, 'reorg' event
  const oR = await bid(carol, U(200), 8n * 10n ** 16n)
  const [hR] = (await submit(oR)).map((r) => r.hash)
  const snapId = await test.snapshot()
  await send(bob, { address: WETH, abi: ERC20, functionName: 'deposit', value: 10n ** 17n })
  await send(bob, { address: WETH, abi: ERC20, functionName: 'approve', args: [SWAP, 2n ** 256n - 1n] })
  await send(bob, { address: SWAP, abi: SwapArt.abi, functionName: 'swapAnySender', args: [bob.address, BigInt(oR.nonce), BigInt(oR.expiry), oR.signerWallet, oR.signerToken, BigInt(oR.signerAmount), oR.senderToken, BigInt(oR.senderAmount), oR.v, oR.r, oR.s] })
  await tick()
  const s4a = await status(hR)
  let reorg = null
  engine.once('reorg', (e) => { reorg = e })
  await test.revert({ id: snapId })
  await test.mine({ blocks: 4 })
  await tick()
  const s4b = await status(hR)
  check('H4: reorg detected (block hash mismatch) → fill rolled back, order open again', s4a === 'filled' && s4b === 'open' && reorg?.rolledBack >= 1, `${s4a} → reorg (rolled back ${reorg?.rolledBack}) → ${s4b}`)

  // H5 expiry buffer: an order expiring within 30 s is open but not offered in the book
  const now5 = (await pub.getBlock()).timestamp
  const [h5] = (await submit(await bid(carol, U(300), 10n ** 17n, { expiry: now5 + 20n }))).map((r) => r.hash)
  const bk5 = (await api('GET', `/book?chainId=1&base=${WETH}&quote=${USDC}&limit=200`)).body
  check('H5: near-expiry order hidden from the book (expiry buffer)', (await status(h5)) === 'open' && !bk5.bids.some((b) => b.hash === h5))

  // H6 dust: fee rounds to zero / below token minimum
  const r6a = await submit(await sign(carol, { signerToken: WETH, signerAmount: 300n, senderToken: USDC, senderAmount: U(2) }))
  const r6b = await submit(await bid(carol, 500_000n, 10n ** 14n))
  check('H6: fee-free dust and below-minimum orders rejected', r6a[0].error === 'fee_too_small' && r6b[0].error === 'amount_too_small', `${r6a[0].error}, ${r6b[0].error}`)

  // H7 ETag / 304; a status change produces a new ETag
  const p7 = `/book?chainId=1&base=${WETH}&quote=${USDC}`
  const b7 = await api('GET', p7)
  const e7 = b7.headers.get('etag')
  const n7 = await api('GET', p7, null, { 'if-none-match': e7 })
  await send(carol, { address: SWAP, abi: SwapArt.abi, functionName: 'cancel', args: [[BigInt(oR.nonce)]] })
  await tick()
  const c7 = await api('GET', p7, null, { 'if-none-match': e7 })
  check('H7: book ETag → 304 when unchanged, 200 with new ETag after a change', !!e7 && n7.status === 304 && c7.status === 200 && c7.headers.get('etag') !== e7)

  // H8 HTTP hardening: JSON content type required; per-client SSE cap
  const r8 = await fetch(base + '/orders', { method: 'POST', headers: { 'content-type': 'text/plain' }, body: JSON.stringify({ chainId: 1, orders: [{}] }) })
  const ctrls = [], codes = []
  for (let i = 0; i < 5; i++) { const c = new AbortController(); ctrls.push(c); codes.push((await fetch(base + '/stream', { signal: c.signal })).status) }
  ctrls.forEach((c) => c.abort())
  check('H8: text/plain POST → 415; 5th SSE stream from one client → 503', r8.status === 415 && codes.slice(0, 4).every((s) => s === 200) && codes[4] === 503, `post ${r8.status}, streams ${codes.join(',')}`)

  // H9 slow headers: a client that never finishes its headers is cut off (headersTimeout)
  const t9 = Date.now()
  let got9 = ''
  const closed = await new Promise((resolve) => {
    const s = net.connect(app.server.address().port, '127.0.0.1', () => s.write('GET /health HTTP/1.1\r\nHost: x\r\n'))
    s.on('data', (d) => { got9 = String(d).split('\r\n')[0] })
    s.on('close', () => resolve(true)); s.on('error', () => resolve(true))
    setTimeout(() => { s.destroy(); resolve(false) }, 45_000)
  })
  check('H9: slowloris connection closed by the server', closed, `after ${((Date.now() - t9) / 1000).toFixed(0)} s ${got9}; sse=${app.server.sseClients.size} conns=${await new Promise((r) => app.server.getConnections((e, n) => r(n)))}`)

  // H10 private orders: listed by signer without signature, full by hash
  const [hP] = (await submit(await bid(carol, U(50), 2n * 10n ** 16n, { senderWallet: bob.address }))).map((r) => r.hash)
  const listed = (await api('GET', `/orders?chainId=1&signer=${carol.address}`)).body.orders.find((o) => o.hash === hP)
  const byHash = (await api('GET', `/orders/${hP}`)).body
  check('H10: private order listed without signature, full order only by hash', listed && listed.order.r === undefined && byHash.order.r?.length === 66)

  // H11 capacity: maxLiveOrders
  const live = engine.db.countLive(1)
  const over = []
  for (let i = 0; i < 50; i++) over.push(await bid(bob, U(10), 4n * 10n ** 15n))
  const r11 = await submit(over)
  check('H11: book capacity enforced (book_full)', live + 50 > 200 && r11.every((r) => r.error === 'book_full'), `live ${live} + 50 > cap 200`)

  // H12 client keys & limiter: XFF ignored without trustProxy; with trustProxy=1 prepended entries cannot spoof; IPv6 /48 cap
  const req = (a, x) => ({ socket: { remoteAddress: a }, headers: x ? { 'x-forwarded-for': x } : {} })
  const k1 = clientKeys(req('9.9.9.9', '1.1.1.1'), 0)[0], k2 = clientKeys(req('10.0.0.1', 'evil, 2.2.2.2'), 1)[0]
  const lim = rateLimiter({ capacity: 3, refillPerSec: 0, maxKeys: 100 })
  const wide = rateLimiter({ capacity: 48, refillPerSec: 0 })
  let granted = 0
  for (let i = 0; i < 1000; i++) {
    const ks = clientKeys(req(`2001:db8:1:${i.toString(16)}::1`))
    if (lim(ks[0]) && wide(ks[1])) granted++
  }
  check('H12: XFF spoofing ignored; 1000 fresh /64s inside one /48 capped by the /48 bucket', k1 === '9.9.9.9' && k2 === '2.2.2.2' && granted === 48, `granted ${granted}/1000`)

  await app.stop()
  const failed = results.filter((x) => !x).length
  console.log(`\n${results.length - failed}/${results.length} checks passed`)
  process.exit(failed ? 1 : 0)
}

main().catch((e) => { console.error(e); process.exit(1) })
