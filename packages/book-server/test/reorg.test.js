// Reorgs with anvil snapshot/revert (reorgDepth 64):
//   R1–R3 depth 1, 5, 63: a fill on the abandoned branch is rolled back, the order is open again; an event that exists only
//         on the new branch is indexed; a fill on the common prefix stays filled
//   R4    depth 65 (> reorgDepth): documented limit — the old fill is NOT rolled back and a new-branch cancel in the first
//         block is only seen as 'used' (both beyond finality on Ethereum)
//   R5    reorg in the middle of a multi-chunk catch-up (logChunk 5): detected on the next round, state corrected
import { createPublicClient, createWalletClient, createTestClient, http, parseAbi, encodeAbiParameters, keccak256, toHex, parseEther } from 'viem'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import { deploy } from '@fondaco/contracts/deploy'
import { swapErc20Abi } from '@fondaco/contracts'
import { startRpcProxy } from '@fondaco/testkit'
import { start } from '../dist/index.js'

const FORK_URL = process.env.FORK_URL || 'http://127.0.0.1:8545'
const USDC = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', WETH = '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2'
const chain = { id: 1, name: 'fork', nativeCurrency: { name: 'ETH', symbol: 'ETH', decimals: 18 }, rpcUrls: { default: { http: [FORK_URL] } } }
const pub = createPublicClient({ chain, transport: http(FORK_URL) })
const test = createTestClient({ chain, mode: 'anvil', transport: http(FORK_URL) })
const ERC20 = parseAbi(['function approve(address,uint256)', 'function deposit() payable'])
const results = []
const check = (n, ok, d = '') => { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'} | ${n}${d ? ' | ' + d : ''}`) }
const wait = async (hash) => { const rc = await pub.waitForTransactionReceipt({ hash }); if (rc.status !== 'success') throw new Error('reverted'); return rc }
async function wallet() { const account = privateKeyToAccount(generatePrivateKey()); await test.setBalance({ address: account.address, value: parseEther('100') }); return { account, address: account.address, client: createWalletClient({ account, chain, transport: http(FORK_URL) }) } }

const pk = generatePrivateKey()
await test.setBalance({ address: privateKeyToAccount(pk).address, value: parseEther('10') })
const startBlock = await pub.getBlockNumber()
const { swap: SWAP } = await deploy({ rpc: FORK_URL, privateKey: pk, feeBps: 30, feeWallet: privateKeyToAccount(generatePrivateKey()).address, owner: privateKeyToAccount(generatePrivateKey()).address, log: () => {} })
const [alice, bob] = [await wallet(), await wallet()]
await test.setStorageAt({ address: USDC, index: keccak256(encodeAbiParameters([{ type: 'address' }, { type: 'uint256' }], [alice.address, 9n])), value: toHex(10n ** 13n, { size: 32 }) })
await wait(await alice.client.writeContract({ address: USDC, abi: ERC20, functionName: 'approve', args: [SWAP, 2n ** 256n - 1n] }))
await wait(await bob.client.writeContract({ address: WETH, abi: ERC20, functionName: 'deposit', value: 50n * 10n ** 18n }))
await wait(await bob.client.writeContract({ address: WETH, abi: ERC20, functionName: 'approve', args: [SWAP, 2n ** 256n - 1n] }))

const proxy = await startRpcProxy(FORK_URL)
const app = await start({ port: 0, db: ':memory:', rateLimit: { capacity: 10000, refillPerSec: 1000 },
  chains: { 1: { rpc: proxy.url, swap: SWAP, startBlock: startBlock.toString(), pollMs: 3_600_000, fullSweepMs: 3_600_000, logChunk: 5, signalMaxBlocks: 50,
    tokens: { [USDC]: { symbol: 'USDC', decimals: 6 }, [WETH]: { symbol: 'WETH', decimals: 18 } } } } }, { log: () => {} })
const { engine } = app
const base = `http://127.0.0.1:${app.server.address().port}`
const cfg = (await (await fetch(`${base}/config`)).json())[1]
const tick = async () => { while (engine.chain(1).busy) await new Promise((r) => setTimeout(r, 20)); return engine.tick(1) }
const st = (h) => engine.db.byHash(h).status
const reorgs = []
engine.on('reorg', (e) => reorgs.push(e))
let nonce = 1n
async function bid() {
  const now = (await pub.getBlock()).timestamp
  const message = { nonce: nonce++, expiry: now + 30n * 86400n / 5n, signerWallet: alice.address, signerToken: USDC, signerAmount: 100n * 10n ** 6n, protocolFee: 30n, senderWallet: '0x0000000000000000000000000000000000000000', senderToken: WETH, senderAmount: 4n * 10n ** 16n }
  const sig = await alice.account.signTypedData({ domain: cfg.domain, types: cfg.types, primaryType: 'OrderERC20', message })
  const o = { ...Object.fromEntries(Object.entries(message).map(([k, x]) => [k, String(x)])), v: parseInt(sig.slice(130, 132), 16), r: '0x' + sig.slice(2, 66), s: '0x' + sig.slice(66, 130) }
  const [res] = (await (await fetch(`${base}/orders`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ chainId: 1, orders: [o] }) })).json()).results
  return { o, h: res.hash }
}
const fill = async (o) => wait(await bob.client.writeContract({ address: SWAP, abi: swapErc20Abi, functionName: 'swapAnySender',
  args: [bob.address, BigInt(o.nonce), BigInt(o.expiry), o.signerWallet, o.signerToken, BigInt(o.signerAmount), o.senderToken, BigInt(o.senderAmount), o.v, o.r, o.s] }))
