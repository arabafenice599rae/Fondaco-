// Taker execution against a local mainnet fork (hardhat, chainId 1): plan → verify → execute, with races in
// the mempool, sped-up / cancelled transactions, wallet rejection and USDT-style approvals.
import { readFileSync } from 'node:fs'
import { createPublicClient, createWalletClient, createTestClient, http, parseAbi, encodeAbiParameters, keccak256, toHex, getAddress, decodeFunctionData, UserRejectedRequestError } from 'viem'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import { start } from '@fondaco/book-server'
import { createTaker, plan, SWAP_TAKER_ABI } from '../dist/taker.js'

const FORK_URL = process.env.FORK_URL || 'http://127.0.0.1:8545'
const USDC = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48'
const USDT = '0xdAC17F958D2ee523a2206206994597C13D831ec7'
const WETH = '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2'
const ZERO = '0x0000000000000000000000000000000000000000'
const FEE = 30n
const chain = { id: 1, name: 'fork', nativeCurrency: { name: 'ETH', symbol: 'ETH', decimals: 18 }, rpcUrls: { default: { http: [FORK_URL] } } }
const transport = () => http(FORK_URL, { timeout: 180_000 })
const ERC20 = parseAbi(['function approve(address,uint256)', 'function balanceOf(address) view returns (uint256)', 'function allowance(address,address) view returns (uint256)', 'function deposit() payable'])

const pub = createPublicClient({ chain, transport: transport(), pollingInterval: 100 })
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
const setToken = (token, slotIndex) => (addr, amount) =>
  test.setStorageAt({ address: token, index: keccak256(encodeAbiParameters([{ type: 'address' }, { type: 'uint256' }], [addr, slotIndex])), value: toHex(amount, { size: 32 }) })
const giveUsdc = setToken(USDC, 9n)
const giveUsdt = setToken(USDT, 2n)
const bal = (t, a) => pub.readContract({ address: t, abi: ERC20, functionName: 'balanceOf', args: [a] })

