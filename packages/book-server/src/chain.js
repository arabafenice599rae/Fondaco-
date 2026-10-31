// On-chain reads, batched through Multicall3 so N orders cost O(N / batch) RPC requests, not O(N).
import { createPublicClient, http, fallback, parseAbi, parseAbiItem, getAddress, hexToString } from 'viem'

export const SWAP_ABI = parseAbi([
  'function protocolFee() view returns (uint256)',
  'function nonceUsed(address signer, uint256 nonce) view returns (bool)',
  'function authorized(address signer) view returns (address)',
  'function check(address senderWallet, uint256 nonce, uint256 expiry, address signerWallet, address signerToken, uint256 signerAmount, address senderToken, uint256 senderAmount, uint8 v, bytes32 r, bytes32 s) view returns (bytes32[])',
  'event SwapERC20(uint256 indexed nonce, address indexed signerWallet)',
  'event Cancel(uint256 indexed nonce, address indexed signerWallet)',
  'event SetProtocolFee(uint256 protocolFee)',
])
export const ERC20_ABI = parseAbi([
  'function balanceOf(address) view returns (uint256)',
  'function allowance(address owner, address spender) view returns (uint256)',
])
export const MULTICALL3 = '0xcA11bde05977b3631167028862bE2a173976CA11'
const ZERO = '0x0000000000000000000000000000000000000000'

// Events on whitelisted tokens that can change a signer's balance or allowance (WETH9 moves balances with Deposit/Withdrawal,
// not Transfer). Topic 1 is the signer for all four; Transfer's topic 2 is the receiver.
export const EV_TRANSFER = parseAbiItem('event Transfer(address indexed from, address indexed to, uint256 value)')
export const EV_APPROVAL = parseAbiItem('event Approval(address indexed owner, address indexed spender, uint256 value)')
export const EV_DEPOSIT = parseAbiItem('event Deposit(address indexed dst, uint256 wad)')
export const EV_WITHDRAWAL = parseAbiItem('event Withdrawal(address indexed src, uint256 wad)')
export const EV_AUTHORIZE = parseAbiItem('event Authorize(address indexed signer, address indexed signerWallet)')
export const EV_REVOKE = parseAbiItem('event Revoke(address indexed signer, address indexed signerWallet)')
export const TOPIC = {
  transfer: '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef',
  approval: '0x8c5be1e5ebec7d5bd14f71427d1e84f3dd0314c0f7b2291e5b200ac8c7c3b925',
  deposit: '0xe1fffcc4923d04b559f4d29a8bfc6cda04eb5b0d3c460751c2402c5c5cc9109c',
  withdrawal: '0x7fcf532c15f0a6db0bd6d0e038bea71d30d808c7d98cb3bf7268a95bf5081b65',
}
export const padTopic = (addr) => '0x' + addr.slice(2).toLowerCase().padStart(64, '0')
export const topicAddr = (t) => getAddress('0x' + t.slice(26))

/** rpc: one URL or a list (viem fallback: ranked, automatic failover). */
export function makeClient(chainId, cfg, counter) {
  const urls = Array.isArray(cfg.rpc) ? cfg.rpc : [cfg.rpc]
  const one = (url) => http(url, {
    batch: false,
    retryCount: 3,
    timeout: cfg.rpcTimeoutMs ?? 15_000,
    // count raw HTTP requests so the optimization is measurable
    onFetchRequest: () => counter && counter.inc(chainId),
  })
  const transport = urls.length > 1 ? fallback(urls.map(one), { rank: false, retryCount: 1 }) : one(urls[0])
  return createPublicClient({ transport, chain: { id: Number(chainId), name: `chain-${chainId}`, nativeCurrency: { name: 'ETH', symbol: 'ETH', decimals: 18 }, rpcUrls: { default: { http: urls } } } })
}

const CHUNK = 400 // calls per multicall request; keeps calldata and eth_call gas well under node limits

/**
 * Consistent multicall: one chunk is atomic on 'latest'; several chunks are pinned to the same block
 * (one extra eth_blockNumber) so balances, allowances and nonces never mix two states.
 */
