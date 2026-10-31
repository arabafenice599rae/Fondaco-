// Regression (found by the storm load test): snapshots with more than 400 calls are pinned to one block number. viem caches
// getBlockNumber (default 4 s), so the pin could point at a block BEFORE the events the round is reacting to: the round re-read
// the right orders but on old state, and left them unfunded until the next full sweep.
import { createPublicClient, createWalletClient, createTestClient, http, parseAbi, encodeAbiParameters, keccak256, toHex, parseEther } from 'viem'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import { deploy } from '@fondaco/contracts/deploy'
import { start } from '../dist/index.js'

const FORK_URL = process.env.FORK_URL || 'http://127.0.0.1:8545'
const USDC = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', WETH = '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2'
const chain = { id: 1, name: 'fork', nativeCurrency: { name: 'ETH', symbol: 'ETH', decimals: 18 }, rpcUrls: { default: { http: [FORK_URL] } } }
const pub = createPublicClient({ chain, transport: http(FORK_URL), cacheTime: 0 })
const test = createTestClient({ chain, mode: 'anvil', transport: http(FORK_URL) })
const ERC20 = parseAbi(['function approve(address,uint256)', 'function transfer(address,uint256)'])
const results = []
const check = (n, ok, d = '') => { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'} | ${n}${d ? ' | ' + d : ''}`) }
const slot = (a) => keccak256(encodeAbiParameters([{ type: 'address' }, { type: 'uint256' }], [a, 9n]))

const pk = generatePrivateKey()
await test.setBalance({ address: privateKeyToAccount(pk).address, value: parseEther('10') })
const startBlock = await pub.getBlockNumber()
const { swap: SWAP } = await deploy({ rpc: FORK_URL, privateKey: pk, feeBps: 30, feeWallet: privateKeyToAccount(generatePrivateKey()).address, owner: privateKeyToAccount(generatePrivateKey()).address, log: () => {} })
const signers = Array.from({ length: 3 }, () => privateKeyToAccount(generatePrivateKey()))
const whale = privateKeyToAccount(generatePrivateKey())
for (const a of [...signers, whale]) await test.setBalance({ address: a.address, value: parseEther('10') })
await test.setStorageAt({ address: USDC, index: slot(whale.address), value: toHex(10n ** 15n, { size: 32 }) })
for (const s of signers) {
  await test.setStorageAt({ address: USDC, index: slot(s.address), value: toHex(10n ** 12n, { size: 32 }) })
  const w = createWalletClient({ account: s, chain, transport: http(FORK_URL) })
  await pub.waitForTransactionReceipt({ hash: await w.writeContract({ address: USDC, abi: ERC20, functionName: 'approve', args: [SWAP, 2n ** 256n - 1n] }) })
}
// default pollingInterval (4 s cache) in the server's own client, as in production
const app = await start({ port: 0, db: ':memory:', rateLimit: { capacity: 1e6, refillPerSec: 1e6 },
  chains: { 1: { rpc: FORK_URL, swap: SWAP, startBlock: startBlock.toString(), pollMs: 3_600_000, fullSweepMs: 3_600_000,
    tokens: { [USDC]: { symbol: 'USDC', decimals: 6 }, [WETH]: { symbol: 'WETH', decimals: 18 } } } } }, { log: () => {} })
const { engine } = app
const cfg = engine.publicConfig()[1]
const now = (await pub.getBlock()).timestamp
let nonce = 1n
for (const s of signers) {
  const os = []
  for (let i = 0; i < 150; i++) {
    const m = { nonce: nonce++, expiry: now + 3600n, signerWallet: s.address, signerToken: USDC, signerAmount: 10n ** 6n * BigInt(10 + i), protocolFee: 30n, senderWallet: '0x0000000000000000000000000000000000000000', senderToken: WETH, senderAmount: 10n ** 15n }
    const sig = await s.signTypedData({ domain: cfg.domain, types: cfg.types, primaryType: 'OrderERC20', message: m })
    os.push({ ...Object.fromEntries(Object.entries(m).map(([k, x]) => [k, String(x)])), v: parseInt(sig.slice(130, 132), 16), r: '0x' + sig.slice(2, 66), s: '0x' + sig.slice(66, 130) })
  }
  for (let i = 0; i < os.length; i += 50) await engine.submit(1, os.slice(i, i + 50))
}
await engine.tick(1)
const open = () => engine.db.live(1).filter((r) => r.status === 'open').length
const open0 = open()

// empty the three signers WITHOUT events, and let a full sweep (> 400 calls: pinned) mark them unfunded and prime viem's cache
for (const s of signers) await test.setStorageAt({ address: USDC, index: slot(s.address), value: toHex(0n, { size: 32 }) })
await test.mine({ blocks: 1 })
const full = await engine.revalidate(1)
const open1 = open()
// within the cache window: incoming transfers in one block, then the incremental round (again > 400 calls → pinned)
await test.setAutomine(false)
const ww = createWalletClient({ account: whale, chain, transport: http(FORK_URL) })
let n = await pub.getTransactionCount({ address: whale.address, blockTag: 'pending' })
await Promise.all(signers.map((s) => ww.writeContract({ address: USDC, abi: ERC20, functionName: 'transfer', args: [s.address, 10n ** 12n], gas: 80_000n, nonce: n++ })))
await test.mine({ blocks: 1 })
await test.setAutomine(true)
const t0 = performance.now()
const inc = await engine.tick(1)
const ms = performance.now() - t0
const open2 = open()
check('P1: incremental round with > 400 calls reads the CURRENT block (no cached block number): 450 orders re-funded in the same round',
  open0 === 450 && full.checked === 450 && open1 === 0 && inc.full === false && inc.checked === 450 && open2 === 450, `open ${open0} → emptied ${open1} → after incoming transfers ${open2} (round ${ms.toFixed(0)} ms, ${inc.checked} checked)`)

await app.stop()
const failed = results.filter((x) => !x).length
console.log(`\n${results.length - failed}/${results.length} checks passed`)
process.exit(failed ? 1 : 0)