async function main() {
  const [owner, alice, bob, carol, dave, feeWallet] = await Promise.all([wallet(), wallet(), wallet(), wallet(), wallet(), wallet()])
  const SWAP = getAddress((await pub.waitForTransactionReceipt({ hash: await owner.client.deployContract({ abi: SwapArt.abi, bytecode: SwapArt.bytecode, args: [FEE, FEE, feeWallet.address, 0n, 0n] }) })).contractAddress)
  const startBlock = await pub.getBlockNumber()

  // alice makes (sells WETH); bob/carol take with USDC; dave has nothing
  await send(alice, { address: WETH, abi: ERC20, functionName: 'deposit', value: 10n ** 20n })
  await send(alice, { address: WETH, abi: ERC20, functionName: 'approve', args: [SWAP, 2n ** 256n - 1n] })
  for (const w of [bob, carol]) await giveUsdc(w.address, 10n ** 12n)
  await send(carol, { address: USDC, abi: ERC20, functionName: 'approve', args: [SWAP, 2n ** 256n - 1n] })

  const app = await start({
    port: 0, db: ':memory:', rateLimit: { capacity: 1000, refillPerSec: 100 },
    chains: { 1: { rpc: FORK_URL, swap: SWAP, startBlock: startBlock.toString(), pollMs: 3_600_000, minExpirySec: 60, maxExpirySec: 7 * 86400,
      tokens: { [USDC]: { symbol: 'USDC', decimals: 6 }, [WETH]: { symbol: 'WETH', decimals: 18 }, [USDT]: { symbol: 'USDT', decimals: 6 } } } },
  }, { log: () => {} })
  const base = `http://127.0.0.1:${app.server.address().port}`
  const api = async (method, path, body) => (await fetch(base + path, { method, headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined })).json()
  const cfg = (await api('GET', '/config'))[1]

  let nonceSeq = 1n
  async function sign(w, o) {
    const now = (await pub.getBlock()).timestamp
    const message = { nonce: nonceSeq++, expiry: now + 3600n, signerWallet: w.address, protocolFee: FEE, senderWallet: ZERO, ...o }
    const sig = await w.account.signTypedData({ domain: cfg.domain, types: cfg.types, primaryType: 'OrderERC20', message })
    return { ...Object.fromEntries(Object.entries(message).map(([k, x]) => [k, String(x)])), v: parseInt(sig.slice(130, 132), 16), r: '0x' + sig.slice(2, 66), s: '0x' + sig.slice(66, 130) }
  }
  // alice sells `weth` for `usdc`
  const sell = (weth, usdc, payToken = USDC) => sign(alice, { signerToken: WETH, signerAmount: weth, senderToken: payToken, senderAmount: usdc })
  const post = async (orders) => (await api('POST', '/orders', { chainId: 1, orders })).results.map((r) => r.hash)
  const book = async () => api('GET', `/book?chainId=1&base=${WETH}&quote=${USDC}&signed=1`)
  const local = (orders) => orders.map((order, i) => ({ hash: `local-${i}`, order }))
  const W = (n) => BigInt(Math.round(n * 1e4)) * 10n ** 14n, U = (n) => BigInt(n) * 10n ** 6n
  const fillDirect = (w, o, extra = {}) => w.client.writeContract({ address: SWAP, abi: SWAP_TAKER_ABI, functionName: 'swapAnySender',
    args: [w.address, BigInt(o.nonce), BigInt(o.expiry), o.signerWallet, o.signerToken, BigInt(o.signerAmount), o.senderToken, BigInt(o.senderAmount), o.v, o.r, o.s], ...extra })

  const taker = (w, onUpdate, walletClient = w.client) => createTaker({ publicClient: pub, walletClient, swap: SWAP, timeoutMs: 120_000, onUpdate })

  // ---------------- T1 plan from the book (signed=1): whole orders only, indicative
  await post([await sell(W(0.1), U(250)), await sell(W(0.1), U(251)), await sell(W(0.1), U(252))])
  const bk = await book()
  const p1 = plan(bk.asks, U(600))
  check('T1: plan takes whole orders best-first and stays indicative', p1.kind === 'indicative' && p1.legs.length === 2 && p1.pay === U(501) && p1.receive === W(0.2) && p1.left === U(99) && !!bk.asks[0].order?.r,
    `${p1.legs.length} legs, pay ${p1.pay}, left ${p1.left}`)

  // ---------------- T2 verify: batched check(), needs approval, recipient fixed
  const ev2 = []
  const tb = taker(bob, (e) => ev2.push(e.type))
  const q2 = await tb.verify(p1)
  check('T2: verify → verified quote, approval needed, recipient = connected wallet', q2.kind === 'verified' && q2.ok && q2.needsApproval && q2.dropped.length === 0 && q2.recipient === bob.address,
    `ok=${q2.ok} needsApproval=${q2.needsApproval} recipient=${q2.recipient.slice(0, 8)}…`)

  // ---------------- T3 execute: exact approval, 2 legs, received exactly what was signed, calldata pays bob
  const w0 = await bal(WETH, bob.address)
  const r3 = await tb.execute(q2, { approval: 'exact' })
  const w1 = await bal(WETH, bob.address)
  const alw3 = await pub.readContract({ address: USDC, abi: ERC20, functionName: 'allowance', args: [bob.address, SWAP] })
  const recipients = await Promise.all(r3.filled.map(async (f) => decodeFunctionData({ abi: SWAP_TAKER_ABI, data: (await pub.getTransaction({ hash: f.txHash })).input }).args[0]))
  check('T3: execute fills both legs to the connected wallet, exact approval fully used', r3.filled.length === 2 && w1 - w0 === W(0.2) && r3.received === W(0.2) && alw3 === 0n && recipients.every((a) => getAddress(a) === bob.address),
    `filled ${r3.filled.length}, +${w1 - w0} wei WETH, allowance left ${alw3}, events ${[...new Set(ev2)].join('>')}`)

  // ---------------- T4 taken between verify and send → skipped by the eth_call, no transaction, next leg filled
  const [o4a, o4b] = [await sell(W(0.05), U(125)), await sell(W(0.05), U(126))]
  await send(bob, { address: USDC, abi: ERC20, functionName: 'approve', args: [SWAP, 2n ** 256n - 1n] })
  const q4 = await tb.verify(plan(local([o4a, o4b]), U(300)))
  await pub.waitForTransactionReceipt({ hash: await fillDirect(carol, o4a) })
  const n4 = await pub.getTransactionCount({ address: bob.address })
  const r4 = await tb.execute(q4)
  const n4b = await pub.getTransactionCount({ address: bob.address })
  check('T4: order taken after verify is skipped at simulation (no gas), the rest executes', r4.skipped[0]?.reason === 'taken' && r4.skipped[0].costsGas === false && r4.filled.length === 1 && n4b - n4 === 1,
    `skipped: ${r4.skipped.map((s) => s.reason)}, filled ${r4.filled.length}, bob sent ${n4b - n4} tx`)

  // ---------------- T5 taker without funds: verify says so, execute sends nothing
  const td = taker(dave)
  const q5 = await td.verify(plan(local([await sell(W(0.01), U(25))]), U(25)))
  const r5 = await td.execute(q5)
  check('T5: insufficient taker balance → not ok, nothing sent', !q5.ok && q5.problems.includes('taker_balance') && r5.stopped === 'taker_balance' && (await pub.getTransactionCount({ address: dave.address })) === 0)

  // ---------------- mempool scenarios (automine off)
  await test.setAutomine(false)
  const mine = () => test.mine({ blocks: 1 })
  const runPending = async (tk, q, onPending) => {
    let fired = false
    const done = tk.execute(q)
    while (!fired) {
      const pend = (await pub.getBlock({ blockTag: 'pending', includeTransactions: true })).transactions
      const mine_ = pend.find((t) => getAddress(t.from) === tk.address)
      if (mine_) { fired = true; await sleep(400); await onPending(mine_) } else await sleep(100)
    }
    return done
  }

  // T6 race in the mempool: carol pays more priority and lands first → bob's tx reverts (costs gas), diagnosed as taken
  const o6 = await sell(W(0.02), U(50))
  const q6 = await tb.verify(plan(local([o6]), U(50)))
  const r6 = await runPending(tb, q6, async () => { await fillDirect(carol, o6, { gas: 300_000n, maxPriorityFeePerGas: 50n * 10n ** 9n, maxFeePerGas: 500n * 10n ** 9n }); await mine() })
  check('T6: mined revert after losing the race is reported as taken and costs gas', r6.failed[0]?.reason === 'taken' && r6.failed[0].costsGas && r6.filled.length === 0 && r6.gasCostWei > 0n,
    `failed: ${r6.failed.map((f) => f.reason)}, gas ${r6.gasCostWei} wei`)

  // T7 sped up in the wallet (same call, higher fee) → followed to the replacement and filled
  const ev7 = []
  const tb7 = taker(bob, (e) => ev7.push(e))
  const q7 = await tb7.verify(plan(local([await sell(W(0.02), U(51))]), U(51)))
  const r7 = await runPending(tb7, q7, async (tx) => {
    await bob.client.sendTransaction({ to: tx.to, data: tx.input, value: tx.value, nonce: tx.nonce, gas: tx.gas, maxFeePerGas: tx.maxFeePerGas * 3n, maxPriorityFeePerGas: tx.maxPriorityFeePerGas * 3n })
    await mine()
  })
  const sped = ev7.find((e) => e.type === 'sped_up')
  check('T7: sped-up transaction is followed to its replacement and filled', r7.filled.length === 1 && !!sped && r7.filled[0].txHash === sped.hash && sped.previous !== sped.hash,
    `filled via ${r7.filled[0]?.txHash.slice(0, 10)}…, previous ${sped?.previous.slice(0, 10)}…`)

  // T8 cancelled in the wallet (0 ETH to self, same nonce) → stopped, order still open
  const o8 = await sell(W(0.02), U(52))
  const q8 = await tb.verify(plan(local([o8, await sell(W(0.02), U(53))]), U(200)))
  const r8 = await runPending(tb, q8, async (tx) => {
    await bob.client.sendTransaction({ to: bob.address, value: 0n, nonce: tx.nonce, gas: 21_000n, maxFeePerGas: tx.maxFeePerGas * 3n, maxPriorityFeePerGas: tx.maxPriorityFeePerGas * 3n })
    await mine()
  })
  const used8 = await pub.readContract({ address: SWAP, abi: SWAP_TAKER_ABI, functionName: 'nonceUsed', args: [alice.address, BigInt(o8.nonce)] })
  check('T8: cancelled in the wallet → run stops, remaining legs not sent, order untouched', r8.stopped === 'cancelled' && r8.filled.length === 0 && !used8,
    `stopped=${r8.stopped}, nonce used=${used8}`)
  await test.setAutomine(true)

  // ---------------- T9 user rejects the signature → stopped, nothing sent
  const rejecting = { ...bob.client, writeContract: async () => { throw new UserRejectedRequestError(new Error('User rejected')) } }
  const t9 = taker(bob, () => {}, rejecting)
  const n9 = await pub.getTransactionCount({ address: bob.address })
  const r9 = await t9.execute(await t9.verify(plan(local([await sell(W(0.01), U(26))]), U(26))))
  check('T9: wallet rejection stops the run without sending', r9.stopped === 'rejected' && (await pub.getTransactionCount({ address: bob.address })) === n9)

  // ---------------- T10 USDT: allowance already non-zero → reset to 0, then approve exact
  await giveUsdt(bob.address, U(1000))
  await send(bob, { address: USDT, abi: ERC20, functionName: 'approve', args: [SWAP, 1n] })
  const ev10 = []
  const t10 = taker(bob, (e) => ev10.push(e.type))
  const r10 = await t10.execute(await t10.verify(plan(local([await sell(W(0.04), U(100), USDT)]), U(100))))
  const alw10 = await pub.readContract({ address: USDT, abi: ERC20, functionName: 'allowance', args: [bob.address, SWAP] })
  check('T10: USDT-style approval reset (non-zero → 0 → exact) then filled', ev10.includes('approval_reset') && r10.filled.length === 1 && alw10 === 0n && (await bal(USDT, alice.address)) === U(100),
    `events ${[...new Set(ev10)].join('>')}`)

  // ---------------- T11 order of another private taker is never executed
  const priv = await sign(alice, { signerToken: WETH, signerAmount: W(0.01), senderToken: USDC, senderAmount: U(25), senderWallet: carol.address })
  const q11 = await tb.verify({ kind: 'indicative', legs: [{ hash: 'p', order: { ...priv, nonce: BigInt(priv.nonce), expiry: BigInt(priv.expiry), signerAmount: BigInt(priv.signerAmount), senderAmount: BigInt(priv.senderAmount), protocolFee: FEE, signerWallet: getAddress(priv.signerWallet), signerToken: WETH, senderToken: USDC, senderWallet: carol.address, v: priv.v } }], pay: U(25), left: 0n, receive: W(0.01) })
  check('T11: private order for another address is dropped at verify', !q11.ok && q11.dropped[0]?.reason === 'private')

  // ---------------- T12 high-s (malleated) copy of a valid order taken from the book
  // Documented outcome: SwapERC20 v4.3 ACCEPTS high-s signatures, so the taker executes it correctly (verify → check() ok,
  // eth_call ok, fill). The original low-s copy is then dropped at verify as 'taken': never a failed transaction.
  const N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n
  const [h12] = await post([await sell(W(0.01), U(24))])
  const entry = (await book()).asks.find((a) => a.hash === h12)
  const mall = { ...entry, order: { ...entry.order, s: toHex(N - BigInt(entry.order.s), { size: 32 }), v: entry.order.v === 27 ? 28 : 27 } }
  const n12 = await pub.getTransactionCount({ address: bob.address })
  const q12 = await tb.verify(plan([mall], U(24)))
  const r12 = await tb.execute(q12)
  const q12b = await tb.verify(plan([entry], U(24)))
  const r12b = await tb.execute(q12b)
  check('T12: high-s copy from the book executes correctly; the original is then dropped as taken, no failed transaction',
    BigInt(mall.order.s) > N / 2n && q12.ok && r12.filled.length === 1 && r12.received === W(0.01) && r12.failed.length === 0 &&
    !q12b.ok && q12b.dropped[0]?.reason === 'taken' && r12b.failed.length === 0 && (await pub.getTransactionCount({ address: bob.address })) - n12 === 1,
    `high-s: filled ${r12.filled.length}; low-s afterwards: ${q12b.dropped.map((d) => d.reason)}; bob sent ${(await pub.getTransactionCount({ address: bob.address })) - n12} tx`)

  // ---------------- T13 a broken malleation (high s, v NOT flipped) is refused explicitly before sending
  const [h13] = await post([await sell(W(0.01), U(23))])
  const e13 = (await book()).asks.find((a) => a.hash === h13)
  const broken = { ...e13, order: { ...e13.order, s: toHex(N - BigInt(e13.order.s), { size: 32 }) } }
  const n13 = await pub.getTransactionCount({ address: bob.address })
  const q13 = await tb.verify(plan([broken], U(23)))
  const r13 = await tb.execute(q13)
  check('T13: invalid high-s signature dropped at verify (reason signature), nothing sent', !q13.ok && q13.dropped[0]?.reason === 'signature' && r13.stopped === 'empty' &&
    (await pub.getTransactionCount({ address: bob.address })) === n13, `dropped: ${q13.dropped.map((d) => d.reason)}, stopped ${r13.stopped}`)

  await app.stop()
  const failed = results.filter((x) => !x).length
  console.log(`\n${results.length - failed}/${results.length} checks passed`)
  process.exit(failed ? 1 : 0)
}

main().catch((e) => { console.error(e); process.exit(1) })
