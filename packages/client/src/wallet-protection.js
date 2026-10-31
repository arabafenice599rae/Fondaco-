// Which wallet is connected (EIP-6963) and what that means for MEV protection — for the UI only.
// Nothing here changes how a transaction is sent: a browser wallet always broadcasts through its own RPC.
import { PROTECTED_RPC, SEQUENCER_CHAINS } from './protect.js'

/** Human names for the protected endpoints in PROTECTED_RPC. */
export const RPC_NAMES = {
  'https://rpc.mevblocker.io/noreverts': 'MEV Blocker (no revert)',
  'https://rpc.flashbots.net/fast': 'Flashbots Protect',
}

// Wallets whose own transaction routing protects mainnet users by default.
// MetaMask: Smart Transactions (on by default; turned off by a custom RPC on the same network).
const WALLET_PROTECTION = {
  'io.metamask': { name: 'MetaMask', feature: 'Smart Transactions', path: 'Impostazioni › Transazioni (estensione) o Impostazioni › Avanzate (mobile)', customRpcDisables: true },
  'io.metamask.flask': { name: 'MetaMask Flask', feature: 'Smart Transactions', path: 'Impostazioni › Transazioni', customRpcDisables: true },
}

/**
 * EIP-6963: ask every injected wallet to announce itself. Resolves [{ info: { uuid, name, icon, rdns }, provider }].
 * @param target the window (injectable for tests)
 */
export function discoverWallets({ target = globalThis.window, timeoutMs = 400 } = {}) {
  return new Promise((resolve) => {
    if (!target || typeof target.addEventListener !== 'function') return resolve([])
    const found = new Map()
    const onAnnounce = (e) => {
      const d = e.detail
      if (d && d.info && d.info.uuid && d.provider && !found.has(d.info.uuid)) found.set(d.info.uuid, { info: { ...d.info }, provider: d.provider })
    }
    target.addEventListener('eip6963:announceProvider', onAnnounce)
    target.dispatchEvent(new Event('eip6963:requestProvider'))
    setTimeout(() => { target.removeEventListener('eip6963:announceProvider', onAnnounce); resolve([...found.values()]) }, timeoutMs)
  })
}

/**
 * What the UI should say about MEV protection for this wallet on this chain.
 * @param rdns EIP-6963 reverse-DNS id of the connected wallet ('io.metamask', …), or null
 * @param chainId number
 * @param userSetRpc the user confirmed they configured a protected RPC in their wallet (remembered per wallet)
 * @returns { level: 'l2'|'wallet'|'user_rpc'|'guide'|'none', protected: boolean, title, detail, rpc: [{ name, url }], wallet }
 */
export function protectionStatus({ rdns = null, chainId, userSetRpc = false }) {
  const id = Number(chainId)
  const w = rdns ? WALLET_PROTECTION[rdns] : null
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
export const GUIDE_STEPS = [
  'Copia uno degli indirizzi qui sotto.',
  'Nel wallet apri le impostazioni delle reti e scegli Ethereum.',
  'Aggiungi un nuovo RPC con l’indirizzo copiato e impostalo come predefinito.',
  'Torna qui e conferma: FONDACO se lo ricorda per questo wallet.',
]
