// One test fill on a deployment, balances verified: SIGNER sells 0.001 WETH for 1 USDC to TAKER (swapAnySender), the
// protocol fee (paid by the signer, in WETH) goes to the fee wallet. Token addresses come from testnets.json and are
// checked on-chain (code, symbol, decimals) before anything is signed.
// Prerequisites: SIGNER has ≥ 0.002 ETH (it wraps what it needs), TAKER holds ≥ 1 test USDC (Circle faucet) and gas.
//   node scripts/test-fill.mjs <sepolia|baseSepolia>   env: RPC_URL (optional), SWAP, SIGNER_KEY, TAKER_KEY, FEE_WALLET
// Exported runTestFill() is used by testnet.mjs --rehearse on local forks.
import { readFileSync } from 'node:fs'
import { createPublicClient, createWalletClient, http, getAddress, parseAbi } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'

const NETS = JSON.parse(readFileSync(new URL('./testnets.json', import.meta.url)))
const ERC20 = parseAbi(['function balanceOf(address) view returns (uint256)', 'function approve(address,uint256) returns (bool)', 'function symbol() view returns (string)', 'function decimals() view returns (uint8)', 'function deposit() payable'])
const SWAP_ABI = parseAbi(['function swapAnySender(address recipient, uint256 nonce, uint256 expiry, address signerWallet, address signerToken, uint256 signerAmount, address senderToken, uint256 senderAmount, uint8 v, bytes32 r, bytes32 s)', 'function protocolFee() view returns (uint256)'])
const TYPES = { OrderERC20: [{ name: 'nonce', type: 'uint256' }, { name: 'expiry', type: 'uint256' }, { name: 'signerWallet', type: 'address' }, { name: 'signerToken', type: 'address' }, { name: 'signerAmount', type: 'uint256' }, { name: 'protocolFee', type: 'uint256' }, { name: 'senderWallet', type: 'address' }, { name: 'senderToken', type: 'address' }, { name: 'senderAmount', type: 'uint256' }] }

export async function runTestFill({ net, rpc, swap, signerKey, takerKey, feeWallet, log = console.log }) {
  const n = NETS[net]; if (!n) throw new Error(`unknown network ${net}`)
  const pub = createPublicClient({ transport: http(rpc) })
  const chainId = await pub.getChainId()
  if (chainId !== n.chainId) throw new Error(`RPC is chain ${chainId}, expected ${n.chainId} (${n.name})`)
  const chain = { id: chainId, name: n.name, nativeCurrency: { name: 'ETH', symbol: 'ETH', decimals: 18 }, rpcUrls: { default: { http: [rpc] } } }
  for (const [t, sym, dec] of [[n.weth, 'WETH', 18], [n.usdc, 'USDC', 6]]) {
    const code = await pub.getCode({ address: t })
    const s = await pub.readContract({ address: t, abi: ERC20, functionName: 'symbol' }), d = await pub.readContract({ address: t, abi: ERC20, functionName: 'decimals' })
    if (!code || code === '0x' || s !== sym || Number(d) !== dec) throw new Error(`token ${t}: code ${!!code}, symbol ${s}, decimals ${d} — expected ${sym}/${dec}`)
  }
  const signer = privateKeyToAccount(signerKey), taker = privateKeyToAccount(takerKey)
  const ws = createWalletClient({ account: signer, chain, transport: http(rpc) }), wt = createWalletClient({ account: taker, chain, transport: http(rpc) })
  const wait = async (h, what) => { const rc = await pub.waitForTransactionReceipt({ hash: h }); if (rc.status !== 'success') throw new Error(`${what} reverted ${h}`); log(`${what}: ${h} (gas ${rc.gasUsed})`); return rc }
  const bal = (t, a) => pub.readContract({ address: t, abi: ERC20, functionName: 'balanceOf', args: [a] })
  const fee = await pub.readContract({ address: swap, abi: SWAP_ABI, functionName: 'protocolFee' })
  const amount = 10n ** 15n, price = 10n ** 6n, feeAmt = (amount * fee) / 10_000n
  const gas = []
  if ((await bal(n.weth, signer.address)) < amount + feeAmt) gas.push(await wait(await ws.writeContract({ address: n.weth, abi: ERC20, functionName: 'deposit', value: amount + feeAmt }), 'signer WETH.deposit'))
  gas.push(await wait(await ws.writeContract({ address: n.weth, abi: ERC20, functionName: 'approve', args: [swap, amount + feeAmt] }), 'signer WETH.approve'))
  gas.push(await wait(await wt.writeContract({ address: n.usdc, abi: ERC20, functionName: 'approve', args: [swap, price] }), 'taker USDC.approve'))
  const before = { sW: await bal(n.weth, signer.address), sU: await bal(n.usdc, signer.address), tW: await bal(n.weth, taker.address), tU: await bal(n.usdc, taker.address), f: await bal(n.weth, getAddress(feeWallet)) }
  const now = (await pub.getBlock()).timestamp
  const message = { nonce: BigInt(Date.now()), expiry: now + 600n, signerWallet: signer.address, signerToken: n.weth, signerAmount: amount, protocolFee: fee, senderWallet: '0x0000000000000000000000000000000000000000', senderToken: n.usdc, senderAmount: price }
  const sig = await signer.signTypedData({ domain: { name: 'SWAP_ERC20', version: '4.3', chainId, verifyingContract: swap }, types: TYPES, primaryType: 'OrderERC20', message })
  const v = parseInt(sig.slice(130, 132), 16), r = '0x' + sig.slice(2, 66), s = '0x' + sig.slice(66, 130)
  gas.push(await wait(await wt.writeContract({ address: swap, abi: SWAP_ABI, functionName: 'swapAnySender', args: [taker.address, message.nonce, message.expiry, signer.address, n.weth, amount, n.usdc, price, v, r, s] }), 'taker swapAnySender'))
  const after = { sW: await bal(n.weth, signer.address), sU: await bal(n.usdc, signer.address), tW: await bal(n.weth, taker.address), tU: await bal(n.usdc, taker.address), f: await bal(n.weth, getAddress(feeWallet)) }
  const ok = before.sW - after.sW === amount + feeAmt && after.sU - before.sU === price && after.tW - before.tW === amount && before.tU - after.tU === price && after.f - before.f === feeAmt
  return { ok, chainId, amount, price, fee: feeAmt, deltas: { signerWETH: after.sW - before.sW, signerUSDC: after.sU - before.sU, takerWETH: after.tW - before.tW, takerUSDC: after.tU - before.tU, feeWallet: after.f - before.f }, gasUsed: gas.map((g) => g.gasUsed) }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const net = process.argv[2], e = process.env, n = NETS[net]
  runTestFill({ net, rpc: e.RPC_URL || e[n?.rpcEnv] || n?.defaultRpc, swap: getAddress(e.SWAP), signerKey: e.SIGNER_KEY, takerKey: e.TAKER_KEY, feeWallet: e.FEE_WALLET })
    .then((r) => { console.log(JSON.stringify(r, (_, x) => (typeof x === 'bigint' ? x.toString() : x), 2)); process.exit(r.ok ? 0 : 1) })
    .catch((err) => { console.error(err.message); process.exit(1) })
}
