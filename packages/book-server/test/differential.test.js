// Differential test on the fork: random sequences of transfer, approve, WETH deposit/withdraw, fill, cancel, fee change
// and time passing. After EVERY step the engine runs its normal incremental round; its statuses must equal those of a
// full verification from scratch (a second engine on a copy of the database that runs revalidate()).
// Seeds are fixed (reproducible); DIFF_SEEDS / DIFF_STEPS change the budget.
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createPublicClient, createWalletClient, createTestClient, http, parseAbi, encodeAbiParameters, keccak256, toHex, parseEther } from 'viem'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import { deploy } from '@fondaco/contracts/deploy'
import { swapErc20Abi } from '@fondaco/contracts'
import { start, openDb, Engine, parseConfig } from '../dist/index.js'
import { toChainCfg } from '../dist/config.js'

const FORK_URL = process.env.FORK_URL || 'http://127.0.0.1:8545'
const USDC = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', WETH = '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2'
const chain = { id: 1, name: 'fork', nativeCurrency: { name: 'ETH', symbol: 'ETH', decimals: 18 }, rpcUrls: { default: { http: [FORK_URL] } } }
const pub = createPublicClient({ chain, transport: http(FORK_URL), cacheTime: 0 })
const test = createTestClient({ chain, mode: 'anvil', transport: http(FORK_URL) })
const ERC20 = parseAbi(['function approve(address,uint256)', 'function transfer(address,uint256)', 'function deposit() payable', 'function withdraw(uint256)', 'function balanceOf(address) view returns (uint256)'])
const SEEDS = (process.env.DIFF_SEEDS || '1,2,3').split(',').map(Number), STEPS = Number(process.env.DIFF_STEPS || 40)
const results = []
const check = (n, ok, d = '') => { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'} | ${n}${d ? ' | ' + d : ''}`) }
const rng = (seed) => () => { seed |= 0; seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296 }
const wait = async (hash) => pub.waitForTransactionReceipt({ hash })
async function wallet() { const account = privateKeyToAccount(generatePrivateKey()); await test.setBalance({ address: account.address, value: parseEther('1000') }); return { account, address: account.address, client: createWalletClient({ account, chain, transport: http(FORK_URL) }) } }
const U = (n) => BigInt(n) * 10n ** 6n, W = (n) => BigInt(Math.round(n * 1000)) * 10n ** 15n

async function run(seed) {
  const R = rng(seed), pick = (a) => a[Math.floor(R() * a.length)]
  const pk = generatePrivateKey()
  await test.setBalance({ address: privateKeyToAccount(pk).address, value: parseEther('10') })
  const safe = privateKeyToAccount(generatePrivateKey()).address
  const startBlock = await pub.getBlockNumber()
  const { swap: SWAP } = await deploy({ rpc: FORK_URL, privateKey: pk, feeBps: 30, feeWallet: safe, owner: safe, log: () => {} })
  await test.impersonateAccount({ address: safe })
  await test.setBalance({ address: safe, value: parseEther('10') })
  const owner = createWalletClient({ account: safe, chain, transport: http(FORK_URL) })
  const signers = await Promise.all(Array.from({ length: 4 }, wallet))
  const taker = await wallet(), sink = await wallet()
  for (const s of signers) {
    await test.setStorageAt({ address: USDC, index: keccak256(encodeAbiParameters([{ type: 'address' }, { type: 'uint256' }], [s.address, 9n])), value: toHex(U(2000), { size: 32 }) })
    await wait(await s.client.writeContract({ address: WETH, abi: ERC20, functionName: 'deposit', value: W(2) }))
    for (const t of [USDC, WETH]) await wait(await s.client.writeContract({ address: t, abi: ERC20, functionName: 'approve', args: [SWAP, 2n ** 256n - 1n] }))
  }
  await test.setStorageAt({ address: USDC, index: keccak256(encodeAbiParameters([{ type: 'address' }, { type: 'uint256' }], [taker.address, 9n])), value: toHex(U(10 ** 7), { size: 32 }) })
  await wait(await taker.client.writeContract({ address: WETH, abi: ERC20, functionName: 'deposit', value: W(500) }))
  for (const t of [USDC, WETH]) await wait(await taker.client.writeContract({ address: t, abi: ERC20, functionName: 'approve', args: [SWAP, 2n ** 256n - 1n] }))

  const dir = mkdtempSync(join(tmpdir(), 'fondaco-diff-'))
  const raw = { port: 0, db: join(dir, 'a.sqlite'), rateLimit: { capacity: 100000, refillPerSec: 10000 },
    chains: { 1: { rpc: FORK_URL, swap: SWAP, startBlock: startBlock.toString(), pollMs: 3_600_000, fullSweepMs: 3_600_000, minExpirySec: 10,
      tokens: { [USDC]: { symbol: 'USDC', decimals: 6 }, [WETH]: { symbol: 'WETH', decimals: 18 } } } } }
  const app = await start(raw, { log: () => {} })
  const A = app.engine
  const cfg = A.publicConfig()[1]
  let nonce = 1n
  const orders = []
  async function post(s, give, want, fee) {
    const now = (await pub.getBlock()).timestamp
    const short = R() < 0.25
    const message = { nonce: nonce++, expiry: now + (short ? 120n + BigInt(Math.floor(R() * 600)) : 86400n), signerWallet: s.address, signerToken: give,
      signerAmount: give === USDC ? U(50 + Math.floor(R() * 400)) : W(0.05 + R() * 0.4), protocolFee: fee, senderWallet: '0x0000000000000000000000000000000000000000',
      senderToken: want, senderAmount: want === USDC ? U(50 + Math.floor(R() * 400)) : W(0.05 + R() * 0.4) }
    const sig = await s.account.signTypedData({ domain: cfg.domain, types: cfg.types, primaryType: 'OrderERC20', message })
    const o = { ...Object.fromEntries(Object.entries(message).map(([k, x]) => [k, String(x)])), v: parseInt(sig.slice(130, 132), 16), r: '0x' + sig.slice(2, 66), s: '0x' + sig.slice(66, 130) }
    const [r] = await A.submit(1, [o])
    if (r.hash) orders.push({ o, h: r.hash, s })
  }
  for (const s of signers) for (let i = 0; i < 4; i++) await post(s, i % 2 ? WETH : USDC, i % 2 ? USDC : WETH, 30n)
  await A.tick(1)

  let fee = 30n, mismatches = 0, firstMismatch = null
  const counts = {}
  const db = A.db
  for (let step = 0; step < STEPS; step++) {
    const s = pick(signers), tok = pick([USDC, WETH])
    const action = pick(['transfer_out', 'transfer_in', 'approve', 'approve', 'deposit', 'withdraw', 'fill', 'fill', 'cancel', 'post', 'time', 'fee'])
    counts[action] = (counts[action] || 0) + 1
    try {
      if (action === 'transfer_out') { const bal = await pub.readContract({ address: tok, abi: ERC20, functionName: 'balanceOf', args: [s.address] }); if (bal > 0n) await wait(await s.client.writeContract({ address: tok, abi: ERC20, functionName: 'transfer', args: [sink.address, (bal * BigInt(Math.floor(R() * 100))) / 100n] })) }
      else if (action === 'transfer_in') await wait(await taker.client.writeContract({ address: tok, abi: ERC20, functionName: 'transfer', args: [s.address, tok === USDC ? U(Math.floor(R() * 500)) : W(R())] }))
      else if (action === 'approve') await wait(await s.client.writeContract({ address: tok, abi: ERC20, functionName: 'approve', args: [SWAP, pick([0n, 2n ** 256n - 1n, tok === USDC ? U(Math.floor(R() * 800)) : W(R())])] }))
      else if (action === 'deposit') await wait(await s.client.writeContract({ address: WETH, abi: ERC20, functionName: 'deposit', value: W(R()) }))
      else if (action === 'withdraw') { const bal = await pub.readContract({ address: WETH, abi: ERC20, functionName: 'balanceOf', args: [s.address] }); if (bal > 0n) await wait(await s.client.writeContract({ address: WETH, abi: ERC20, functionName: 'withdraw', args: [(bal * BigInt(Math.floor(R() * 100))) / 100n] })) }
      else if (action === 'fill') {
        const open = orders.filter((x) => db.byHash(x.h).status === 'open')
        if (open.length) { const { o } = pick(open); await wait(await taker.client.writeContract({ address: SWAP, abi: swapErc20Abi, functionName: 'swapAnySender', gas: 400_000n,
          args: [taker.address, BigInt(o.nonce), BigInt(o.expiry), o.signerWallet, o.signerToken, BigInt(o.signerAmount), o.senderToken, BigInt(o.senderAmount), o.v, o.r, o.s] })) }
      } else if (action === 'cancel') { const mine = orders.filter((x) => x.s === s); if (mine.length) await wait(await s.client.writeContract({ address: SWAP, abi: swapErc20Abi, functionName: 'cancel', args: [[BigInt(pick(mine).o.nonce)]] })) }
      else if (action === 'post') await post(s, tok, tok === USDC ? WETH : USDC, fee)
      else if (action === 'time') { await test.increaseTime({ seconds: 60 + Math.floor(R() * 600) }); await test.mine({ blocks: 1 }) }
      else if (action === 'fee') { fee = fee === 30n ? pick([50n, 30n]) : 30n; await wait(await owner.writeContract({ address: SWAP, abi: swapErc20Abi, functionName: 'setProtocolFee', args: [fee] })) }
    } catch { /* a reverted random action (e.g. a fill that lost its funds) is part of the randomness */ }

    await A.tick(1) // the normal incremental round (full only when the engine decides: fee change, gap, reorg)
    const snapA = Object.fromEntries(db.bySigner.length ? orders.map((x) => [x.h, db.byHash(x.h).status]) : [])
    // reference: copy of A's database, fresh engine, full verification from scratch
    const copy = join(dir, `b-${step}.sqlite`)
    db.raw.exec(`VACUUM INTO '${copy}'`)
    const dbB = openDb(copy)
    const B = new Engine(Object.entries(parseConfig({ ...raw, db: copy }).chains).map(([id, c]) => toChainCfg(id, c)), dbB)
    await B.init()
    await B.revalidate(1)
    const snapB = Object.fromEntries(orders.map((x) => [x.h, dbB.byHash(x.h).status]))
    dbB.raw.close()
    rmSync(copy, { force: true })
    const diff = orders.filter((x) => snapA[x.h] !== snapB[x.h]).map((x) => `${x.h.slice(0, 8)} ${snapA[x.h]}≠${snapB[x.h]}`)
    if (diff.length) { mismatches++; firstMismatch ??= `step ${step} (${action}): ${diff.join(', ')}` }
  }
  const final = {}
  for (const x of orders) { const st = db.byHash(x.h).status; final[st] = (final[st] || 0) + 1 }
  await app.stop()
  rmSync(dir, { recursive: true, force: true })
  return { mismatches, firstMismatch, counts, final, orders: orders.length }
}

for (const seed of SEEDS) {
  const r = await run(seed)
  check(`D-seed${seed}: ${STEPS} random steps — incremental state = full verification from scratch after every step`, r.mismatches === 0,
    r.mismatches ? r.firstMismatch : `${r.orders} orders; actions ${JSON.stringify(r.counts)}; final ${JSON.stringify(r.final)}`)
}
const failed = results.filter((x) => !x).length
console.log(`\n${results.length - failed}/${results.length} checks passed`)
process.exit(failed ? 1 : 0)
