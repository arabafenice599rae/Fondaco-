// Wallet: EIP-6963 discovery, EIP-1193 connection through viem, balances, EIP-712 signatures, approvals.
// Reads go to the configured RPC if there is one, otherwise through the wallet itself: the app never holds an API key.
import { createPublicClient, createWalletClient, custom, http, getAddress, parseAbi, maxUint256, type Address, type Chain, type PublicClient, type WalletClient } from 'viem'
import { MULTICALL3, type DiscoveredWallet, type Eip1193Provider } from '@fondaco/client'

const ERC20 = parseAbi(['function balanceOf(address) view returns (uint256)', 'function allowance(address,address) view returns (uint256)', 'function approve(address,uint256)'])

export const viemChain = (id: number, name: string, rpc: string): Chain => ({
  id, name, nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 }, rpcUrls: { default: { http: rpc ? [rpc] : [] } },
  contracts: { multicall3: { address: MULTICALL3 } },
})

export interface WalletState {
  wallets: DiscoveredWallet[]
  selected: DiscoveredWallet | null
  address: Address | null
  chainId: number | null
}

type Listener = () => void
/** Keeps listening for EIP-6963 announcements (wallets can announce late) and tracks the connected account and chain. */
export class Wallet {
  readonly state: WalletState = { wallets: [], selected: null, address: null, chainId: null }
  private listeners = new Set<Listener>()
  constructor(private readonly win: Window & typeof globalThis = window) {
    win.addEventListener('eip6963:announceProvider', (e: Event) => {
      const d = (e as CustomEvent<{ info?: DiscoveredWallet['info']; provider?: Eip1193Provider }>).detail
      if (!d?.info?.uuid || !d.provider || this.state.wallets.some((w) => w.info.uuid === d.info?.uuid)) return
      this.state.wallets.push({ info: { ...d.info }, provider: d.provider })
      this.emit()
    })
    try { win.dispatchEvent(new Event('eip6963:requestProvider')) } catch { /* no wallets */ }
  }
  on(f: Listener): () => void { this.listeners.add(f); return () => this.listeners.delete(f) }
  private emit() { for (const f of this.listeners) try { f() } catch { /* UI */ } }

  /** eth_requestAccounts on the chosen wallet; follows account and chain changes. */
  async connect(w: DiscoveredWallet): Promise<Address> {
    const p = w.provider as Eip1193Provider & { on?: (ev: string, f: (x: unknown) => void) => void }
    const accounts = (await p.request({ method: 'eth_requestAccounts' })) as string[]
    if (!accounts?.[0]) throw new Error('nessun account')
    this.state.selected = w
    this.state.address = getAddress(accounts[0])
    this.state.chainId = parseInt(String(await p.request({ method: 'eth_chainId' })), 16)
    p.on?.('accountsChanged', (a) => { const list = a as string[]; this.state.address = list[0] ? getAddress(list[0]) : null; this.emit() })
    p.on?.('chainChanged', (c) => { this.state.chainId = parseInt(String(c), 16); this.emit() })
    this.emit()
    return this.state.address
  }
  disconnect(): void { this.state.selected = null; this.state.address = null; this.state.chainId = null; this.emit() }

  async switchChain(id: number): Promise<boolean> {
    if (!this.state.selected) return false
    try { await this.state.selected.provider.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: '0x' + id.toString(16) }] }); return true } catch { return false }
  }

  /** viem clients for a chain: wallet client only when connected on that chain. */
  clients(chain: Chain): { publicClient: PublicClient | null; walletClient: WalletClient | null } {
    const p = this.state.selected?.provider
    const rpc = chain.rpcUrls.default.http[0]
    const onChain = !!p && this.state.chainId === chain.id
    const publicClient = rpc ? createPublicClient({ chain, transport: http(rpc) }) : onChain ? createPublicClient({ chain, transport: custom(p as Eip1193Provider) }) : null
    const walletClient = onChain && this.state.address ? createWalletClient({ chain, account: this.state.address, transport: custom(p as Eip1193Provider) }) : null
    return { publicClient: publicClient as PublicClient | null, walletClient }
  }
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

/** A random 64-bit nonce (unique per signer with overwhelming probability; nonces need not be sequential). */
export function randomNonce(): bigint {
  const b = new Uint32Array(2)
  crypto.getRandomValues(b)
  return (BigInt(b[0] as number) << 32n) | BigInt(b[1] as number)
}
