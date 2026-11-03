// Phase 1 server checks on a local mainnet fork, with SwapERC20 deployed by the real deploy script:
//   S1 /config never exposes a Wrapper (excluded from v1)
//   S2 a malleated (high-s) copy of a stored order is a duplicate (dedupe by EIP-712 hash, not by signature)
//   S3–S6 decision A-02: after authorize() → revoke() the old signature is valid again ON-CHAIN, but the book keeps the
//         order terminal (invalid_signer, never listed) until it is filled or cancelled; a reorg never revives it.
//   S7–S8 the API tells the app: executableOnChain in /orders/:hash and /orders?signer (true after revoke until cancel/fill)
import { readFileSync } from 'node:fs'
import { createPublicClient, createWalletClient, createTestClient, http, parseAbi, encodeAbiParameters, keccak256, toHex, getAddress, hexToString, parseEther } from 'viem'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import { deploy } from '@fondaco/contracts/deploy'
import { start } from '../dist/index.js'

const FORK_URL = process.env.FORK_URL || 'http://127.0.0.1:8545'
const USDC = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48'
const WETH = '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2'
const ZERO = '0x0000000000000000000000000000000000000000'
const N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n // secp256k1 order
const chain = { id: 1, name: 'fork', nativeCurrency: { name: 'ETH', symbol: 'ETH', decimals: 18 }, rpcUrls: { default: { http: [FORK_URL] } } }
const transport = () => http(FORK_URL, { timeout: 180_000 })
const pub = createPublicClient({ chain, transport: transport() })
const test = createTestClient({ chain, mode: 'anvil', transport: transport() })
const SwapArt = JSON.parse(readFileSync(new URL(import.meta.resolve('@fondaco/contracts/fixtures/SwapERC20.json'))))
const ERC20 = parseAbi(['function approve(address,uint256)', 'function deposit() payable'])
const results = []
const check = (n, ok, d = '') => { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'} | ${n}${d ? ' | ' + d : ''}`) }

async function wallet() {
  const account = privateKeyToAccount(generatePrivateKey())
  await test.setBalance({ address: account.address, value: 10n ** 21n })
  return { account, address: account.address, client: createWalletClient({ account, chain, transport: transport() }) }
}
async function send(w, req) { const rc = await pub.waitForTransactionReceipt({ hash: await w.client.writeContract(req) }); if (rc.status !== 'success') throw new Error('tx reverted'); return rc }
const giveUsdc = (a, v) => test.setStorageAt({ address: USDC, index: keccak256(encodeAbiParameters([{ type: 'address' }, { type: 'uint256' }], [a, 9n])), value: toHex(v, { size: 32 }) })
const U = (n) => BigInt(n) * 10n ** 6n

async function main() {
  const pk = generatePrivateKey()
  await test.setBalance({ address: privateKeyToAccount(pk).address, value: parseEther('10') })
  const safe = privateKeyToAccount(generatePrivateKey()).address
  const feeWallet = privateKeyToAccount(generatePrivateKey()).address
  const startBlock = await pub.getBlockNumber()
  const { swap: SWAP } = await deploy({ rpc: FORK_URL, privateKey: pk, feeBps: 30, feeWallet, owner: safe, log: () => {} })

  const [alice, bob, delegate] = await Promise.all([wallet(), wallet(), wallet()])
  await giveUsdc(alice.address, U(100_000))
  await send(alice, { address: USDC, abi: ERC20, functionName: 'approve', args: [SWAP, 2n ** 256n - 1n] })
  await send(bob, { address: WETH, abi: ERC20, functionName: 'deposit', value: 10n ** 19n })
  await send(bob, { address: WETH, abi: ERC20, functionName: 'approve', args: [SWAP, 2n ** 256n - 1n] })

  const app = await start({
    port: 0, db: ':memory:', rateLimit: { capacity: 1000, refillPerSec: 100 },
    chains: { 1: { rpc: FORK_URL, swap: SWAP, startBlock: startBlock.toString(), pollMs: 3_600_000, minExpirySec: 60, maxExpirySec: 7 * 86400,
      tokens: { [USDC]: { symbol: 'USDC', decimals: 6 }, [WETH]: { symbol: 'WETH', decimals: 18 } } } },
  }, { log: () => {} })
  const { engine } = app
  const base = `http://127.0.0.1:${app.server.address().port}`
  const api = async (method, path, body) => {
    const r = await fetch(base + path, { method, headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined })
    return { status: r.status, text: await r.clone().text(), body: await r.json() }
  }
  const tick = async () => { while (engine.chain(1).busy) await new Promise((r) => setTimeout(r, 20)); return engine.tick(1) }
  const status = async (h) => (await api('GET', `/orders/${h}`)).body.status
  const exe = async (h) => (await api('GET', `/orders/${h}`)).body.executableOnChain
  const exeListed = async (hs) => { const os = (await api('GET', `/orders?chainId=1&signer=${alice.address}`)).body.orders; return hs.map((h) => os.find((o) => o.hash === h)?.executableOnChain) }
  const inBook = async (h) => (await api('GET', `/book?chainId=1&base=${WETH}&quote=${USDC}&limit=200`)).body.bids.some((b) => b.hash === h)

  // S1
  const cfgRes = await api('GET', '/config')
  const cfg = cfgRes.body[1]
  check('S1: /config does not expose a Wrapper', !('wrapper' in cfg) && !/wrapper/i.test(cfgRes.text) && cfg.domain.verifyingContract === SWAP, `keys: ${Object.keys(cfg).join(', ')}`)

  let nonceSeq = 1n
  async function bid(usdc, weth) {
    const now = (await pub.getBlock()).timestamp
    const message = { nonce: nonceSeq++, expiry: now + 3600n, signerWallet: alice.address, signerToken: USDC, signerAmount: usdc, protocolFee: 30n, senderWallet: ZERO, senderToken: WETH, senderAmount: weth }
    const sig = await alice.account.signTypedData({ domain: cfg.domain, types: cfg.types, primaryType: 'OrderERC20', message })
    return { ...Object.fromEntries(Object.entries(message).map(([k, x]) => [k, String(x)])), v: parseInt(sig.slice(130, 132), 16), r: '0x' + sig.slice(2, 66), s: '0x' + sig.slice(66, 130) }
  }
  const highS = (o) => ({ ...o, s: toHex(N - BigInt(o.s), { size: 32 }), v: o.v === 27 ? 28 : 27 })
  const submit = async (os) => (await api('POST', '/orders', { chainId: 1, orders: [os].flat() })).body.results
  const args = (o, recipient) => [recipient, BigInt(o.nonce), BigInt(o.expiry), o.signerWallet, o.signerToken, BigInt(o.signerAmount), o.senderToken, BigInt(o.senderAmount), o.v, o.r, o.s]
  const onchainCheck = async (o) => (await pub.readContract({ address: SWAP, abi: SwapArt.abi, functionName: 'check', args: [ZERO, ...args(o, ZERO).slice(1)] }))
    .map((e) => hexToString(e, { size: 32 }).replace(/\0+$/, ''))

  // S2 high-s: the contract hash ignores the signature, so a malleated copy is the same order
  const o0 = await bid(U(100), 4n * 10n ** 16n)
  const [r0] = await submit(o0)
  const [r0h] = await submit(highS(o0))
  const fresh = await bid(U(101), 4n * 10n ** 16n)
  const [rh] = await submit(highS(fresh))
  check('S2: high-s copy of a stored order rejected as duplicate (same EIP-712 hash)', r0.status === 'open' && r0h.error === 'duplicate',
    `low-s: ${r0.status}; high-s copy: ${r0h.error}; a fresh order sent only as high-s: ${rh.status || rh.error}; on-chain check(high-s): [${(await onchainCheck(highS(fresh))).join(',')}]`)

  // S3 post → authorize → revoke: the book keeps them terminal
  const [o1, o2, o3] = [await bid(U(200), 8n * 10n ** 16n), await bid(U(201), 8n * 10n ** 16n), await bid(U(202), 8n * 10n ** 16n)]
  const hs = (await submit([o1, o2, o3])).map((r) => r.hash)
  const s0 = await Promise.all(hs.map(status))
  const e0open = await exe(hs[0])
  await send(alice, { address: SWAP, abi: SwapArt.abi, functionName: 'authorize', args: [delegate.address] })
  await tick()
  const s1 = await Promise.all(hs.map(status))
  const e1 = await Promise.all(hs.map(exe))
  await send(alice, { address: SWAP, abi: SwapArt.abi, functionName: 'revoke', args: [] })
  await tick()
  const e2 = await Promise.all(hs.map(exe)), e2l = await exeListed(hs)
  await engine.revalidate(1) // even a full sweep must not revive them
  const s2 = await Promise.all(hs.map(status))
  const listed = await Promise.all(hs.map(inBook))
  const chk = await onchainCheck(o1)
  check('S3: post → authorize → revoke: orders stay invalid_signer and unlisted, while check() on-chain reports no error',
    s0.every((x) => x === 'open') && s1.every((x) => x === 'invalid_signer') && s2.every((x) => x === 'invalid_signer') && listed.every((x) => !x) && chk.length === 0,
    `${s0[0]} → ${s1[0]} → after revoke ${s2[0]}; listed ${listed.some(Boolean)}; check(): [${chk.join(',')}]`)

  check('S7: executableOnChain — open → true; invalid_signer while delegated → false; after revoke() → true (by hash and by signer)',
    e0open === true && e1.every((x) => x === false) && e2.every((x) => x === true) && e2l.every((x) => x === true), `delegated ${e1.join(',')}; after revoke ${e2.join(',')} / listed ${e2l.join(',')}`)

  // S4 anyone holding the saved signature can still fill it; the indexer then records the fill
  const rc4 = await send(bob, { address: SWAP, abi: SwapArt.abi, functionName: 'swapAnySender', args: args(o1, bob.address) })
  await tick()
  check('S4: swapAnySender with the saved signature still succeeds after revoke(); order then marked filled', rc4.status === 'success' && (await status(hs[0])) === 'filled')

  // S5 cancel() is what really kills it
  await send(alice, { address: SWAP, abi: SwapArt.abi, functionName: 'cancel', args: [[BigInt(o2.nonce)]] })
  let reverted = null
  try { await pub.simulateContract({ account: bob.account, address: SWAP, abi: SwapArt.abi, functionName: 'swapAnySender', args: args(o2, bob.address) }) } catch (e) { reverted = e.walk?.((x) => x.data?.errorName)?.data?.errorName ?? 'reverted' }
  await tick()
  check('S5: after cancel() the fill reverts (NonceAlreadyUsed) and the order is cancelled', reverted === 'NonceAlreadyUsed' && (await status(hs[1])) === 'cancelled', `swapAnySender → ${reverted}`)

  const e8 = [await exe(hs[0]), await exe(hs[1]), await exe(hs[2])]
  const e8l = await exeListed(hs)

  // S6 reorg: a fill of a revoked order that is reorged out goes back to invalid_signer, never to open
  const snap = await test.snapshot()
  await send(bob, { address: SWAP, abi: SwapArt.abi, functionName: 'swapAnySender', args: args(o3, bob.address) })
  await tick()
  const s6a = await status(hs[2])
  let reorg = null
  engine.once('reorg', (e) => { reorg = e })
  await test.revert({ id: snap })
  await test.mine({ blocks: 4 })
  await tick()
  const s6b = await status(hs[2])
  check('S6: reorged-out fill of a revoked order rolls back to invalid_signer (not open, not listed)', s6a === 'filled' && reorg?.rolledBack >= 1 && s6b === 'invalid_signer' && !(await inBook(hs[2])), `${s6a} → reorg → ${s6b}`)

  const e8r = await exe(hs[2])
  check('S8: executableOnChain false once filled or cancelled; still true for the untouched revoked order, also after a reorg',
    e8[0] === false && e8[1] === false && e8[2] === true && e8l.join() === 'false,false,true' && e8r === true, `filled ${e8[0]}, cancelled ${e8[1]}, open-on-chain ${e8[2]}; after reorg ${e8r}`)

  await app.stop()
  const failed = results.filter((x) => !x).length
  console.log(`\n${results.length - failed}/${results.length} checks passed`)
  process.exit(failed ? 1 : 0)
}
main().catch((e) => { console.error(e); process.exit(1) })
