// Property (fast-check) at engine level: the outcome does not depend on the order in which the events of ONE block reach
// the indexer. One block holds fills, a cancel, transfers (out and in), an approval and a WETH withdrawal across several
// signers; N engines with identical books each receive that block's logs in a different permutation (RPC proxy).
import fc from 'fast-check'
import { createPublicClient, createWalletClient, createTestClient, http, parseAbi, encodeAbiParameters, keccak256, toHex, parseEther } from 'viem'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import { deploy } from '@fondaco/contracts/deploy'
import { swapErc20Abi } from '@fondaco/contracts'
import { startRpcProxy } from '@fondaco/testkit'
import { openDb, Engine, parseConfig } from '../dist/index.js'
import { toChainCfg } from '../dist/config.js'

const FORK_URL = process.env.FORK_URL || 'http://127.0.0.1:8545'
const USDC = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', WETH = '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2'
const chain = { id: 1, name: 'fork', nativeCurrency: { name: 'ETH', symbol: 'ETH', decimals: 18 }, rpcUrls: { default: { http: [FORK_URL] } } }
const pub = createPublicClient({ chain, transport: http(FORK_URL), cacheTime: 0 })
const test = createTestClient({ chain, mode: 'anvil', transport: http(FORK_URL) })
const ERC20 = parseAbi(['function approve(address,uint256)', 'function transfer(address,uint256)', 'function deposit() payable', 'function withdraw(uint256)'])
const RUNS = Number(process.env.FC_RUNS_EVENTS || 20)
const results = []
const check = (n, ok, d = '') => { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'} | ${n}${d ? ' | ' + d : ''}`) }
async function wallet() { const account = privateKeyToAccount(generatePrivateKey()); await test.setBalance({ address: account.address, value: parseEther('100') }); return { account, address: account.address, client: createWalletClient({ account, chain, transport: http(FORK_URL) }) } }
const wait = async (h) => pub.waitForTransactionReceipt({ hash: h })
const U = (n) => BigInt(n) * 10n ** 6n

const pk = generatePrivateKey()
await test.setBalance({ address: privateKeyToAccount(pk).address, value: parseEther('10') })
const safe = privateKeyToAccount(generatePrivateKey()).address
const startBlock = await pub.getBlockNumber()
const { swap: SWAP } = await deploy({ rpc: FORK_URL, privateKey: pk, feeBps: 30, feeWallet: safe, owner: safe, log: () => {} })
await test.impersonateAccount({ address: safe })
await test.setBalance({ address: safe, value: parseEther('10') })
const signers = await Promise.all(Array.from({ length: 5 }, wallet))
const taker = await wallet()
for (const s of signers) {
  await test.setStorageAt({ address: USDC, index: keccak256(encodeAbiParameters([{ type: 'address' }, { type: 'uint256' }], [s.address, 9n])), value: toHex(U(1000), { size: 32 }) })
  await wait(await s.client.writeContract({ address: USDC, abi: ERC20, functionName: 'approve', args: [SWAP, 2n ** 256n - 1n] }))
}
await wait(await signers[4].client.writeContract({ address: WETH, abi: ERC20, functionName: 'deposit', value: 10n ** 18n }))
await wait(await signers[4].client.writeContract({ address: WETH, abi: ERC20, functionName: 'approve', args: [SWAP, 2n ** 256n - 1n] }))
await wait(await taker.client.writeContract({ address: WETH, abi: ERC20, functionName: 'deposit', value: 50n * 10n ** 18n }))
await wait(await taker.client.writeContract({ address: WETH, abi: ERC20, functionName: 'approve', args: [SWAP, 2n ** 256n - 1n] }))
await test.setStorageAt({ address: USDC, index: keccak256(encodeAbiParameters([{ type: 'address' }, { type: 'uint256' }], [taker.address, 9n])), value: toHex(U(100000), { size: 32 }) })
await wait(await taker.client.writeContract({ address: USDC, abi: ERC20, functionName: 'approve', args: [SWAP, 2n ** 256n - 1n] }))

// the same signed book for every engine: 3-slice ladders (USDC) for signers 0–3, one WETH ask for signer 4
const domain = { name: 'SWAP_ERC20', version: '4.3', chainId: 1, verifyingContract: SWAP }
const types = { OrderERC20: [{ name: 'nonce', type: 'uint256' }, { name: 'expiry', type: 'uint256' }, { name: 'signerWallet', type: 'address' }, { name: 'signerToken', type: 'address' }, { name: 'signerAmount', type: 'uint256' }, { name: 'protocolFee', type: 'uint256' }, { name: 'senderWallet', type: 'address' }, { name: 'senderToken', type: 'address' }, { name: 'senderAmount', type: 'uint256' }] }
const now = (await pub.getBlock()).timestamp
let n = 1n
const sign = async (s, give, amt, want, wamt) => {
  const message = { nonce: n++, expiry: now + 7200n, signerWallet: s.address, signerToken: give, signerAmount: amt, protocolFee: 30n, senderWallet: '0x0000000000000000000000000000000000000000', senderToken: want, senderAmount: wamt }
  const sig = await s.account.signTypedData({ domain, types, primaryType: 'OrderERC20', message })
  return { ...Object.fromEntries(Object.entries(message).map(([k, x]) => [k, String(x)])), v: parseInt(sig.slice(130, 132), 16), r: '0x' + sig.slice(2, 66), s: '0x' + sig.slice(66, 130) }
}
const book = []
for (const s of signers.slice(0, 4)) for (let i = 0; i < 3; i++) book.push(await sign(s, USDC, U(300), WETH, 12n * 10n ** 16n))
book.push(await sign(signers[4], WETH, 5n * 10n ** 17n, USDC, U(1250)))

const proxy = await startRpcProxy(FORK_URL)
const raw = { db: ':memory:', chains: { 1: { rpc: proxy.url, swap: SWAP, startBlock: startBlock.toString(), fullSweepMs: 3_600_000,
  tokens: { [USDC]: { symbol: 'USDC', decimals: 6 }, [WETH]: { symbol: 'WETH', decimals: 18 } } } } }
const engines = []
for (let i = 0; i <= RUNS; i++) {
  const e = new Engine(Object.entries(parseConfig(raw).chains).map(([id, c]) => toChainCfg(id, c)), openDb(':memory:'))
  await e.init()
  const res = await e.submit(1, book)
  if (res.some((r) => !r.hash)) throw new Error(`setup: ${JSON.stringify(res)}`)
  await e.tick(1)
  engines.push(e)
}

// ONE block with many interacting events (automine off)
await test.setAutomine(false)
const fillArgs = (o) => [taker.address, BigInt(o.nonce), BigInt(o.expiry), o.signerWallet, o.signerToken, BigInt(o.signerAmount), o.senderToken, BigInt(o.senderAmount), o.v, o.r, o.s]
const gas = { gas: 400_000n }
await taker.client.writeContract({ address: SWAP, abi: swapErc20Abi, functionName: 'swapAnySender', args: fillArgs(book[0]), ...gas }) // fill slice 1 of s0
await taker.client.writeContract({ address: SWAP, abi: swapErc20Abi, functionName: 'swapAnySender', args: fillArgs(book[12]), ...gas }) // fill the WETH ask
await signers[1].client.writeContract({ address: SWAP, abi: swapErc20Abi, functionName: 'cancel', args: [[BigInt(book[3].nonce)]], ...gas }) // s1 cancels its oldest
await signers[2].client.writeContract({ address: USDC, abi: ERC20, functionName: 'transfer', args: [taker.address, U(500)], ...gas }) // s2 keeps funds for 1 slice
await signers[3].client.writeContract({ address: USDC, abi: ERC20, functionName: 'approve', args: [SWAP, U(700)], ...gas }) // s3 allowance for 2 slices
await taker.client.writeContract({ address: USDC, abi: ERC20, functionName: 'transfer', args: [signers[2].address, U(200)], ...gas }) // incoming transfer to s2
await signers[4].client.writeContract({ address: WETH, abi: ERC20, functionName: 'withdraw', args: [10n ** 17n], ...gas })
await test.mine({ blocks: 1 })
await test.setAutomine(true)
const rc = await pub.getBlock({ blockTag: 'latest' })

// permutations of the logs of every eth_getLogs answer
const perms = fc.sample(fc.integer({ min: 1, max: 2 ** 31 - 1 }), { numRuns: RUNS, seed: 0x46 })
const shuffle = (arr, seed) => { const a = [...arr]; let x = seed; for (let i = a.length - 1; i > 0; i--) { x = (x * 1103515245 + 12345) & 0x7fffffff; const j = x % (i + 1); [a[i], a[j]] = [a[j], a[i]] } return a }
const states = []
let logsSeen = 0
for (let i = 0; i <= RUNS; i++) {
  proxy.set({ after: (req, result) => (req.method === 'eth_getLogs' && Array.isArray(result) ? ((logsSeen = Math.max(logsSeen, result.length)), i === 0 ? result : shuffle(result, perms[i - 1])) : result) })
  await engines[i].tick(1)
  states[i] = JSON.stringify(Object.fromEntries(book.map((o, k) => [k, engines[i].db.bySigner(1, o.signerWallet).find((r) => r.nonce === o.nonce).status])))
}
proxy.clear()
const distinct = new Set(states)
check(`E1: ${RUNS} permutations of the same block's logs → identical statuses in every engine`, distinct.size === 1, `${rc.transactions.length} transactions in block ${rc.number}; up to ${logsSeen} logs per answer; states ${distinct.size}`)
const s = JSON.parse(states[0])
check('E2: and the common result is the expected one (fills, cancel, re-allocation of ladders)',
  s[0] === 'filled' && s[12] === 'filled' && s[3] === 'cancelled' && s[4] === 'open' && s[5] === 'open' &&
  [s[6], s[7], s[8]].join() === 'open,open,unfunded' && [s[9], s[10], s[11]].join() === 'open,open,unfunded' && s[1] === 'open' && s[2] === 'open', JSON.stringify(s))
await proxy.close()
const failed = results.filter((x) => !x).length
console.log(`\n${results.length - failed}/${results.length} checks passed`)
process.exit(failed ? 1 : 0)