async function multicall(client, multicallAddress, contracts, blockNumber) {
  if (contracts.length === 0) return { results: [], blockNumber }
  if (blockNumber == null && contracts.length > CHUNK) blockNumber = await client.getBlockNumber()
  const out = []
  for (let i = 0; i < contracts.length; i += CHUNK) {
    // batchSize 0: viem would otherwise split every 1 KB of calldata into a separate RPC request
    const part = await client.multicall({ contracts: contracts.slice(i, i + CHUNK), allowFailure: true, multicallAddress, batchSize: 0, ...(blockNumber != null ? { blockNumber } : {}) })
    out.push(...part)
  }
  return { results: out, blockNumber }
}

/**
 * One batched snapshot for a set of orders:
 *  - balance and allowance for each distinct (signer, signerToken)
 *  - nonceUsed for each order (delegated signers are rejected, so signatory = signerWallet)
 *  - authorized(signer) for each distinct signer: once a delegate is set, the wallet's own signatures stop validating on-chain
 *  - SwapERC20.check() for orders of contract (EIP-1271) signers: their isValidSignature can change at any time
 */
export async function snapshot(client, chainCfg, orders, { blockNumber, contractSigned = () => false } = {}) {
  const swap = chainCfg.swap
  const pairs = new Map()
  for (const o of orders) pairs.set(`${o.signerWallet}|${o.signerToken}`, [o.signerWallet, o.signerToken])
  const pairList = [...pairs.values()]
  const signers = [...new Set(orders.map((o) => o.signerWallet))]
  const sigIdx = []
  orders.forEach((o, i) => { if (contractSigned(o, i)) sigIdx.push(i) })
  const calls = []
  for (const [owner, token] of pairList) {
    calls.push({ address: token, abi: ERC20_ABI, functionName: 'balanceOf', args: [owner] })
    calls.push({ address: token, abi: ERC20_ABI, functionName: 'allowance', args: [owner, swap] })
  }
  for (const o of orders) calls.push({ address: swap, abi: SWAP_ABI, functionName: 'nonceUsed', args: [o.signerWallet, o.nonce] })
  for (const s of signers) calls.push({ address: swap, abi: SWAP_ABI, functionName: 'authorized', args: [s] })
  for (const i of sigIdx) {
    const o = orders[i]
    calls.push({ address: swap, abi: SWAP_ABI, functionName: 'check', args: [o.senderWallet, o.nonce, o.expiry, o.signerWallet, o.signerToken, o.signerAmount, o.senderToken, o.senderAmount, o.v, o.r, o.s] })
  }
  const { results: res, blockNumber: at } = await multicall(client, chainCfg.multicall || MULTICALL3, calls, blockNumber)

  const funds = new Map()
  pairList.forEach(([owner, token], i) => {
    const bal = res[2 * i], alw = res[2 * i + 1]
    const available = bal.status === 'success' && alw.status === 'success' ? (bal.result < alw.result ? bal.result : alw.result) : 0n
    funds.set(`${owner}|${token}`, available)
  })
  let k = pairList.length * 2
  const nonceUsed = orders.map((_, i) => (res[k + i].status === 'success' ? res[k + i].result : false))
  k += orders.length
  // fail closed: an unreadable authorized() counts as delegated
  const delegated = new Set(signers.filter((s, i) => res[k + i].status !== 'success' || getAddress(res[k + i].result) !== ZERO))
  k += signers.length
  const badSignature = new Set()
  sigIdx.forEach((oi, j) => {
    const r = res[k + j]
    const errs = r.status === 'success' ? r.result.map((e) => hexToString(e, { size: 32 }).replace(/\0+$/, '')) : ['CallFailed']
    if (errs.some((e) => e === 'SignatureInvalid' || e === 'CallFailed')) badSignature.add(oi)
  })
  return { funds, nonceUsed, delegated, badSignature, blockNumber: at }
}

export const readFee = (client, swap) => client.readContract({ address: swap, abi: SWAP_ABI, functionName: 'protocolFee' })
