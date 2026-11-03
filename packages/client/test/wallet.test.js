// EIP-6963 discovery and protection status (no chain needed).
import { discoverWallets, protectionStatus } from '../dist/wallet-protection.js'

const results = []
const check = (n, ok, d = '') => { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'} | ${n}${d ? ' | ' + d : ''}`) }

// a fake window: two wallets answer the request, one of them twice (must be deduplicated by uuid)
const win = new EventTarget()
const announce = (info) => win.dispatchEvent(new CustomEvent('eip6963:announceProvider', { detail: Object.freeze({ info, provider: { request: async () => '0x1' } }) }))
win.addEventListener('eip6963:requestProvider', () => {
  announce({ uuid: 'a', name: 'MetaMask', icon: 'data:,', rdns: 'io.metamask' })
  announce({ uuid: 'b', name: 'Rabby', icon: 'data:,', rdns: 'io.rabby' })
  announce({ uuid: 'a', name: 'MetaMask', icon: 'data:,', rdns: 'io.metamask' })
})
const ws = await discoverWallets({ target: win, timeoutMs: 50 })
check('W1: EIP-6963 discovery finds each wallet once', ws.length === 2 && ws.map((w) => w.info.rdns).join(',') === 'io.metamask,io.rabby', ws.map((w) => w.info.name).join(', '))
check('W2: no window → empty list', (await discoverWallets({ target: null })).length === 0)

const s = {
  mm: protectionStatus({ rdns: 'io.metamask', chainId: 1 }),
  rabby: protectionStatus({ rdns: 'io.rabby', chainId: 1 }),
  rabbySet: protectionStatus({ rdns: 'io.rabby', chainId: 1, userSetRpc: true }),
  base: protectionStatus({ rdns: 'io.rabby', chainId: 8453 }),
  other: protectionStatus({ rdns: null, chainId: 137 }),
}
check('W3: MetaMask on mainnet → protected by the wallet, no custom RPC suggested', s.mm.level === 'wallet' && s.mm.protected && s.mm.rpc.length === 0 && s.mm.detail.includes('Smart Transactions'))
check('W4: other wallet on mainnet → guide with both protected RPCs; after confirming → user_rpc', s.rabby.level === 'guide' && !s.rabby.protected && s.rabby.rpc.length === 2 && s.rabbySet.level === 'user_rpc' && s.rabbySet.protected,
  s.rabby.rpc.map((r) => r.url).join(' · '))
check('W5: L2 → not needed; unknown chain → none', s.base.level === 'l2' && s.base.protected && s.other.level === 'none' && !s.other.protected)

const failed = results.filter((x) => !x).length
console.log(`\n${results.length - failed}/${results.length} checks passed`)
process.exit(failed ? 1 : 0)
