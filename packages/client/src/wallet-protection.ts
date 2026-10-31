// Which wallet is connected (EIP-6963) and what that means for MEV protection — for the UI only.
// Nothing here changes how a transaction is sent: a browser wallet always broadcasts through its own RPC.
import { PROTECTED_RPC, SEQUENCER_CHAINS } from './protect.js'

/** Human names for the protected endpoints in PROTECTED_RPC. */
export const RPC_NAMES: Readonly<Record<string, string>> = {
  'https://rpc.mevblocker.io/noreverts': 'MEV Blocker (no revert)',
  'https://rpc.flashbots.net/fast': 'Flashbots Protect',
}

// Wallets whose own transaction routing protects mainnet users by default.
// MetaMask: Smart Transactions (on by default; turned off by a custom RPC on the same network).
const WALLET_PROTECTION: Readonly<Record<string, { name: string; feature: string; path: string; customRpcDisables: boolean }>> = {
  'io.metamask': { name: 'MetaMask', feature: 'Smart Transactions', path: 'Impostazioni › Transazioni (estensione) o Impostazioni › Avanzate (mobile)', customRpcDisables: true },
  'io.metamask.flask': { name: 'MetaMask Flask', feature: 'Smart Transactions', path: 'Impostazioni › Transazioni', customRpcDisables: true },
}

/** EIP-6963 provider info. */
export interface WalletInfo { uuid: string; name: string; icon: string; rdns: string }
export interface Eip1193Provider { request(args: { method: string; params?: unknown }): Promise<unknown> }
export interface DiscoveredWallet { info: WalletInfo; provider: Eip1193Provider }
interface AnnounceTarget { addEventListener(t: string, f: (e: Event) => void): void; removeEventListener(t: string, f: (e: Event) => void): void; dispatchEvent(e: Event): boolean }

/**
 * EIP-6963: ask every injected wallet to announce itself. Deduplicated by uuid.
 * @param target the window (injectable for tests)
 */
export function discoverWallets({ target = (globalThis as { window?: AnnounceTarget }).window, timeoutMs = 400 }: { target?: AnnounceTarget | null; timeoutMs?: number } = {}): Promise<DiscoveredWallet[]> {
  return new Promise((resolve) => {
    if (!target || typeof target.addEventListener !== 'function') return resolve([])
    const found = new Map<string, DiscoveredWallet>()
    const onAnnounce = (e: Event) => {
      const d = (e as CustomEvent<{ info?: WalletInfo; provider?: Eip1193Provider }>).detail
      if (d && d.info && d.info.uuid && d.provider && !found.has(d.info.uuid)) found.set(d.info.uuid, { info: { ...d.info }, provider: d.provider })
    }
    target.addEventListener('eip6963:announceProvider', onAnnounce)
    target.dispatchEvent(new Event('eip6963:requestProvider'))
    setTimeout(() => { target.removeEventListener('eip6963:announceProvider', onAnnounce); resolve([...found.values()]) }, timeoutMs)
  })
}

export type ProtectionLevel = 'l2' | 'wallet' | 'user_rpc' | 'guide' | 'none'
export interface ProtectionStatus { level: ProtectionLevel; protected: boolean; title: string; detail: string; rpc: { name: string; url: string }[]; wallet: string | null }

/**
 * What the UI should say about MEV protection for this wallet on this chain.
 * @param rdns EIP-6963 reverse-DNS id of the connected wallet ('io.metamask', …), or null
 * @param userSetRpc the user confirmed they configured a protected RPC in their wallet (remembered per wallet)
 */
