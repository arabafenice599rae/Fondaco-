// On-chain reads, batched through Multicall3 so N orders cost O(N / batch) RPC requests, not O(N).
import { createPublicClient, http, fallback, parseAbi, parseAbiItem, getAddress, hexToString, type Abi, type Address, type Hex, type PublicClient } from 'viem'
import { MULTICALL3 } from '@fondaco/contracts'
import type { ChainCfg, NormalizedOrder } from './types.js'

export { MULTICALL3 }
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
} as const satisfies Record<string, Hex>
export const padTopic = (a: string): Hex => `0x${a.slice(2).toLowerCase().padStart(64, '0')}`
export const topicAddr = (t: string): Address => getAddress(`0x${t.slice(26)}`)

/** Counts raw HTTP requests per chain, so the RPC cost of every operation is measurable. */
export interface RequestCounter { n: Record<number, number>; inc(chainId: number): void }

/** rpc: one URL or a list (viem fallback: ranked, automatic failover). */
export function makeClient(chainId: number, cfg: Pick<ChainCfg, 'rpc' | 'rpcTimeoutMs'>, counter?: RequestCounter): PublicClient {
  const urls = Array.isArray(cfg.rpc) ? cfg.rpc : [cfg.rpc]
  const one = (url: string) => http(url, {
    batch: false,
    retryCount: 3,
    timeout: cfg.rpcTimeoutMs ?? 15_000,
    onFetchRequest: () => { counter?.inc(chainId) },
  })
  const transport = urls.length > 1 ? fallback(urls.map(one), { rank: false, retryCount: 1 }) : one(urls[0] as string)
  return createPublicClient({ transport, chain: { id: Number(chainId), name: `chain-${chainId}`, nativeCurrency: { name: 'ETH', symbol: 'ETH', decimals: 18 }, rpcUrls: { default: { http: urls } } } }) as PublicClient
}

const CHUNK = 400 // calls per multicall request; keeps calldata and eth_call gas well under node limits

export interface Call { address: Address; abi: Abi; functionName: string; args: readonly unknown[] }
export type CallResult = { status: 'success'; result: unknown } | { status: 'failure'; error: Error }

/**
 * Consistent multicall: one chunk is atomic on 'latest'; several chunks are pinned to the same block
 * (one extra eth_blockNumber) so balances, allowances and nonces never mix two states.
 */
export async function multicall(client: PublicClient, multicallAddress: Address, contracts: Call[], blockNumber?: bigint | null): Promise<{ results: CallResult[]; blockNumber: bigint | null }> {
  if (contracts.length === 0) return { results: [], blockNumber: blockNumber ?? null }
  if (blockNumber == null && contracts.length > CHUNK) blockNumber = await client.getBlockNumber()
  const out: CallResult[] = []
  for (let i = 0; i < contracts.length; i += CHUNK) {
    // batchSize 0: viem would otherwise split every 1 KB of calldata into a separate RPC request
    const part = await client.multicall({
      contracts: contracts.slice(i, i + CHUNK) as never, allowFailure: true, multicallAddress, batchSize: 0,
      ...(blockNumber != null ? { blockNumber } : {}),
    }) as CallResult[]
    out.push(...part)
  }
  return { results: out, blockNumber: blockNumber ?? null }
}

export interface Snapshot {
  /** min(balance, allowance) per `signer|token` */
  funds: Map<string, bigint>
  nonceUsed: boolean[]
  delegated: Set<Address>
  /** indexes (into the orders list) of contract-signed orders whose signature check() rejects */
  badSignature: Set<number>
  blockNumber: bigint | null
}

/**
 * One batched snapshot for a set of orders:
 *  - balance and allowance for each distinct (signer, signerToken)
 *  - nonceUsed for each order (delegated signers are rejected, so signatory = signerWallet)
 *  - authorized(signer) for each distinct signer: once a delegate is set, the wallet's own signatures stop validating on-chain
 *  - SwapERC20.check() for orders of contract (EIP-1271) signers: their isValidSignature can change at any time
 */
export async function snapshot(client: PublicClient, chainCfg: Pick<ChainCfg, 'swap' | 'multicall'>, orders: NormalizedOrder[],
  { blockNumber, contractSigned = () => false }: { blockNumber?: bigint; contractSigned?: (o: NormalizedOrder, i: number) => boolean } = {}): Promise<Snapshot> {
  const swap = chainCfg.swap
  const pairs = new Map<string, [Address, Address]>()
  for (const o of orders) pairs.set(`${o.signerWallet}|${o.signerToken}`, [o.signerWallet, o.signerToken])
  const pairList = [...pairs.values()]
  const signers = [...new Set(orders.map((o) => o.signerWallet))]
  const sigIdx: number[] = []
  orders.forEach((o, i) => { if (contractSigned(o, i)) sigIdx.push(i) })
  const calls: Call[] = []
  for (const [owner, token] of pairList) {
    calls.push({ address: token, abi: ERC20_ABI, functionName: 'balanceOf', args: [owner] })
    calls.push({ address: token, abi: ERC20_ABI, functionName: 'allowance', args: [owner, swap] })
  }
  for (const o of orders) calls.push({ address: swap, abi: SWAP_ABI, functionName: 'nonceUsed', args: [o.signerWallet, o.nonce] })
  for (const s of signers) calls.push({ address: swap, abi: SWAP_ABI, functionName: 'authorized', args: [s] })
  for (const i of sigIdx) {
    const o = orders[i] as NormalizedOrder
    calls.push({ address: swap, abi: SWAP_ABI, functionName: 'check', args: [o.senderWallet, o.nonce, o.expiry, o.signerWallet, o.signerToken, o.signerAmount, o.senderToken, o.senderAmount, o.v, o.r, o.s] })
  }
  const { results: res, blockNumber: at } = await multicall(client, chainCfg.multicall || MULTICALL3, calls, blockNumber)
  const at_ = (i: number) => res[i] as CallResult

  const funds = new Map<string, bigint>()
  pairList.forEach(([owner, token], i) => {
    const bal = at_(2 * i), alw = at_(2 * i + 1)
    const available = bal.status === 'success' && alw.status === 'success'
      ? ((bal.result as bigint) < (alw.result as bigint) ? (bal.result as bigint) : (alw.result as bigint)) : 0n
    funds.set(`${owner}|${token}`, available)
  })
  let k = pairList.length * 2
  const nonceUsed = orders.map((_, i) => { const r = at_(k + i); return r.status === 'success' ? (r.result as boolean) : false })
  k += orders.length
  // fail closed: an unreadable authorized() counts as delegated
  const delegated = new Set(signers.filter((_, i) => { const r = at_(k + i); return r.status !== 'success' || getAddress(r.result as Address) !== ZERO }))
  k += signers.length
  const badSignature = new Set<number>()
  sigIdx.forEach((oi, j) => {
    const r = at_(k + j)
    const errs = r.status === 'success' ? (r.result as Hex[]).map((e) => hexToString(e, { size: 32 }).replace(/\0+$/, '')) : ['CallFailed']
    if (errs.some((e) => e === 'SignatureInvalid' || e === 'CallFailed')) badSignature.add(oi)
  })
  return { funds, nonceUsed, delegated, badSignature, blockNumber: at }
}

export const readFee = (client: PublicClient, swap: Address): Promise<bigint> => client.readContract({ address: swap, abi: SWAP_ABI, functionName: 'protocolFee' })
