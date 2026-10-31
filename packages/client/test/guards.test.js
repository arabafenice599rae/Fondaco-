// Pure client logic (no chain): price guards at the exact thresholds, wallet discovery and protection status with fake
// EIP-6963 wallets on chains 1, 8453, 10, 42161, 137, and the per-wallet persistence of the RPC confirmation.
import { priceCheck, isStale } from '../dist/protect.js'
import { discoverWallets, protectionStatus, createRpcConfirmations, RPC_CONFIRM_KEY } from '../dist/wallet-protection.js'

const results = []
const check = (n, ok, d = '') => { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'} | ${n}${d ? ' | ' + d : ''}`) }

// ---- G1 priceCheck: thresholds are INCLUSIVE (reference behaviour): exactly 2.00 % → warn, exactly 10.00 % → danger
// deviation = how much cheaper than the mid the offer is FOR THE TAKER; sell: price below mid, buy: price above mid
const mids = [2500, 1234.5678, 0.000123, 98765.4321]
const pct = (side, mid, p) => (side === 'sell' ? mid * (1 - p / 100) : mid * (1 + p / 100))
const table = [[0, 'ok'], [1.99, 'ok'], [2.0, 'warn'], [5, 'warn'], [9.99, 'warn'], [10.0, 'danger'], [25, 'danger'], [-3, 'ok']]
const bad1 = []
for (const mid of mids) for (const side of ['sell', 'buy']) for (const [p, want] of table) {
  const r = priceCheck({ side, price: pct(side, mid, p), mid })
  if (r.level !== want || r.deviationBps !== Math.round(p * 100)) bad1.push(`${side} mid ${mid} ${p}% → ${r.level} (${r.deviationBps} bps), want ${want}`)
}
check('G1: priceCheck boundary table (0, 1.99, 2.00, 5, 9.99, 10.00, 25, −3 %) × sell/buy × 4 mids incl. non-round and tiny', bad1.length === 0, bad1.slice(0, 3).join('; ') || `${mids.length * 2 * table.length} cases`)

// ---- G2 isStale: exactly 1.00 % past the market → stale; 0.99 % → not
const bad2 = []
for (const mid of mids) for (const side of ['sell', 'buy']) for (const [p, want] of [[0.99, false], [1.0, true], [1.01, true], [0, false], [-1, false]]) {
  const r = isStale({ side, price: pct(side, mid, p), mid })
  if (r !== want) bad2.push(`${side} mid ${mid} ${p}% → ${r}, want ${want}`)
}
check('G2: isStale boundary (0.99 % no, 1.00 % yes, 1.01 % yes, at and above market no)', bad2.length === 0, bad2.slice(0, 3).join('; ') || `${mids.length * 2 * 5} cases`)
check('G3: degenerate inputs are "ok", never a throw (price/mid 0, NaN, negative)',
  [[0, 2500], [2500, 0], [NaN, 2500], [2500, NaN], [-1, 2500]].every(([price, mid]) => priceCheck({ side: 'sell', price, mid }).level === 'ok' && isStale({ side: 'buy', price, mid }) === false))

// ---- G4 discovery with fake wallets: MetaMask, Rabby, an unknown wallet; duplicates and malformed announcements ignored
const win = new EventTarget()
const announce = (detail) => win.dispatchEvent(new CustomEvent('eip6963:announceProvider', { detail }))
const provider = { request: async () => '0x1' }
win.addEventListener('eip6963:requestProvider', () => {
  announce(Object.freeze({ info: { uuid: 'u-mm', name: 'MetaMask', icon: 'data:,', rdns: 'io.metamask' }, provider }))
  announce(Object.freeze({ info: { uuid: 'u-rb', name: 'Rabby', icon: 'data:,', rdns: 'io.rabby' }, provider }))
  announce(Object.freeze({ info: { uuid: 'u-xx', name: 'Wallet X', icon: 'data:,', rdns: 'com.example.walletx' }, provider }))
  announce(Object.freeze({ info: { uuid: 'u-mm', name: 'MetaMask (again)', icon: 'data:,', rdns: 'io.metamask' }, provider }))
  announce({ info: { uuid: 'u-bad', name: 'No provider' } })
  announce(null)
})
const ws = await discoverWallets({ target: win, timeoutMs: 30 })
check('G4: EIP-6963 discovery — 3 wallets, deduplicated by uuid, malformed announcements ignored', ws.map((w) => w.info.rdns).join() === 'io.metamask,io.rabby,com.example.walletx' && ws[0].info.name === 'MetaMask')

// ---- G5 protection status matrix: wallets × chains 1, 8453, 10, 42161, 137
const want = {
  'io.metamask': { 1: 'wallet', 8453: 'l2', 10: 'l2', 42161: 'l2', 137: 'none' },
  'io.rabby': { 1: 'guide', 8453: 'l2', 10: 'l2', 42161: 'l2', 137: 'none' },
  'com.example.walletx': { 1: 'guide', 8453: 'l2', 10: 'l2', 42161: 'l2', 137: 'none' },
}
const bad5 = []
for (const [rdns, row] of Object.entries(want)) for (const [chain, level] of Object.entries(row)) {
  const s = protectionStatus({ rdns, chainId: Number(chain) })
  const prot = level === 'wallet' || level === 'l2'
  if (s.level !== level || s.protected !== prot || (level === 'guide' && s.rpc.length !== 2) || (level !== 'guide' && s.rpc.length !== 0)) bad5.push(`${rdns}@${chain}: ${s.level}`)
}
check('G5: protection matrix (MetaMask/Rabby/unknown × Ethereum, Base, OP, Arbitrum, Polygon)', bad5.length === 0, bad5.join(', ') || '15 combinations as specified')

// ---- G6 confirmation remembered per wallet and per chain, across "reloads" (new store on the same storage)
const mapStorage = () => { const m = new Map(); return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k), m } }
const st = mapStorage()
createRpcConfirmations(st).set('io.rabby', 1)
const reloaded = createRpcConfirmations(st)
const level = (rdns, chainId, store) => protectionStatus({ rdns, chainId, userSetRpc: store.has(rdns, chainId) }).level
check('G6: "Ho impostato l\'RPC protetto" remembered for that wallet only, on that chain only, after a reload',
  level('io.rabby', 1, reloaded) === 'user_rpc' && level('com.example.walletx', 1, reloaded) === 'guide' && reloaded.has('io.rabby', 8453) === false &&
  JSON.parse(st.getItem(RPC_CONFIRM_KEY))['io.rabby:1'] > 0 && RPC_CONFIRM_KEY === 'fondaco-rpcset', st.getItem(RPC_CONFIRM_KEY))
