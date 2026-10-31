// Order model for AirSwap SwapERC20 v5.0.0: EIP-712 types, normalization, pure validation.
import { getAddress, hashTypedData, isAddress, recoverTypedDataAddress, zeroAddress } from 'viem'

export const FEE_DIVISOR = 10_000n
const UINT256_MAX = (1n << 256n) - 1n

// Must match SwapERC20._domainNameAndVersion() and ORDER_TYPEHASH (source v5.0.0).
export const DOMAIN_NAME = 'SWAP_ERC20'
export const DOMAIN_VERSION = '4.3'
export const ORDER_TYPES = {
  OrderERC20: [
    { name: 'nonce', type: 'uint256' },
    { name: 'expiry', type: 'uint256' },
    { name: 'signerWallet', type: 'address' },
    { name: 'signerToken', type: 'address' },
    { name: 'signerAmount', type: 'uint256' },
    { name: 'protocolFee', type: 'uint256' },
    { name: 'senderWallet', type: 'address' },
    { name: 'senderToken', type: 'address' },
    { name: 'senderAmount', type: 'uint256' },
  ],
}

export const domainFor = (chainId, swap) => ({
  name: DOMAIN_NAME,
  version: DOMAIN_VERSION,
  chainId: Number(chainId),
  verifyingContract: getAddress(swap),
})

export class OrderError extends Error {
  constructor(code, message) {
    super(message)
    this.code = code
  }
}

const big = (v, field) => {
  try {
    const b = BigInt(v)
    if (b < 0n || b > UINT256_MAX) throw new Error()
    return b
  } catch {
    throw new OrderError('bad_field', `${field} is not a valid uint256`)
  }
}
const addr = (v, field) => {
  if (typeof v !== 'string' || !isAddress(v, { strict: false })) throw new OrderError('bad_field', `${field} is not an address`)
  return getAddress(v)
}

/** Parse untrusted JSON into a canonical order (BigInt amounts, checksummed addresses). */
export function normalizeOrder(raw) {
  if (!raw || typeof raw !== 'object') throw new OrderError('bad_order', 'order must be an object')
  const v = Number(raw.v)
  if (v !== 27 && v !== 28) throw new OrderError('bad_signature', 'v must be 27 or 28')
  const hex32 = (x, f) => {
    if (typeof x !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(x)) throw new OrderError('bad_signature', `${f} must be 32 bytes hex`)
    return x.toLowerCase()
  }
  return {
    nonce: big(raw.nonce, 'nonce'),
    expiry: big(raw.expiry, 'expiry'),
    signerWallet: addr(raw.signerWallet, 'signerWallet'),
    signerToken: addr(raw.signerToken, 'signerToken'),
    signerAmount: big(raw.signerAmount, 'signerAmount'),
    protocolFee: big(raw.protocolFee, 'protocolFee'),
    senderWallet: raw.senderWallet == null ? zeroAddress : addr(raw.senderWallet, 'senderWallet'),
    senderToken: addr(raw.senderToken, 'senderToken'),
    senderAmount: big(raw.senderAmount, 'senderAmount'),
    v,
    r: hex32(raw.r, 'r'),
    s: hex32(raw.s, 's'),
  }
}

export const typedMessage = (o) => ({
  nonce: o.nonce,
  expiry: o.expiry,
  signerWallet: o.signerWallet,
  signerToken: o.signerToken,
  signerAmount: o.signerAmount,
  protocolFee: o.protocolFee,
  senderWallet: o.senderWallet,
  senderToken: o.senderToken,
  senderAmount: o.senderAmount,
})

export const orderHash = (chainId, swap, o) =>
  hashTypedData({ domain: domainFor(chainId, swap), types: ORDER_TYPES, primaryType: 'OrderERC20', message: typedMessage(o) })

export const packedSignature = (o) => `${o.r}${o.s.slice(2)}${o.v.toString(16).padStart(2, '0')}`

/** EOA fast path: recover the signatory locally (no RPC). */
export const recoverSignatory = (chainId, swap, o) =>
  recoverTypedDataAddress({
    domain: domainFor(chainId, swap),
    types: ORDER_TYPES,
    primaryType: 'OrderERC20',
    message: typedMessage(o),
    signature: packedSignature(o),
  })

/** Funds the signer must hold and approve: amount + protocol fee (fee is paid by the signer on top). */
export const requiredSignerFunds = (o) => o.signerAmount + (o.signerAmount * o.protocolFee) / FEE_DIVISOR

/**
 * Pure, RPC-free checks. Throws OrderError on the first violation.
 * @param o normalized order
 * @param chain { tokens: {addr: {decimals}}, maxExpirySec, minExpirySec }
 * @param ctx { now: bigint (chain time), fee: bigint (current on-chain protocolFee) }
 */
export function validateShape(o, chain, ctx) {
  if (!chain.tokens[o.signerToken]) throw new OrderError('token_not_allowed', `signerToken ${o.signerToken} not whitelisted`)
  if (!chain.tokens[o.senderToken]) throw new OrderError('token_not_allowed', `senderToken ${o.senderToken} not whitelisted`)
  if (o.signerToken === o.senderToken) throw new OrderError('same_token', 'signerToken and senderToken must differ')
  if (o.signerAmount === 0n || o.senderAmount === 0n) throw new OrderError('zero_amount', 'amounts must be > 0')
  if (o.signerWallet === zeroAddress) throw new OrderError('bad_field', 'signerWallet is zero')
  if (o.protocolFee !== ctx.fee) throw new OrderError('fee_mismatch', `order signs protocolFee ${o.protocolFee}, contract requires ${ctx.fee}`)
  if (o.expiry <= ctx.now + BigInt(chain.minExpirySec)) throw new OrderError('expiry_too_short', 'order expires too soon')
  if (o.expiry > ctx.now + BigInt(chain.maxExpirySec)) throw new OrderError('expiry_too_long', `max expiry is ${chain.maxExpirySec}s`)
  // signerAmount * fee must not overflow uint256 inside the contract
  if (o.signerAmount > UINT256_MAX / FEE_DIVISOR) throw new OrderError('bad_field', 'signerAmount too large')
  // the contract rounds the fee down: dust orders would trade fee-free and only pollute the book
  if (ctx.fee > 0n && (o.signerAmount * ctx.fee) / FEE_DIVISOR === 0n) throw new OrderError('fee_too_small', 'order too small: protocol fee rounds to zero')
  const minS = chain.tokens[o.signerToken].min, minR = chain.tokens[o.senderToken].min
  if ((minS != null && o.signerAmount < minS) || (minR != null && o.senderAmount < minR)) throw new OrderError('amount_too_small', 'order below the minimum size for this token')
}
