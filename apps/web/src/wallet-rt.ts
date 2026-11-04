// Runtime of the wallet side, loaded on first use: viem clients, balances, approvals and the @fondaco/client execution.
import { createPublicClient, createWalletClient, custom, http, parseAbi, maxUint256, type Address, type Chain, type PublicClient, type WalletClient } from 'viem'
import { MULTICALL3, type Eip1193Provider } from '@fondaco/client'
import type { Wallet } from './wallet.js'
export { createTaker, createSubmitter, cancelOrders } from '@fondaco/client'

const ERC20 = parseAbi(['function balanceOf(address) view returns (uint256)', 'function allowance(address,address) view returns (uint256)', 'function approve(address,uint256)'])

export const viemChain = (id: number, name: string, rpc: string): Chain => ({
  id, name, nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 }, rpcUrls: { default: { http: rpc ? [rpc] : [] } },
  contracts: { multicall3: { address: MULTICALL3 } },
})

/** viem clients for a chain: reads from the configured RPC (else through the wallet); wallet client only when connected on that chain. */
export function clientsFor(w: Wallet, chain: Chain): { publicClient: PublicClient | null; walletClient: WalletClient | null } {
  const p = w.state.selected?.provider
  const rpc = chain.rpcUrls.default.http[0]
  const onChain = !!p && w.state.chainId === chain.id
  const publicClient = rpc ? createPublicClient({ chain, transport: http(rpc) }) : onChain ? createPublicClient({ chain, transport: custom(p as Eip1193Provider) }) : null
  const walletClient = onChain && w.state.address ? createWalletClient({ chain, account: w.state.address, transport: custom(p as Eip1193Provider) }) : null
  return { publicClient: publicClient as PublicClient | null, walletClient }
}


/** Balances and allowances (to `spender`) of `owner` for `tokens`, one multicall. */
export async function readFunds(pc: PublicClient, owner: Address, tokens: Address[], spender: Address | null): Promise<Record<Address, { balance: bigint; allowance: bigint }>> {
  const calls = tokens.flatMap((t) => [
    { address: t, abi: ERC20, functionName: 'balanceOf', args: [owner] },
    ...(spender ? [{ address: t, abi: ERC20, functionName: 'allowance', args: [owner, spender] }] : []),
  ])
  const res = await pc.multicall({ contracts: calls as never, allowFailure: true, multicallAddress: MULTICALL3 }) as { status: string; result?: bigint }[]
  const out: Record<Address, { balance: bigint; allowance: bigint }> = {}
  const step = spender ? 2 : 1
  tokens.forEach((t, i) => {
    const b = res[i * step], a = spender ? res[i * step + 1] : undefined
    out[t] = { balance: b?.status === 'success' ? (b.result as bigint) : 0n, allowance: a?.status === 'success' ? (a.result as bigint) : 0n }
  })
  return out
}

/** approve(spender, amount); tokens like USDT need a reset to 0 when changing a non-zero allowance. */
export async function approve(pc: PublicClient, wc: WalletClient, token: Address, spender: Address, amount: bigint | 'max', current: bigint): Promise<void> {
  const account = wc.account as { address: Address }
  const value = amount === 'max' ? maxUint256 : amount
  let direct = true
  try { await pc.simulateContract({ account: account.address, address: token, abi: ERC20, functionName: 'approve', args: [spender, value] }) } catch { direct = false }
  if (!direct && current > 0n) {
    const h0 = await wc.writeContract({ account: account.address, chain: wc.chain, address: token, abi: ERC20, functionName: 'approve', args: [spender, 0n] })
    if ((await pc.waitForTransactionReceipt({ hash: h0 })).status !== 'success') throw new Error('reset dell’autorizzazione fallito')
  }
  const h = await wc.writeContract({ account: account.address, chain: wc.chain, address: token, abi: ERC20, functionName: 'approve', args: [spender, value] })
  if ((await pc.waitForTransactionReceipt({ hash: h })).status !== 'success') throw new Error('autorizzazione fallita')
}
