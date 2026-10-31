// MEV protection on a local mainnet fork: private submission (spied/dropping transports stand in for a protected RPC
// with revert protection), protected cancels, mode selection, price guards.
import { readFileSync } from 'node:fs'
import { createPublicClient, createWalletClient, createTestClient, createClient, http, custom, parseAbi, encodeAbiParameters, keccak256, toHex, getAddress } from 'viem'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import { createTaker, plan, SWAP_TAKER_ABI } from '../client/taker.js'
import { createSubmitter, cancelOrders, priceCheck, isStale } from '../client/protect.js'

const FORK_URL = process.env.FORK_URL || 'http://127.0.0.1:8545'
const USDC = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48'
const WETH = '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2'
const ZERO = '0x0000000000000000000000000000000000000000'
const FEE = 30n
const chain = { id: 1, name: 'fork', nativeCurrency: { name: 'ETH', symbol: 'ETH', decimals: 18 }, rpcUrls: { default: { http: [FORK_URL] } } }
const transport = () => http(FORK_URL, { timeout: 180_000 })
const ERC20 = parseAbi(['function approve(address,uint256)', 'function deposit() payable', 'function balanceOf(address) view returns (uint256)'])
const pub = createPublicClient({ chain, transport: transport(), pollingInterval: 200 })
const test = createTestClient({ chain, mode: 'hardhat', transport: transport() })
const SwapArt = JSON.parse(readFileSync(new URL('./fixtures/SwapERC20.json', import.meta.url)))
const results = []
const check = (n, ok, d = '') => { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'} | ${n}${d ? ' | ' + d : ''}`) }

async function wallet() {
  const account = privateKeyToAccount(generatePrivateKey())
  await test.setBalance({ address: account.address, value: 10n ** 21n })
  return { account, address: account.address, client: createWalletClient({ account, chain, transport: transport() }) }
}
async function send(w, req) { const rc = await pub.waitForTransactionReceipt({ hash: await w.client.writeContract(req) }); if (rc.status !== 'success') throw new Error('reverted'); return rc }
const giveUsdc = (a, v) => test.setStorageAt({ address: USDC, index: keccak256(encodeAbiParameters([{ type: 'address' }, { type: 'uint256' }], [a, 9n])), value: toHex(v, { size: 32 }) })
const U = (n) => BigInt(n) * 10n ** 6n

/** A stand-in for a protected RPC: counts raw transactions; `drop` swallows the next one (revert protection: never included). */
function spyTransport() {
  const base = createClient({ transport: transport() })
  const spy = { raw: 0, drop: 0 }
  spy.transport = custom({
    async request({ method, params }) {
      if (method === 'eth_sendRawTransaction') {
        spy.raw++
        if (spy.drop > 0) { spy.drop--; return keccak256(params[0]) }
      }
      return base.request({ method, params })
    },
  })
  return spy
}

async function main() {
  const [owner, alice, bob, carol, fw] = await Promise.all(Array.from({ length: 5 }, wallet))
  const SWAP = getAddress((await pub.waitForTransactionReceipt({ hash: await owner.client.deployContract({ abi: SwapArt.abi, bytecode: SwapArt.bytecode, args: [FEE, FEE, fw.address, 0n, 0n] }) })).contractAddress)
  await send(alice, { address: WETH, abi: ERC20, functionName: 'deposit', value: 10n ** 19n })
  await send(alice, { address: WETH, abi: ERC20, functionName: 'approve', args: [SWAP, 2n ** 256n - 1n] })
  for (const w of [bob, carol]) { await giveUsdc(w.address, U(1_000_000)); await send(w, { address: USDC, abi: ERC20, functionName: 'approve', args: [SWAP, 2n ** 256n - 1n] }) }

  const domain = { name: 'SWAP_ERC20', version: '4.3', chainId: 1, verifyingContract: SWAP }
  const types = { OrderERC20: [{ name: 'nonce', type: 'uint256' }, { name: 'expiry', type: 'uint256' }, { name: 'signerWallet', type: 'address' }, { name: 'signerToken', type: 'address' }, { name: 'signerAmount', type: 'uint256' }, { name: 'protocolFee', type: 'uint256' }, { name: 'senderWallet', type: 'address' }, { name: 'senderToken', type: 'address' }, { name: 'senderAmount', type: 'uint256' }] }
  let nonceSeq = 1n
  async function ask(weth, usdc) {
    const now = (await pub.getBlock()).timestamp
    const message = { nonce: nonceSeq++, expiry: now + 3600n, signerWallet: alice.address, signerToken: WETH, signerAmount: weth, protocolFee: FEE, senderWallet: ZERO, senderToken: USDC, senderAmount: usdc }
    const sig = await alice.account.signTypedData({ domain, types, primaryType: 'OrderERC20', message })
    return { ...message, v: parseInt(sig.slice(130, 132), 16), r: '0x' + sig.slice(2, 66), s: '0x' + sig.slice(66, 130) }
  }
  const entries = (os) => os.map((order, i) => ({ hash: `o${i}`, order }))
  const fillDirect = (w, o) => w.client.writeContract({ address: SWAP, abi: SWAP_TAKER_ABI, functionName: 'swapAnySender', args: [w.address, o.nonce, o.expiry, o.signerWallet, o.signerToken, o.signerAmount, o.senderToken, o.senderAmount, o.v, o.r, o.s] })

  // P1 local account + protected RPC → the fill goes privately
  const spy1 = spyTransport()
  const sub1 = createSubmitter({ publicClient: pub, walletClient: bob.client, chainId: 1, privateTransport: spy1.transport })
  const t1 = createTaker({ publicClient: pub, walletClient: bob.client, swap: SWAP, submitter: sub1 })
  const r1 = await t1.execute(await t1.verify(plan(entries([await ask(10n ** 17n, U(250))]), U(250))))
  check('P1: fill sent through the protected RPC', sub1.mode === 'private' && spy1.raw === 1 && r1.filled.length === 1 && r1.protection === 'private', `mode ${sub1.mode}, raw tx via private RPC: ${spy1.raw}`)

  // P2 revert protection: leg 1 is taken by someone else and never included → free; leg 2 reuses the nonce and fills
  const spy2 = spyTransport(); spy2.drop = 1
  const sub2 = createSubmitter({ publicClient: pub, walletClient: bob.client, chainId: 1, privateTransport: spy2.transport })
  const [o2a, o2b] = [await ask(10n ** 17n, U(251)), await ask(10n ** 17n, U(252))]
  let raced = false
  const t2 = createTaker({ publicClient: pub, walletClient: bob.client, swap: SWAP, submitter: sub2, privateTimeoutMs: 4000,
    onUpdate: (e) => { if (e.type === 'pending' && e.leg === 0 && !raced) { raced = true; fillDirect(carol, o2a) } } })
  const n2 = await pub.getTransactionCount({ address: bob.address })
  const bal2 = await pub.getBalance({ address: bob.address })
  const r2 = await t2.execute(await t2.verify(plan(entries([o2a, o2b]), U(600))))
  const n2b = await pub.getTransactionCount({ address: bob.address })
  const gasLeg2 = r2.filled[0] ? (await pub.getTransactionReceipt({ hash: r2.filled[0].txHash })) : null
  const spent2 = bal2 - (await pub.getBalance({ address: bob.address }))
  check('P2: taken offer not included (no gas), next leg takes over the nonce and fills', r2.skipped.some((x) => x.reason === 'not_included' && x.costsGas === false) && r2.filled.length === 1 && n2b - n2 === 1 && gasLeg2 && spent2 === gasLeg2.gasUsed * gasLeg2.effectiveGasPrice,
    `skipped ${r2.skipped.map((x) => x.reason)}, filled ${r2.filled.length}, bob nonce +${n2b - n2}, ETH spent = gas of the filled leg only`)

  // P3 mode selection
  const jr = createWalletClient({ account: { address: bob.address, type: 'json-rpc' }, chain, transport: transport() })
  const m = [
    createSubmitter({ publicClient: pub, walletClient: jr, chainId: 1 }),
    createSubmitter({ publicClient: pub, walletClient: bob.client, chainId: 8453 }),
    createSubmitter({ publicClient: pub, walletClient: bob.client, chainId: 999 }),
    createSubmitter({ publicClient: pub, walletClient: bob.client, chainId: 1 }),
  ].map((x) => `${x.mode}/${x.why}`)
  check('P3: browser wallet → wallet mode; L2 → sequencer; unknown chain → none; local on mainnet → protected RPCs', m.join(',') === 'wallet/browser_wallet,wallet/sequencer,wallet/no_private_rpc,private/private_rpc', m.join(', '))

  // P4 protected cancel: one offer already filled, one still open → partly_taken, both nonces now used
  const [o4a, o4b] = [await ask(10n ** 16n, U(25)), await ask(10n ** 16n, U(26))]
  await pub.waitForTransactionReceipt({ hash: await fillDirect(carol, o4a) })
  const spy4 = spyTransport()
  const subA = createSubmitter({ publicClient: pub, walletClient: alice.client, chainId: 1, privateTransport: spy4.transport })
  const r4 = await cancelOrders({ publicClient: pub, walletClient: alice.client, submitter: subA, swap: SWAP, nonces: [o4a.nonce, o4b.nonce] })
  const used4 = await pub.readContract({ address: SWAP, abi: SWAP_TAKER_ABI, functionName: 'nonceUsed', args: [alice.address, o4b.nonce] })
  check('P4: cancel through the protected RPC; already-filled nonce reported as taken', spy4.raw === 1 && r4.status === 'partly_taken' && r4.taken.length === 1 && r4.taken[0] === o4a.nonce && used4, `${r4.status}, taken ${r4.taken}`)

  // P5 price guards
  const g = [priceCheck({ side: 'sell', price: 2425, mid: 2500 }), priceCheck({ side: 'sell', price: 2200, mid: 2500 }), priceCheck({ side: 'buy', price: 2560, mid: 2500 }), priceCheck({ side: 'sell', price: 2520, mid: 2500 })]
  check('P5: price guard levels (sell 3% under → warn, 12% under → danger, buy 2.4% over → warn, above market → ok); stale detection',
    g.map((x) => x.level).join(',') === 'warn,danger,warn,ok' && isStale({ side: 'sell', price: 2470, mid: 2500 }) && !isStale({ side: 'buy', price: 2470, mid: 2500 }), g.map((x) => `${x.level}(${x.deviationBps})`).join(' '))

  const failed = results.filter((x) => !x).length
  console.log(`\n${results.length - failed}/${results.length} checks passed`)
  process.exit(failed ? 1 : 0)
}
main().catch((e) => { console.error(e); process.exit(1) })