const cancel = (o) => alice.client.writeContract({ address: SWAP, abi: swapErc20Abi, functionName: 'cancel', args: [[BigInt(o.nonce)]] }).then(wait)
const used = (o) => pub.readContract({ address: SWAP, abi: swapErc20Abi, functionName: 'nonceUsed', args: [alice.address, BigInt(o.nonce)] })

await tick()
for (const depth of [1, 5, 63, 65]) {
  const keep = await bid(), gone = await bid(), late = await bid()
  await tick()
  await fill(keep.o) // common prefix: survives the reorg
  await tick()
  const snap = await test.snapshot()
  await fill(gone.o) // first block of the abandoned branch
  if (depth > 1) await test.mine({ blocks: depth - 1 })
  await tick()
  const before = st(gone.h)
  await test.revert({ id: snap })
  await cancel(late.o) // only on the new branch
  await test.mine({ blocks: depth + 1 })
  const n0 = reorgs.length
  await tick()
  const ev = reorgs[n0]
  const s = { keep: st(keep.h), gone: st(gone.h), late: st(late.h) }
  if (depth <= 63) {
    check(`R${depth === 1 ? 1 : depth === 5 ? 2 : 3}: reorg of depth ${depth} → abandoned fill rolled back (open), new-branch cancel indexed, common-prefix fill kept`,
      before === 'filled' && !!ev && s.gone === 'open' && !(await used(gone.o)) && s.late === 'cancelled' && s.keep === 'filled', `${before} → ${s.gone}; late ${s.late}; keep ${s.keep}; rolled back ${ev?.rolledBack}`)
  } else {
    // beyond the window: the abandoned fill stays 'filled' (wrong, but never offered: not fillable in the book), and the new
    // branch's cancel in the first block is outside the re-read range too: the full sweep sees its nonce consumed → 'used' (safe)
    check('R4: reorg of depth 65 > reorgDepth 64 → detected; the fill 65 blocks back is NOT rolled back; the new-branch cancel is seen as used (documented limit)',
      before === 'filled' && !!ev && s.gone === 'filled' && !(await used(gone.o)) && s.late === 'used', `stored ${s.gone} while nonceUsed on-chain = ${await used(gone.o)}; late ${s.late}; rewound to ${ev?.rewoundTo}`)
  }
}

// R5 reorg in the middle of a catch-up of several chunks: the proxy swaps the chain right after the first chunk is read
const r5 = await bid()
await tick()
const snap5 = await test.snapshot()
await fill(r5.o) // in the first chunk of the catch-up
await test.mine({ blocks: 19 })
let swapped = false
proxy.set({ after: async (req, result) => {
  const addr = req.params?.[0]?.address
  if (!swapped && req.method === 'eth_getLogs' && typeof addr === 'string' && addr.toLowerCase() === SWAP.toLowerCase()) {
    swapped = true
    await test.revert({ id: snap5 }) // the chain changes while the indexer is between chunks
    await test.mine({ blocks: 25 })
  }
  return result
} })
const getLogsBefore = proxy.counts.eth_getLogs ?? 0
await tick()
proxy.clear()
const s5a = st(r5.h), chunks = (proxy.counts.eth_getLogs ?? 0) - getLogsBefore
const n5 = reorgs.length
await tick()
const s5b = st(r5.h)
check('R5: reorg during a multi-chunk catch-up → the fill read from the old branch is rolled back on the next round', swapped && chunks >= 4 && s5a === 'filled' && reorgs.length === n5 + 1 && s5b === 'open' && !(await used(r5.o)) &&
  engine.db.getMeta('last_block:1') === String(await pub.getBlockNumber({ cacheTime: 0 })), `${chunks} getLogs in the catch-up; ${s5a} → reorg → ${s5b}`)

await app.stop()
await proxy.close()
const failed = results.filter((x) => !x).length
console.log(`\n${results.length - failed}/${results.length} checks passed`)
process.exit(failed ? 1 : 0)
