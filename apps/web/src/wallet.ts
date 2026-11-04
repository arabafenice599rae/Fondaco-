// Wallet discovery (EIP-6963) and connection (EIP-1193). Everything that needs viem clients (reads, approvals, signatures,
// execution) lives in wallet-rt.ts and is loaded on first use: it is not on the path that shows the book.
import { getAddress, type Address } from 'viem'
import type { DiscoveredWallet, Eip1193Provider } from '@fondaco/client'

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

}

/** A random 64-bit nonce (unique per signer with overwhelming probability; nonces need not be sequential). */
export function randomNonce(): bigint {
  const b = new Uint32Array(2)
  crypto.getRandomValues(b)
  return (BigInt(b[0] as number) << 32n) | BigInt(b[1] as number)
}
