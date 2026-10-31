// Runtime use from an external project, through the package's public entry points only.
import { plan, priceCheck, createRpcConfirmations, protectionStatus, REASONS } from '@fondaco/client'
import { createTaker } from '@fondaco/client/taker'
import { createSubmitter, isStale, EXPIRY } from '@fondaco/client/protect'
import { discoverWallets } from '@fondaco/client/wallet-protection'
const order = { nonce: '1', expiry: '9999999999', signerWallet: '0x1111111111111111111111111111111111111111', signerToken: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2', signerAmount: '1000',
  protocolFee: '30', senderWallet: '0x0000000000000000000000000000000000000000', senderToken: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', senderAmount: '2500', v: 27, r: '0x' + '11'.repeat(32), s: '0x' + '22'.repeat(32) }
const q = plan([{ hash: 'h', order }], 3000n)
const store = createRpcConfirmations(null)
store.set('io.rabby', 1)
console.log(JSON.stringify({
  plan: { kind: q.kind, legs: q.legs.length, pay: String(q.pay), left: String(q.left) },
  price: priceCheck({ side: 'sell', price: 2450, mid: 2500 }).level, stale: isStale({ side: 'sell', price: 2475, mid: 2500 }),
  protection: protectionStatus({ rdns: 'io.rabby', chainId: 1, userSetRpc: store.has('io.rabby', 1) }).level,
  wallets: (await discoverWallets({ target: null })).length, reasons: Object.keys(REASONS).length, expiry: EXPIRY.defaultSec,
  fns: [typeof createTaker, typeof createSubmitter].join(','),
}))