// keyed by rdns, not uuid: a new session (new uuid) of the same wallet keeps the confirmation
check('G7: keyed by the stable rdns (EIP-6963 uuid changes every session); clear(rdns) forgets one wallet only',
  (() => { const s2 = createRpcConfirmations(st); s2.set('com.example.walletx', 1); s2.clear('io.rabby'); return !s2.has('io.rabby', 1) && s2.has('com.example.walletx', 1) && s2.list().length === 1 })())
// MetaMask: its own Smart Transactions decide; a confirmation does not change the advice (reference behaviour)
check('G8: MetaMask stays "wallet" even with a confirmation (custom RPC would disable Smart Transactions)', protectionStatus({ rdns: 'io.metamask', chainId: 1, userSetRpc: true }).level === 'wallet')
// storage that throws (private mode), is missing, or holds garbage
const throwing = { getItem() { throw new Error('denied') }, setItem() { throw new Error('denied') }, removeItem() { throw new Error('denied') } }
const t = createRpcConfirmations(throwing); t.set('io.rabby', 1)
const none = createRpcConfirmations(null); none.set('io.rabby', 1)
const garbage = mapStorage(); garbage.setItem(RPC_CONFIRM_KEY, '{not json'); const g = createRpcConfirmations(garbage)
const wrongShape = mapStorage(); wrongShape.setItem(RPC_CONFIRM_KEY, JSON.stringify({ 'io.rabby:1': 'yes', evil: 1 })); const w2 = createRpcConfirmations(wrongShape)
check('G9: throwing / missing / corrupted storage → no crash; works for the session; garbage ignored', t.has('io.rabby', 1) && none.has('io.rabby', 1) && !g.has('io.rabby', 1) && g.list().length === 0 && w2.list().length === 0)

const failed = results.filter((x) => !x).length
console.log(`\n${results.length - failed}/${results.length} checks passed`)
process.exit(failed ? 1 : 0)
