// Phase 4 scenarios on the fork:
//   A1–A4 recipient guard: a component between the taker and the wallet alters the call (recipient, contract, function, ABI)
//         → nothing is sent, the run stops with 'recipient_guard'
//   A5    verify() right after a change, with a client that caches the block number for 4 s (regression of T12)
//   A6    exact approval consumed to zero over two consecutive executions
//   A10–A11 automine off: replaced in the wallet by another call; never mined (timeout)
//   A7–A9 private submitter with every protected endpoint unreachable: explicit stop by default (nothing sent anywhere);
//         opt-in wallet fallback is declared (event + result); protected cancel reports it too
import { readFileSync } from 'node:fs'
import { createPublicClient, createWalletClient, createTestClient, http, fallback, parseAbi, encodeAbiParameters, keccak256, toHex, getAddress, parseAbiItem } from 'viem'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import { createTaker, plan, SWAP_TAKER_ABI } from '../dist/taker.js'
import { createSubmitter, cancelOrders } from '../dist/protect.js'

const FORK_URL = process.env.FORK_URL || 'http://127.0.0.1:8545'
const USDC = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', WETH = '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2', ZERO = '0x0000000000000000000000000000000000000000'
const chain = { id: 1, name: 'fork', nativeCurrency: { name: 'ETH', symbol: 'ETH', decimals: 18 }, rpcUrls: { default: { http: [FORK_URL] } } }
const transport = () => http(FORK_URL, { timeout: 60_000 })
const pub = createPublicClient({ chain, transport: transport(), pollingInterval: 100 })
const test = createTestClient({ chain, mode: 'anvil', transport: transport() })
const ERC20 = parseAbi(['function approve(address,uint256)', 'function deposit() payable', 'function allowance(address,address) view returns (uint256)', 'function balanceOf(address) view returns (uint256)'])
const SwapArt = JSON.parse(readFileSync(new URL(import.meta.resolve('@fondaco/contracts/fixtures/SwapERC20.json'))))
const results = []
const check = (n, ok, d = '') => { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'} | ${n}${d ? ' | ' + d : ''}`) }
async function wallet() { const account = privateKeyToAccount(generatePrivateKey()); await test.setBalance({ address: account.address, value: 10n ** 21n }); return { account, address: account.address, client: createWalletClient({ account, chain, transport: transport() }) } }
const send = async (w, req) => { const rc = await pub.waitForTransactionReceipt({ hash: await w.client.writeContract(req) }); if (rc.status !== 'success') throw new Error('reverted'); return rc }
const U = (n) => BigInt(n) * 10n ** 6n

const [owner, alice, bob, carol, fw, attacker] = await Promise.all(Array.from({ length: 6 }, wallet))
const SWAP = getAddress((await pub.waitForTransactionReceipt({ hash: await owner.client.deployContract({ abi: SwapArt.abi, bytecode: SwapArt.bytecode, args: [30n, 30n, fw.address, 0n, 0n] }) })).contractAddress)
const OTHER = getAddress((await pub.waitForTransactionReceipt({ hash: await owner.client.deployContract({ abi: SwapArt.abi, bytecode: SwapArt.bytecode, args: [30n, 30n, fw.address, 0n, 0n] }) })).contractAddress)
await send(alice, { address: WETH, abi: ERC20, functionName: 'deposit', value: 10n ** 19n })
await send(alice, { address: WETH, abi: ERC20, functionName: 'approve', args: [SWAP, 2n ** 256n - 1n] })
for (const w of [bob, carol]) await test.setStorageAt({ address: USDC, index: keccak256(encodeAbiParameters([{ type: 'address' }, { type: 'uint256' }], [w.address, 9n])), value: toHex(U(1_000_000), { size: 32 }) })
await send(carol, { address: USDC, abi: ERC20, functionName: 'approve', args: [SWAP, 2n ** 256n - 1n] })
const domain = { name: 'SWAP_ERC20', version: '4.3', chainId: 1, verifyingContract: SWAP }
const types = { OrderERC20: [{ name: 'nonce', type: 'uint256' }, { name: 'expiry', type: 'uint256' }, { name: 'signerWallet', type: 'address' }, { name: 'signerToken', type: 'address' }, { name: 'signerAmount', type: 'uint256' }, { name: 'protocolFee', type: 'uint256' }, { name: 'senderWallet', type: 'address' }, { name: 'senderToken', type: 'address' }, { name: 'senderAmount', type: 'uint256' }] }
let nonceSeq = 1n
async function ask(weth, usdc) {
  const now = (await pub.getBlock()).timestamp
  const message = { nonce: nonceSeq++, expiry: now + 3600n, signerWallet: alice.address, signerToken: WETH, signerAmount: weth, protocolFee: 30n, senderWallet: ZERO, senderToken: USDC, senderAmount: usdc }
  const sig = await alice.account.signTypedData({ domain, types, primaryType: 'OrderERC20', message })
  return { ...message, v: parseInt(sig.slice(130, 132), 16), r: '0x' + sig.slice(2, 66), s: '0x' + sig.slice(66, 130) }
}
const entries = (os) => os.map((order, i) => ({ hash: `o${i}`, order }))
const used = (o) => pub.readContract({ address: SWAP, abi: SWAP_TAKER_ABI, functionName: 'nonceUsed', args: [alice.address, o.nonce] })
const nonceOf = (a) => pub.getTransactionCount({ address: a, blockTag: 'pending' })

// ---- A1–A4: a publicClient whose simulateContract returns an altered request (stands in for a compromised middleware)
const tampered = (mutate) => new Proxy(pub, { get(t, k) {
  if (k !== 'simulateContract') return Reflect.get(t, k)
  return async (args) => { const r = await t.simulateContract(args); return args.abi === SWAP_TAKER_ABI ? { ...r, request: mutate({ ...r.request }) } : r }
} })
const EVIL_ABI = parseAbi(['function swapAnySender(uint256 nonce, address recipient, uint256 expiry, address signerWallet, address signerToken, uint256 signerAmount, address senderToken, uint256 senderAmount, uint8 v, bytes32 r, bytes32 s)'])
const cases = [
  ['A1', 'recipient replaced by an attacker', (r) => ({ ...r, args: [attacker.address, ...r.args.slice(1)] })],
  ['A2', 'contract replaced (another SwapERC20 deployment)', (r) => ({ ...r, address: OTHER })],
  ['A3', 'function replaced (a valid swap() call instead of swapAnySender)', (r) => ({ ...r, abi: SWAP_TAKER_ABI, functionName: 'swap' })],
  ['A4', 'ABI swapped so the same args encode a different call', (r) => ({ ...r, abi: EVIL_ABI, args: [r.args[1], r.args[0], ...r.args.slice(2)] })],
]
await send(bob, { address: USDC, abi: ERC20, functionName: 'approve', args: [SWAP, 2n ** 256n - 1n] })
for (const [id, what, mutate] of cases) {
  const o = await ask(10n ** 16n, U(25))
  const ev = []
  const tk = createTaker({ publicClient: tampered(mutate), walletClient: bob.client, swap: SWAP, onUpdate: (e) => ev.push(e) })
  const n0 = await nonceOf(bob.address)
  const r = await tk.execute(await tk.verify(plan(entries([o]), U(25))))
  const blocked = ev.find((e) => e.type === 'blocked')
  check(`${id}: guard — ${what} → blocked before sending`, r.stopped === 'recipient_guard' && !!blocked && r.filled.length === 0 && (await nonceOf(bob.address)) === n0 && !(await used(o)) &&
    !ev.some((e) => e.type === 'awaiting_signature'), blocked?.message)
}
// control: the untampered client fills normally (the guard does not block legitimate calls)
const oc = await ask(10n ** 16n, U(25))
const tc = createTaker({ publicClient: pub, walletClient: bob.client, swap: SWAP })
const rc = await tc.execute(await tc.verify(plan(entries([oc]), U(25))))
check('A4b: control — the same order through an untampered client is filled', rc.filled.length === 1 && rc.stopped === null)

// ---- A5: verify() just after a fill, with a 4 s block-number cache in the client (production default)
const pub4s = createPublicClient({ chain, transport: transport(), pollingInterval: 4000 })
const o5 = await ask(10n ** 16n, U(24))
const t5 = createTaker({ publicClient: pub4s, walletClient: bob.client, swap: SWAP })
await pub4s.getBlockNumber() // prime the cache
await pub.waitForTransactionReceipt({ hash: await carol.client.writeContract({ address: SWAP, abi: SWAP_TAKER_ABI, functionName: 'swapAnySender', args: [carol.address, o5.nonce, o5.expiry, o5.signerWallet, o5.signerToken, o5.signerAmount, o5.senderToken, o5.senderAmount, o5.v, o5.r, o5.s] }) })
const q5 = await t5.verify(plan(entries([o5]), U(24)))
check('A5: verify() reads the block just mined (no cached block number): the order filled 1 block ago is dropped as taken', !q5.ok && q5.dropped[0]?.reason === 'taken' && q5.block === (await pub.getBlockNumber({ cacheTime: 0 })),
  `verified at block ${q5.block}, dropped: ${q5.dropped.map((d) => d.reason)}`)

// ---- A6: exact approval, two executions in a row, each consumes its approval to zero
const dave = await wallet()
await test.setStorageAt({ address: USDC, index: keccak256(encodeAbiParameters([{ type: 'address' }, { type: 'uint256' }], [dave.address, 9n])), value: toHex(U(10_000), { size: 32 }) })
const ev6 = []
const t6 = createTaker({ publicClient: pub, walletClient: dave.client, swap: SWAP, onUpdate: (e) => ev6.push(e) })
const alw = () => pub.readContract({ address: USDC, abi: ERC20, functionName: 'allowance', args: [dave.address, SWAP] })
const r6a = await t6.execute(await t6.verify(plan(entries([await ask(10n ** 16n, U(31)), await ask(10n ** 16n, U(32))]), U(63))), { approval: 'exact' })
const a6a = await alw()
const r6b = await t6.execute(await t6.verify(plan(entries([await ask(2n * 10n ** 16n, U(77))]), U(77))), { approval: 'exact' })
const a6b = await alw()
const approvals = ev6.filter((e) => e.type === 'approving').map((e) => e.amount)
check('A6: exact approval consumed to zero on two consecutive executions (63 USDC for 2 legs, then 77 USDC)', r6a.filled.length === 2 && r6b.filled.length === 1 && a6a === 0n && a6b === 0n &&
  approvals.length === 2 && approvals[0] === U(63) && approvals[1] === U(77), `approved ${approvals.map(String)}; allowance after each run ${a6a}, ${a6b}`)

// ---- A7–A9: both protected endpoints unreachable
const dead = fallback([http('http://127.0.0.1:1', { retryCount: 0, timeout: 1000 }), http('http://127.0.0.1:2', { retryCount: 0, timeout: 1000 })], { rank: false, retryCount: 0 })
await send(bob, { address: USDC, abi: ERC20, functionName: 'approve', args: [SWAP, 2n ** 256n - 1n] })
const o7 = await ask(10n ** 16n, U(26))
const ev7 = []
const sub7 = createSubmitter({ publicClient: pub, walletClient: bob.client, chainId: 1, privateTransport: dead })
const t7 = createTaker({ publicClient: pub, walletClient: bob.client, swap: SWAP, submitter: sub7, onUpdate: (e) => ev7.push(e) })
const n7 = await nonceOf(bob.address)
const pending7 = (await pub.getBlock({ blockTag: 'pending', includeTransactions: true })).transactions.length
const r7 = await t7.execute(await t7.verify(plan(entries([o7]), U(26))))
check('A7: every protected endpoint down (default) → explicit stop, nothing sent: no tx from the taker, nothing in the mempool, order untouched',
  sub7.mode === 'private' && r7.stopped === 'private_unavailable' && r7.filled.length === 0 && ev7.some((e) => e.type === 'private_unavailable') &&
  (await nonceOf(bob.address)) === n7 && (await pub.getBlock({ blockTag: 'pending', includeTransactions: true })).transactions.length === pending7 && !(await used(o7)) && !r7.downgraded,
  `stopped ${r7.stopped}: ${ev7.find((e) => e.type === 'private_unavailable')?.error}`)

const ev8 = []
const sub8 = createSubmitter({ publicClient: pub, walletClient: bob.client, chainId: 1, privateTransport: dead, onUnavailable: 'wallet' })
const t8 = createTaker({ publicClient: pub, walletClient: bob.client, swap: SWAP, submitter: sub8, onUpdate: (e) => ev8.push(e) })
const r8 = await t8.execute(await t8.verify(plan(entries([o7]), U(26))))
check('A8: opt-in onUnavailable: "wallet" → sent through the wallet, and declared (protection_downgraded event, result.protection = wallet, downgraded)',
  r8.filled.length === 1 && r8.downgraded === true && r8.protection === 'wallet' && ev8.some((e) => e.type === 'protection_downgraded' && e.from === 'private' && e.to === 'wallet'),
  ev8.filter((e) => e.type.startsWith('protection')).map((e) => `${e.type}${e.mode ? ':' + e.mode : ''}`).join(' → '))

const [o9a, o9b] = [await ask(10n ** 16n, U(27)), await ask(10n ** 16n, U(28))]
const subA = createSubmitter({ publicClient: pub, walletClient: alice.client, chainId: 1, privateTransport: dead })
const nA = await nonceOf(alice.address)
const c9 = await cancelOrders({ publicClient: pub, walletClient: alice.client, submitter: subA, swap: SWAP, nonces: [o9a.nonce, o9b.nonce] })
check('A9: protected cancel with every endpoint down → status private_unavailable, no cancel sent, offers still open', c9.status === 'private_unavailable' && (await nonceOf(alice.address)) === nA && !(await used(o9a)) && !(await used(o9b)), c9.error)

// ---- A10–A11 (automine off): the wallet replaces the swap with a different transaction; a transaction that is never mined
await test.setAutomine(false)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const runPending = async (tk, q, onPending) => {
  const done = tk.execute(q)
  for (;;) {
    const pend = (await pub.getBlock({ blockTag: 'pending', includeTransactions: true })).transactions.find((t) => getAddress(t.from) === tk.address)
    if (pend) { await sleep(300); await onPending(pend); break }
    await sleep(100)
  }
  return done
}
const [o10a, o10b] = [await ask(10n ** 16n, U(29)), await ask(10n ** 16n, U(30))]
const t10 = createTaker({ publicClient: pub, walletClient: bob.client, swap: SWAP, timeoutMs: 60_000 })
const r10 = await runPending(t10, await t10.verify(plan(entries([o10a, o10b]), U(100))), async (tx) => {
  // same nonce, higher fee, a DIFFERENT call (an approval elsewhere): viem reports 'replaced', not 'cancelled'
  await bob.client.writeContract({ address: WETH, abi: ERC20, functionName: 'approve', args: [carol.address, 1n], nonce: tx.nonce, gas: 100_000n, maxFeePerGas: tx.maxFeePerGas * 3n, maxPriorityFeePerGas: tx.maxPriorityFeePerGas * 3n })
  await test.mine({ blocks: 1 })
})
check('A10: replaced in the wallet by a different transaction → run stops (replaced), the second leg is not sent, orders untouched',
  r10.stopped === 'replaced' && r10.filled.length === 0 && r10.failed[0]?.reason === 'replaced' && !(await used(o10a)) && !(await used(o10b)), `stopped ${r10.stopped}`)

const o11 = await ask(10n ** 16n, U(33))
const t11 = createTaker({ publicClient: pub, walletClient: bob.client, swap: SWAP, timeoutMs: 1500 })
const r11 = await t11.execute(await t11.verify(plan(entries([o11, await ask(10n ** 16n, U(34))]), U(100))))
const stuck = (await pub.getBlock({ blockTag: 'pending', includeTransactions: true })).transactions.filter((t) => getAddress(t.from) === bob.address)
for (const t of stuck) await test.dropTransaction({ hash: t.hash })
await test.setAutomine(true)
check('A11: transaction never mined within timeoutMs → run stops (timeout), remaining legs not sent; costsGas false', r11.stopped === 'timeout' && r11.failed[0]?.reason === 'timeout' &&
  r11.failed[0].costsGas === false && r11.filled.length === 0 && stuck.length === 1 && !(await used(o11)), `stopped ${r11.stopped}, ${stuck.length} tx left pending (dropped)`)

const failed = results.filter((x) => !x).length
console.log(`\n${results.length - failed}/${results.length} checks passed`)
process.exit(failed ? 1 : 0)
