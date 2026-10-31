// End-to-end test against a local mainnet fork (hardhat/anvil) at FORK_URL (default http://127.0.0.1:8545, chainId 1).
// Deploys SwapERC20 v5.0.0 (fixture compiled from the tagged source), runs the book server in-process and
// drives it over HTTP while performing real fills/cancels on-chain.
import { readFileSync } from 'node:fs'
import { createPublicClient, createWalletClient, createTestClient, http, parseAbi, encodeAbiParameters, keccak256, toHex, getAddress } from 'viem'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import { start } from '../dist/index.js'

const FORK_URL = process.env.FORK_URL || 'http://127.0.0.1:8545'
const USDC = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48'
const WETH = '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2'
const DAI = '0x6B175474E89094C44Da98b954EedeAC495271d0F'
const ZERO = '0x0000000000000000000000000000000000000000'
const FEE = 30n
const chain = { id: 1, name: 'fork', nativeCurrency: { name: 'ETH', symbol: 'ETH', decimals: 18 }, rpcUrls: { default: { http: [FORK_URL] } } }
const ERC20 = parseAbi(['function approve(address,uint256) returns (bool)', 'function balanceOf(address) view returns (uint256)', 'function deposit() payable'])

const pub = createPublicClient({ chain, transport: http(FORK_URL, { timeout: 180_000 }) })
const test = createTestClient({ chain, mode: 'hardhat', transport: http(FORK_URL, { timeout: 180_000 }) })
const SwapArt = JSON.parse(readFileSync(new URL(import.meta.resolve('@fondaco/contracts/fixtures/SwapERC20.json'))))

const results = []
function check(name, ok, detail = '') {
  results.push(ok)
  console.log(`${ok ? 'PASS' : 'FAIL'} | ${name}${detail ? ' | ' + detail : ''}`)
}

async function wallet() {
  const account = privateKeyToAccount(generatePrivateKey())
  await test.setBalance({ address: account.address, value: 10n ** 21n })
  return { account, address: account.address, client: createWalletClient({ account, chain, transport: http(FORK_URL, { timeout: 180_000 }) }) }
}
async function send(w, req) {
  const hash = await w.client.writeContract(req)
  const rc = await pub.waitForTransactionReceipt({ hash })
  if (rc.status !== 'success') throw new Error('tx reverted')
  return rc
}
async function giveUsdc(addr, amount) {
  const slot = keccak256(encodeAbiParameters([{ type: 'address' }, { type: 'uint256' }], [addr, 9n]))
  await test.setStorageAt({ address: USDC, index: slot, value: toHex(amount, { size: 32 }) })
}

