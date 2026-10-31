// Load test: 10 000 orders from 1 000 signers on a mainnet fork (own anvil at the fork.config.json block).
// Measures intake, RPC per round (full sweep, idle, incremental for several logSignerChunk values), round duration,
// API latency p50/p95/p99 (separate load-generator process), memory and DB size. Writes reports/load.json.
//   node tools/load/load-test.mjs [--signers 1000] [--per 10] [--seconds 10] [--connections 32]
import { spawn } from 'node:child_process'
import { mkdtempSync, statSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createPublicClient, createWalletClient, createTestClient, http, parseAbi, encodeAbiParameters, keccak256, toHex, parseEther } from 'viem'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import { startFork } from '@fondaco/testkit/anvil'
import { deploy } from '@fondaco/contracts/deploy'
import { start } from '@fondaco/book-server'

const HERE = dirname(fileURLToPath(import.meta.url)), ROOT = resolve(HERE, '../..')
const arg = (k, d) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? Number(process.argv[i + 1]) : d }
const SIGNERS = arg('signers', 1000), PER = arg('per', 10), SECS = arg('seconds', 10), CONNS = arg('connections', 32)
const USDC = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', WETH = '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2'
const ERC20 = parseAbi(['function transfer(address,uint256)', 'function allowance(address,address) view returns (uint256)', 'function balanceOf(address) view returns (uint256)'])
const log = (...a) => console.log(`[${new Date().toISOString().slice(11, 19)}]`, ...a)
const mb = (b) => +(b / 1048576).toFixed(1)
const ms = (t) => +(performance.now() - t).toFixed(1)