export function protectionStatus({ rdns = null, chainId, userSetRpc = false }: { rdns?: string | null; chainId: number | string; userSetRpc?: boolean }): ProtectionStatus {
  const id = Number(chainId)
  const w = rdns ? WALLET_PROTECTION[rdns] : undefined
  const rpc = (PROTECTED_RPC[id] || []).map((url) => ({ name: RPC_NAMES[url] || url, url }))
  if (SEQUENCER_CHAINS.has(id)) {
    return { level: 'l2', protected: true, title: 'Non serve su questa rete', detail: 'Le transazioni vanno al sequencer: non c’è una mempool pubblica da cui copiarle.', rpc: [], wallet: w?.name ?? null }
  }
  if (!rpc.length) {
    return { level: 'none', protected: false, title: 'Nessun RPC protetto noto per questa rete', detail: 'Le transazioni passano dalla mempool pubblica.', rpc: [], wallet: w?.name ?? null }
  }
  if (w) {
    return {
      level: 'wallet', protected: true, title: `Protetto da ${w.name}`,
      detail: `${w.name} instrada le transazioni con ${w.feature}, attivo di default. Verifica che sia acceso in ${w.path}.` +
        (w.customRpcDisables ? ` Non impostare un RPC personalizzato per Ethereum: disattiverebbe ${w.feature}.` : ''),
      rpc: [], wallet: w.name,
    }
  }
  if (userSetRpc) {
    return { level: 'user_rpc', protected: true, title: 'RPC protetto impostato', detail: 'Hai indicato di usare un RPC protetto nel tuo wallet: le transazioni non passano dalla mempool pubblica.', rpc, wallet: null }
  }
  return {
    level: 'guide', protected: false, title: 'Non protetto',
    detail: 'Il tuo wallet invia dalla mempool pubblica: un bot può vedere la transazione e passare prima. Aggiungi uno di questi RPC nelle impostazioni di rete di Ethereum del wallet e rendilo predefinito.',
    rpc, wallet: null,
  }
}

/** Steps shown with the 'guide' level (generic: every wallet names its menus differently). */
export const GUIDE_STEPS: readonly string[] = [
  'Copia uno degli indirizzi qui sotto.',
  'Nel wallet apri le impostazioni delle reti e scegli Ethereum.',
  'Aggiungi un nuovo RPC con l’indirizzo copiato e impostalo come predefinito.',
  'Torna qui e conferma: FONDACO se lo ricorda per questo wallet.',
]

// ------------------------------------------------------------------ remembered RPC confirmation, per wallet

/** localStorage key (spec §6.3). */
export const RPC_CONFIRM_KEY = 'fondaco-rpcset'
export interface StorageLike { getItem(k: string): string | null; setItem(k: string, v: string): void; removeItem(k: string): void }

/**
 * Remembers that the user confirmed "I set the protected RPC" for a wallet on a chain.
 * Keyed by the wallet's EIP-6963 rdns (stable), never by its uuid (EIP-6963: new uuid every session).
 * Works without storage (private mode, storage throwing, SSR): falls back to memory for the session; corrupted data is reset.
 */
export function createRpcConfirmations(storage: StorageLike | null | undefined = (globalThis as { localStorage?: StorageLike }).localStorage, key = RPC_CONFIRM_KEY) {
  let mem: Record<string, number> = {}
  const id = (rdns: string, chainId: number | string) => `${rdns}:${Number(chainId)}`
  const load = (): Record<string, number> => {
    try {
      const raw = storage?.getItem(key)
      if (!raw) return { ...mem }
      const v = JSON.parse(raw) as unknown
      if (!v || typeof v !== 'object' || Array.isArray(v)) return { ...mem }
      return Object.fromEntries(Object.entries(v as Record<string, unknown>).filter(([k, t]) => /^[^:]+:\d+$/.test(k) && typeof t === 'number')) as Record<string, number>
    } catch { return { ...mem } }
  }
  const save = (v: Record<string, number>) => { mem = v; try { storage?.setItem(key, JSON.stringify(v)) } catch { /* memory only */ } }
  return {
    has: (rdns: string | null | undefined, chainId: number | string): boolean => !!rdns && id(rdns, chainId) in load(),
    set(rdns: string, chainId: number | string, confirmed = true, now = Date.now()): void {
      const v = load()
      if (confirmed) v[id(rdns, chainId)] = now; else delete v[id(rdns, chainId)]
      save(v)
    },
    /** forget one wallet (all chains), or everything */
    clear(rdns?: string): void {
      if (!rdns) { mem = {}; try { storage?.removeItem(key) } catch { /* ignore */ } return }
      save(Object.fromEntries(Object.entries(load()).filter(([k]) => !k.startsWith(`${rdns}:`))))
    },
    list: (): { rdns: string; chainId: number; at: number }[] => Object.entries(load()).map(([k, at]) => ({ rdns: k.slice(0, k.lastIndexOf(':')), chainId: Number(k.slice(k.lastIndexOf(':') + 1)), at })),
  }
}
export type RpcConfirmations = ReturnType<typeof createRpcConfirmations>