async function main() {
  // ---------------- deploy own SwapERC20 (fee paid by signer, 30 bps)
  const [owner, alice, bob, carol, feeWallet] = await Promise.all([wallet(), wallet(), wallet(), wallet(), wallet()])
  const deployHash = await owner.client.deployContract({ abi: SwapArt.abi, bytecode: SwapArt.bytecode, args: [FEE, FEE, feeWallet.address, 0n, 0n] })
  const deployRc = await pub.waitForTransactionReceipt({ hash: deployHash })
  const SWAP = getAddress(deployRc.contractAddress)
  const swapAbi = SwapArt.abi

  for (const w of [alice, bob, carol]) {
    await giveUsdc(w.address, 10n ** 12n)
    await send(w, { address: WETH, abi: ERC20, functionName: 'deposit', value: 10n ** 20n })
    await send(w, { address: USDC, abi: ERC20, functionName: 'approve', args: [SWAP, 2n ** 256n - 1n] })
    await send(w, { address: WETH, abi: ERC20, functionName: 'approve', args: [SWAP, 2n ** 256n - 1n] })
  }

  // ---------------- start the book
  const config = {
    port: 0,
    db: ':memory:',
    rateLimit: { capacity: 1000, refillPerSec: 100 }, // production default is 60 burst / 2 per s
    chains: {
      1: {
        rpc: FORK_URL, swap: SWAP, startBlock: deployRc.blockNumber.toString(), pollMs: 3_600_000,
        minExpirySec: 60, maxExpirySec: 7 * 86400,
        tokens: { [USDC]: { symbol: 'USDC', decimals: 6 }, [WETH]: { symbol: 'WETH', decimals: 18 } },
      },
    },
  }
  const app = await start(config, { log: () => {} })
  const base = `http://127.0.0.1:${app.server.address().port}`
  const engine = app.engine
  const sync = async () => { while (engine.chain(1).busy) await new Promise((r) => setTimeout(r, 20)); await engine.tick(1) }
  const api = async (method, path, body) => {
    const r = await fetch(base + path, { method, headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined })
    return { status: r.status, body: await r.json() }
  }
  const events = []
  engine.on('order', (e) => events.push(e))

  const cfg = (await api('GET', '/config')).body[1]
  check('E0: /config exposes domain, types and live fee', cfg.protocolFee === '30' && cfg.domain.verifyingContract === SWAP, `fee ${cfg.protocolFee} bps, swap ${SWAP}`)

  let nonceSeq = 1n
  const chainNow = async () => (await pub.getBlock()).timestamp
  async function sign(w, o) {
    const now = await chainNow()
    const message = {
      nonce: o.nonce ?? nonceSeq++, expiry: o.expiry ?? now + 3600n, signerWallet: w.address, signerToken: o.signerToken,
      signerAmount: o.signerAmount, protocolFee: o.protocolFee ?? FEE, senderWallet: o.senderWallet ?? ZERO,
      senderToken: o.senderToken, senderAmount: o.senderAmount,
    }
    const sig = await w.account.signTypedData({ domain: cfg.domain, types: cfg.types, primaryType: 'OrderERC20', message })
    const r = '0x' + sig.slice(2, 66), s = '0x' + sig.slice(66, 130), v = parseInt(sig.slice(130, 132), 16)
    return { ...Object.fromEntries(Object.entries(message).map(([k, x]) => [k, String(x)])), v, r, s }
  }
  const ask = (w, usdc, weth, extra = {}) => sign(w, { signerToken: USDC, signerAmount: usdc, senderToken: WETH, senderAmount: weth, ...extra })
  const submit = (orders) => api('POST', '/orders', { chainId: 1, orders: Array.isArray(orders) ? orders : [orders] })
  const fill = (w, o) => send(w, { address: SWAP, abi: swapAbi, functionName: 'swapAnySender',
    args: [w.address, BigInt(o.nonce), BigInt(o.expiry), o.signerWallet, o.signerToken, BigInt(o.signerAmount), o.senderToken, BigInt(o.senderAmount), o.v, o.r, o.s] })
  const status = async (h) => (await api('GET', `/orders/${h}`)).body.status

  // E1: valid public ask → open, visible in book
  const o1 = await ask(alice, 1000n * 10n ** 6n, 4n * 10n ** 17n)
  const r1 = await submit(o1)
  const h1 = r1.body.results[0].hash
  const book1 = (await api('GET', `/book?chainId=1&base=${WETH}&quote=${USDC}`)).body
  check('E1: valid order accepted as open and listed', r1.status === 201 && r1.body.results[0].status === 'open' && book1.bids.some((b) => b.hash === h1),
    `status ${r1.body.results[0].status}; in WETH/USDC book as bid at ${book1.bids.find((b) => b.hash === h1)?.price} USDC/WETH`)

  // E2..E5: rejections
  const rFee = await submit(await ask(alice, 10n ** 6n, 10n ** 14n, { protocolFee: 0n }))
  check('E2: wrong protocolFee rejected', rFee.body.results[0].error === 'fee_mismatch')
  const bad = await ask(alice, 10n ** 6n, 10n ** 14n)
  const rSig = await submit({ ...bad, signerAmount: '2000000' })
  check('E3: tampered amount (bad signature) rejected', rSig.body.results[0].error === 'bad_signature')
  const rExp = await submit(await ask(alice, 10n ** 6n, 10n ** 14n, { expiry: (await chainNow()) + 30n * 86400n }))
  check('E4: expiry beyond limit rejected', rExp.body.results[0].error === 'expiry_too_long')
  const rTok = await submit(await sign(alice, { signerToken: DAI, signerAmount: 10n ** 18n, senderToken: WETH, senderAmount: 10n ** 14n }))
  check('E5: non-whitelisted token rejected', rTok.body.results[0].error === 'token_not_allowed')
  const rDup = await submit(o1)
  check('E6: duplicate submission rejected', rDup.body.results[0].error === 'duplicate')

  // E6b: two orders with the same nonce in one batch → first stored, second rejected (no 500, no batch failure)
  const n = nonceSeq++
  const dupA = await ask(alice, 2n * 10n ** 6n, 10n ** 15n, { nonce: n })
  const dupB = await ask(alice, 3n * 10n ** 6n, 10n ** 15n, { nonce: n })
  const rDupN = await submit([dupA, dupB])
  check('E6b: same nonce twice in one batch handled per-order', rDupN.status === 201 && rDupN.body.results[0].status === 'open' && rDupN.body.results[1].error === 'nonce_reused',
    rDupN.body.results.map((x) => x.status || x.error).join(', '))

  // E7: cumulative funding — carol funds only 2 of 3 ladder slices (balance covers 2×(amount+fee))
  await giveUsdc(carol.address, 2n * (500n * 10n ** 6n) + 2n * 1_500_000n) // 2 slices + 2 fees (0.30% of 500 = 1.5 USDC)
  const ladder = [await ask(carol, 500n * 10n ** 6n, 2n * 10n ** 17n), await ask(carol, 500n * 10n ** 6n, 21n * 10n ** 16n), await ask(carol, 500n * 10n ** 6n, 22n * 10n ** 16n)]
  const rL = await submit(ladder)
  const ls = rL.body.results.map((x) => x.status)
  check('E7: ladder — funds allocated oldest-first, over-commitment marked unfunded', JSON.stringify(ls) === JSON.stringify(['open', 'open', 'unfunded']), ls.join(', '))

  // E8: on-chain fill → indexer marks filled, book drops it; a ladder slice fill frees nothing (funds spent)
  await fill(bob, o1)
  await sync()
  check('E8: on-chain fill detected by indexer', (await status(h1)) === 'filled', `order ${h1.slice(0, 10)}… → ${await status(h1)}`)

  // E9: cancel on-chain → cancelled
  await send(carol, { address: SWAP, abi: swapAbi, functionName: 'cancel', args: [[BigInt(ladder[0].nonce)]] })
  await sync()
  const s9 = await Promise.all(rL.body.results.map((x) => status(x.hash)))
  check('E9: on-chain cancel detected; freed funds re-allocated to the unfunded slice', s9[0] === 'cancelled' && s9[2] === 'open', s9.join(', '))

  // E10: allowance revoked → unfunded; restored → open
  await send(carol, { address: USDC, abi: ERC20, functionName: 'approve', args: [SWAP, 0n] })
  await sync()
  const s10a = await status(rL.body.results[1].hash)
  await send(carol, { address: USDC, abi: ERC20, functionName: 'approve', args: [SWAP, 2n ** 256n - 1n] })
  await sync()
  const s10b = await status(rL.body.results[1].hash)
  check('E10: allowance revoked → unfunded, restored → open', s10a === 'unfunded' && s10b === 'open', `${s10a} → ${s10b}`)

  // E11: owner changes fee → live orders invalid_fee; /config updates; back to 30 → revived
  const live = await ask(alice, 100n * 10n ** 6n, 4n * 10n ** 16n)
  const hLive = (await submit(live)).body.results[0].hash
  await send(owner, { address: SWAP, abi: swapAbi, functionName: 'setProtocolFee', args: [50n] })
  await sync()
  const s11a = await status(hLive), fee11 = (await api('GET', '/config')).body[1].protocolFee
  await send(owner, { address: SWAP, abi: swapAbi, functionName: 'setProtocolFee', args: [FEE] })
  await sync()
  const s11b = await status(hLive)
  check('E11: fee change invalidates live orders, revert revives them', s11a === 'invalid_fee' && fee11 === '50' && s11b === 'open', `${s11a} (fee ${fee11}) → ${s11b}`)

  // E12: expiry → expired
  const shortO = await ask(bob, 10n * 10n ** 6n, 4n * 10n ** 15n, { expiry: (await chainNow()) + 120n })
  await giveUsdc(bob.address, 10n ** 12n)
  const hShort = (await submit(shortO)).body.results[0].hash
  await test.increaseTime({ seconds: 300 })
  await test.mine({ blocks: 1 })
  await sync()
  check('E12: expired orders removed', (await status(hShort)) === 'expired')

  // E13: asks side + price ordering (bob sells WETH for USDC at two prices)
  const a1 = await sign(bob, { signerToken: WETH, signerAmount: 10n ** 17n, senderToken: USDC, senderAmount: 260n * 10n ** 6n })
  const a2 = await sign(bob, { signerToken: WETH, signerAmount: 10n ** 17n, senderToken: USDC, senderAmount: 250n * 10n ** 6n })
  await submit([a1, a2])
  const bk = (await api('GET', `/book?chainId=1&base=${WETH}&quote=${USDC}`)).body
  check('E13: asks sorted best-first, bids sorted best-first', bk.asks.length === 2 && bk.asks[0].price < bk.asks[1].price && bk.bids.every((b, i, a) => i === 0 || a[i - 1].price >= b.price),
    `asks ${bk.asks.map((a) => a.price).join(' < ')}; bids ${bk.bids.map((b) => b.price.toFixed(2)).join(' ≥ ')}`)

  // E14: private OTC order not listed in public book, retrievable by hash
  const priv = await ask(alice, 50n * 10n ** 6n, 2n * 10n ** 16n, { senderWallet: bob.address })
  const hPriv = (await submit(priv)).body.results[0].hash
  const bk2 = (await api('GET', `/book?chainId=1&base=${WETH}&quote=${USDC}`)).body
  check('E14: private order hidden from book, fetchable by hash', !bk2.bids.some((b) => b.hash === hPriv) && (await status(hPriv)) === 'open')

  // E15: SSE stream delivers events
  const ctrl = new AbortController()
  const got = []
  fetch(base + '/stream', { signal: ctrl.signal }).then(async (r) => {
    const rd = r.body.getReader()
    for (;;) { const { value, done } = await rd.read(); if (done) break; got.push(Buffer.from(value).toString()) }
  }).catch(() => {})
  await new Promise((r) => setTimeout(r, 200))
  await fill(carol, a2)
  await sync()
  await new Promise((r) => setTimeout(r, 200))
  ctrl.abort()
  check('E15: SSE pushes order updates', got.join('').includes('"status":"filled"'))

  // E16: performance — 200 orders from 20 signers, revalidation RPC cost
  const signers = await Promise.all(Array.from({ length: 20 }, () => wallet()))
  for (const w of signers) {
    await giveUsdc(w.address, 10n ** 12n)
    await send(w, { address: USDC, abi: ERC20, functionName: 'approve', args: [SWAP, 2n ** 256n - 1n] })
  }
  const many = []
  for (const w of signers) for (let i = 0; i < 10; i++) many.push(await ask(w, BigInt(10 + i) * 10n ** 6n, 4n * 10n ** 15n))
  const t0 = performance.now()
  let accepted = 0
  for (let i = 0; i < many.length; i += 50) accepted += (await submit(many.slice(i, i + 50))).body.results.filter((x) => x.status === 'open').length
  const tSubmit = performance.now() - t0
  const liveCount = engine.db.live(1).length
  const before = app.counter.n[1] || 0
  const t1 = performance.now()
  const rv = await engine.revalidate(1)
  const tRev = performance.now() - t1
  const rpcCalls = (app.counter.n[1] || 0) - before
  check('E16: revalidating all live orders costs O(1) RPC requests', accepted === 200 && rv.checked >= 200 && rpcCalls <= 1,
    `${rv.checked} live orders re-checked with ${rpcCalls} RPC request(s) in ${tRev.toFixed(0)} ms; ${accepted}/200 orders accepted (4 batches of 50) in ${tSubmit.toFixed(0)} ms; live=${liveCount}`)

  // E18: delegated signatory (authorize) — live order becomes invalid_signer, new orders rejected, revoke allows again
  const dave = await wallet()
  await giveUsdc(dave.address, 10n ** 12n)
  await send(dave, { address: USDC, abi: ERC20, functionName: 'approve', args: [SWAP, 2n ** 256n - 1n] })
  const h18 = (await submit(await ask(dave, 100n * 10n ** 6n, 4n * 10n ** 16n))).body.results[0].hash
  const s18a = await status(h18)
  const delegate = await wallet()
  await send(dave, { address: SWAP, abi: swapAbi, functionName: 'authorize', args: [delegate.address] })
  await sync()
  const s18b = await status(h18)
  const r18 = (await submit(await ask(dave, 100n * 10n ** 6n, 4n * 10n ** 16n))).body.results[0]
  await send(dave, { address: SWAP, abi: swapAbi, functionName: 'revoke', args: [] })
  const r18c = (await submit(await ask(dave, 100n * 10n ** 6n, 4n * 10n ** 16n))).body.results[0]
  check('E18: authorize() → live order invalid_signer, new orders rejected; after revoke() accepted again',
    s18a === 'open' && s18b === 'invalid_signer' && r18.error === 'delegated_signer' && r18c.status === 'open', `${s18a} → ${s18b}; new: ${r18.error}; after revoke: ${r18c.status}`)

  // E19: contract (EIP-1271) path — a bad signature for an EOA is rejected without on-chain verification RPC
  let rpc19 = 0
  const c19 = engine.chain(1).client, orig19 = c19.verifyTypedData
  c19.verifyTypedData = (...x) => { rpc19++; return orig19.apply(c19, x) }
  const bad19 = { ...(await ask(dave, 5n * 10n ** 6n, 2n * 10n ** 15n)), s: '0x' + '11'.repeat(32) }
  const r19 = (await submit(bad19)).body.results[0]
  c19.verifyTypedData = orig19
  check('E19: invalid EOA signature rejected locally', r19.error === 'bad_signature' && rpc19 === 0, `${r19.error}, verify calls ${rpc19}`)

  // E17: rate limiter on a fresh server with production defaults
  const prod = await start({ ...config, rateLimit: undefined }, { log: () => {} })
  const pbase = `http://127.0.0.1:${prod.server.address().port}`
  let limited = 0
  for (let i = 0; i < 80; i++) if ((await fetch(`${pbase}/book?chainId=1&base=${WETH}&quote=${USDC}`)).status === 429) limited++
  await prod.stop()
  check('E17: rate limiter throttles bursts (default 60 burst)', limited > 0, `${limited}/80 requests throttled`)

  await app.stop()
  const failed = results.filter((x) => !x).length
  console.log(`\n${results.length - failed}/${results.length} checks passed`)
  process.exit(failed ? 1 : 0)
}

main().catch((e) => { console.error(e); process.exit(1) })