const fork = await startFork()
const chain = { id: 1, name: 'fork', nativeCurrency: { name: 'ETH', symbol: 'ETH', decimals: 18 }, rpcUrls: { default: { http: [fork.url] } } }
const pub = createPublicClient({ chain, transport: http(fork.url), cacheTime: 0 })
const test = createTestClient({ chain, mode: 'anvil', transport: http(fork.url) })
const report = { date: new Date().toISOString(), forkBlock: fork.forkBlock.toString(), signers: SIGNERS, ordersPerSigner: PER, node: process.version }
try {
  const pk = generatePrivateKey()
  await test.setBalance({ address: privateKeyToAccount(pk).address, value: parseEther('10') })
  const startBlock = await pub.getBlockNumber()
  const { swap: SWAP } = await deploy({ rpc: fork.url, privateKey: pk, feeBps: 30, feeWallet: privateKeyToAccount(generatePrivateKey()).address, owner: privateKeyToAccount(generatePrivateKey()).address, log: () => {} })

  // ---- 1 000 signers funded by storage writes: half sell WETH, half buy with USDC (balance + allowance to SwapERC20)
  let t = performance.now()
  const slot = (owner, i) => keccak256(encodeAbiParameters([{ type: 'address' }, { type: 'uint256' }], [owner, i]))
  const nested = (owner, spender, i) => keccak256(encodeAbiParameters([{ type: 'address' }, { type: 'bytes32' }], [spender, slot(owner, i)]))
  const signers = Array.from({ length: SIGNERS }, (_, i) => ({ account: privateKeyToAccount(generatePrivateKey()), usdc: i % 2 === 0 }))
  const MAX = toHex(2n ** 255n - 1n, { size: 32 })
  await Promise.all(signers.map(async (s) => {
    const a = s.account.address
    if (s.usdc) { // USDC v2.2: balances slot 9 (top bit = blacklist flag), allowed slot 10
      await test.setStorageAt({ address: USDC, index: slot(a, 9n), value: toHex(10n ** 12n, { size: 32 }) })
      await test.setStorageAt({ address: USDC, index: nested(a, SWAP, 10n), value: MAX })
    } else { // WETH9: balanceOf slot 3, allowance slot 4
      await test.setStorageAt({ address: WETH, index: slot(a, 3n), value: toHex(10n ** 21n, { size: 32 }) })
      await test.setStorageAt({ address: WETH, index: nested(a, SWAP, 4n), value: MAX })
    }
  }))
  const chk = await Promise.all([pub.readContract({ address: USDC, abi: ERC20, functionName: 'allowance', args: [signers[0].account.address, SWAP] }), pub.readContract({ address: WETH, abi: ERC20, functionName: 'allowance', args: [signers[1].account.address, SWAP] })])
  if (chk.some((x) => x === 0n)) throw new Error('allowance storage layout check failed')
  report.setupFundingMs = ms(t)
  log(`funded ${SIGNERS} signers in ${report.setupFundingMs} ms`)

  // ---- server (file DB in WAL, realistic), manual rounds
  const dir = mkdtempSync(join(tmpdir(), 'fondaco-load-'))
  const dbFile = join(dir, 'book.sqlite')
  const app = await start({ port: 0, db: dbFile, rateLimit: { capacity: 1e9, refillPerSec: 1e9 }, log: { level: 'warn' },
    chains: { 1: { rpc: fork.url, swap: SWAP, startBlock: startBlock.toString(), pollMs: 3_600_000, fullSweepMs: 3_600_000, maxOpenPerSigner: 200,
      tokens: { [USDC]: { symbol: 'USDC', decimals: 6 }, [WETH]: { symbol: 'WETH', decimals: 18 } } } } })
  const { engine, counter } = app
  const base = `http://127.0.0.1:${app.server.address().port}`
  const cfg = engine.publicConfig()[1]
  const rpc = () => counter.n[1] || 0
  report.memory = { afterStartMB: mb(process.memoryUsage().rss) }

  // ---- sign 10 000 orders (ladders: 10 price levels per signer)
  t = performance.now()
  const now = (await pub.getBlock()).timestamp
  const orders = []
  let nonce = 1n
  for (const s of signers) for (let k = 0; k < PER; k++) {
    const message = s.usdc
      ? { signerToken: USDC, signerAmount: BigInt(100 + k) * 10n ** 6n, senderToken: WETH, senderAmount: 4n * 10n ** 16n }
      : { signerToken: WETH, signerAmount: 4n * 10n ** 16n, senderToken: USDC, senderAmount: BigInt(101 + k) * 10n ** 6n }
    const m = { nonce: nonce++, expiry: now + 86400n, signerWallet: s.account.address, protocolFee: 30n, senderWallet: '0x0000000000000000000000000000000000000000', ...message }
    const sig = await s.account.signTypedData({ domain: cfg.domain, types: cfg.types, primaryType: 'OrderERC20', message: m })
    orders.push({ ...Object.fromEntries(Object.entries(m).map(([key, x]) => [key, String(x)])), v: parseInt(sig.slice(130, 132), 16), r: '0x' + sig.slice(2, 66), s: '0x' + sig.slice(66, 130) })
  }
  report.signMs = ms(t)
  log(`signed ${orders.length} orders in ${report.signMs} ms`)

  // ---- intake over HTTP: batches of 50, 4 in flight
  t = performance.now()
  const rpc0 = rpc(), batchLat = []
  let accepted = 0
  const batches = []
  for (let i = 0; i < orders.length; i += 50) batches.push(orders.slice(i, i + 50))
  let next = 0
  await Promise.all(Array.from({ length: 4 }, async () => {
    while (next < batches.length) {
      const b = batches[next++], t1 = performance.now()
      const r = await (await fetch(`${base}/orders`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ chainId: 1, orders: b }) })).json()
      batchLat.push(performance.now() - t1)
      accepted += r.results.filter((x) => x.status === 'open').length
    }
  }))
  batchLat.sort((a, b) => a - b)
  const pq = (a, p) => +a[Math.min(a.length - 1, Math.floor((p / 100) * a.length))].toFixed(1)
  report.intake = { orders: orders.length, acceptedOpen: accepted, ms: ms(t), ordersPerSec: Math.round(orders.length / ((performance.now() - t) / 1000)), rpc: rpc() - rpc0,
    batchOf50Ms: { p50: pq(batchLat, 50), p95: pq(batchLat, 95), p99: pq(batchLat, 99) } }
  report.memory.afterIntakeMB = mb(process.memoryUsage().rss)
  log('intake', report.intake)

  // ---- rounds: full sweep (cold and warm), idle
  const round = async (fn) => { const r0 = rpc(), t0 = performance.now(); const res = await fn(); return { rpc: rpc() - r0, ms: ms(t0), checked: res?.checked } }
  await engine.tick(1) // first round after start: full
  report.fullSweep = [await round(() => engine.revalidate(1)), await round(() => engine.revalidate(1)), await round(() => engine.revalidate(1))]
  report.idleRound = await round(() => engine.tick(1))
  log('full sweep', report.fullSweep, 'idle', report.idleRound)

  // ---- incremental rounds: 20 signers move funds in ONE block, for several logSignerChunk values
  const movers = signers.slice(0, 40)
  await Promise.all(movers.map((s) => test.setBalance({ address: s.account.address, value: parseEther('1') })))
  report.incremental = []
  for (const chunk of [50, 200, 500, 1000, 2000]) {
    engine.chain(1).cfg.logSignerChunk = chunk
    await test.setAutomine(false)
    const batch = movers.slice((report.incremental.length % 2) * 20, (report.incremental.length % 2) * 20 + 20)
    for (const s of batch) {
      const w = createWalletClient({ account: s.account, chain, transport: http(fork.url) })
      await w.writeContract({ address: s.usdc ? USDC : WETH, abi: ERC20, functionName: 'transfer', args: ['0x000000000000000000000000000000000000dEaD', s.usdc ? 10n ** 6n : 10n ** 15n], gas: 100_000n })
    }
    await test.mine({ blocks: 1 })
    await test.setAutomine(true)
    const live = engine.db.liveSigners(1).length
    const r = await round(() => engine.tick(1))
    report.incremental.push({ logSignerChunk: chunk, liveSigners: live, mode: live <= chunk ? 'filtered at the node' : 'unfiltered, filtered locally', ...r })
    await round(() => engine.tick(1)) // idle after
  }
  log('incremental', report.incremental)

  // ---- storm: 500 signers (5 000 orders) receive a Transfer in ONE block, with 10 000 orders in the book. They are first
  // emptied without events (storage write) and marked unfunded by a full sweep, so the incoming transfers are what re-funds them.
  const STORM = Math.min(500, signers.filter((s) => s.usdc).length)
  const victims = signers.filter((s) => s.usdc).slice(0, STORM)
  const whales = Array.from({ length: 25 }, () => privateKeyToAccount(generatePrivateKey()))
  await test.setBlockGasLimit({ gasLimit: 300_000_000n })
  for (const w of whales) {
    await test.setBalance({ address: w.address, value: parseEther('10') })
    await test.setStorageAt({ address: USDC, index: slot(w.address, 9n), value: toHex(10n ** 15n, { size: 32 }) })
  }
  report.storm = []
  for (const chunk of [1000, 200]) {
    engine.chain(1).cfg.logSignerChunk = chunk
    engine.chain(1).filterRejectedUntil = 0
    await Promise.all(victims.map((v) => test.setStorageAt({ address: USDC, index: slot(v.account.address, 9n), value: toHex(0n, { size: 32 }) })))
    await test.mine({ blocks: 1 })
    await engine.revalidate(1)
    await engine.tick(1)
    const unfundedBefore = victims.reduce((n, v) => n + engine.db.bySigner(1, v.account.address).filter((r) => r.status === 'unfunded').length, 0)
    await test.setAutomine(false)
    const sends = []
    for (let wi = 0; wi < whales.length; wi++) {
      const w = createWalletClient({ account: whales[wi], chain, transport: http(fork.url) })
      let n = await pub.getTransactionCount({ address: whales[wi].address, blockTag: 'pending' })
      for (const v of victims.filter((_, i) => i % whales.length === wi)) {
        sends.push(w.writeContract({ address: USDC, abi: ERC20, functionName: 'transfer', args: [v.account.address, 10n ** 12n], gas: 80_000n, nonce: n++ }))
      }
    }
    await Promise.all(sends)
    await test.mine({ blocks: 1 })
    await test.setAutomine(true)
    const blk = await pub.getBlock({ blockTag: 'latest' })
    const r = await round(() => engine.tick(1))
    const openAfter = victims.reduce((n, v) => n + engine.db.bySigner(1, v.account.address).filter((x) => x.status === 'open').length, 0)
    const entry = { logSignerChunk: chunk, mode: 1000 <= chunk ? 'filtered at the node' : 'unfiltered, filtered locally', signersHit: STORM, transfersInBlock: blk.transactions.length,
      ordersUnfundedBefore: unfundedBefore, ordersOpenAfter: openAfter, ...r, withinLimit2s: r.ms <= 2000 }
    report.storm.push(entry)
    log('storm', entry)
  }

  // ---- API latency, load generator in a separate process
  const bench = (path, extra = [], secs = SECS) => new Promise((res, rej) => {
    const p = spawn(process.execPath, [join(HERE, 'bench-http.mjs'), base + path, String(secs), String(CONNS), ...extra], { stdio: ['ignore', 'pipe', 'inherit'] })
    let out = ''
    p.stdout.on('data', (d) => { out += d })
    p.on('exit', (code) => (code === 0 ? res(JSON.parse(out)) : rej(new Error(`bench exit ${code}`))))
  })
  const someSigner = signers[3].account.address
  const someHash = engine.db.bySigner(1, someSigner)[0].hash
  report.api = []
  for (const [name, path, extra] of [
    ['GET /book (limit 50)', `/book?chainId=1&base=${WETH}&quote=${USDC}&limit=50`],
    ['GET /book (limit 200, signed=1)', `/book?chainId=1&base=${WETH}&quote=${USDC}&limit=200&signed=1`],
    // the ETag also moves with every 5 s of chain time (expiry buffer): take it right before, and bench for < 5 s
    ['GET /book (If-None-Match → 304)', `/book?chainId=1&base=${WETH}&quote=${USDC}&limit=50`, 'etag'],
    ['GET /orders?signer', `/orders?chainId=1&signer=${someSigner}`],
    ['GET /orders/:hash', `/orders/${someHash}`],
  ]) {
    const r = extra === 'etag'
      ? await bench(path, [`if-none-match:${(await fetch(base + path)).headers.get('etag')}`], 4)
      : await bench(path, extra)
    report.api.push({ name, ...r })
    log(name, r.rps, 'rps', r.ms, r.codes)
  }
  report.memory.afterLoadMB = mb(process.memoryUsage().rss)
  report.memory.heapUsedMB = mb(process.memoryUsage().heapUsed)
  report.db = { liveOrders: engine.db.countLive(1), fileMB: mb(statSync(dbFile).size + (statSync(dbFile + '-wal', { throwIfNoEntry: false })?.size ?? 0)) }
  await app.stop()
} finally {
  await fork.stop()
}
// real-mainnet cost of the token-log query (the fork has no background traffic)
report.mainnetTokenLogs = await new Promise((res) => {
  const p = spawn(process.execPath, [join(HERE, 'mainnet-logs.mjs')], { stdio: ['ignore', 'pipe', 'inherit'] })
  let out = ''
  p.stdout.on('data', (d) => { out += d })
  p.on('exit', () => { try { res(JSON.parse(out)) } catch { res({ error: 'unavailable' }) } })
})
mkdirSync(resolve(ROOT, 'reports'), { recursive: true })
writeFileSync(resolve(ROOT, 'reports/load.json'), JSON.stringify(report, null, 2))
console.log(JSON.stringify(report, null, 2))
const stormOk = report.storm?.length && report.storm.every((x) => x.withinLimit2s && x.ordersOpenAfter === x.ordersUnfundedBefore && x.ordersUnfundedBefore === x.signersHit * PER)
console.log(`${stormOk ? 'PASS' : 'FAIL'} | storm: ${report.storm?.map((x) => `${x.logSignerChunk}: ${x.ms} ms, ${x.rpc} RPC, ${x.ordersOpenAfter}/${x.ordersUnfundedBefore} re-funded`).join('; ')} (limit 2 s)`)
process.exit(stormOk ? 0 : 1)
