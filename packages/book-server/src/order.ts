// Order model for AirSwap SwapERC20 v5.0.0: EIP-712 types, normalization, pure validation.
import { getAddress, hashTypedData, isAddress, recoverTypedDataAddress, zeroAddress, type Address, type Hex } from 'viem'
import { DOMAIN_NAME, DOMAIN_VERSION, FEE_DIVISOR, ORDER_TYPES, domainFor } from '@fondaco/contracts'
import type { ChainCfg, NormalizedOrder } from './types.js'

export { DOMAIN_NAME, DOMAIN_VERSION, FEE_DIVISOR, ORDER_TYPES, domainFor }
const UINT256_MAX = (1n << 256n) - 1n

export class OrderError extends Error {
  readonly code: string
  constructor(code: string, message: string) {
    super(message)
    this.code = code
  }
}

const big = (v: unknown, field: string): bigint => {
  try {
    const b = BigInt(v as string | number | bigint)
    if (b < 0n || b > UINT256_MAX) throw new Error()
    return b
  } catch {
    throw new OrderError('bad_field', `${field} is not a valid uint256`)
  }
}
const addr = (v: unknown, field: string): Address => {
  if (typeof v !== 'string' || !isAddress(v, { strict: false })) throw new OrderError('bad_field', `${field} is not an address`)
  return getAddress(v)
}

/** Parse untrusted JSON into a canonical order (BigInt amounts, checksummed addresses). */
export function normalizeOrder(raw: unknown): NormalizedOrder {
  if (!raw || typeof raw !== 'object') throw new OrderError('bad_order', 'order must be an object')
  const o = raw as Record<string, unknown>
  const v = Number(o.v)
  if (v !== 27 && v !== 28) throw new OrderError('bad_signature', 'v must be 27 or 28')
  const hex32 = (x: unknown, f: string): Hex => {
    if (typeof x !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(x)) throw new OrderError('bad_signature', `${f} must be 32 bytes hex`)
    return x.toLowerCase() as Hex
  }
  return {
    nonce: big(o.nonce, 'nonce'),
    expiry: big(o.expiry, 'expiry'),
    signerWallet: addr(o.signerWallet, 'signerWallet'),
    signerToken: addr(o.signerToken, 'signerToken'),
    signerAmount: big(o.signerAmount, 'signerAmount'),
    protocolFee: big(o.protocolFee, 'protocolFee'),
    senderWallet: o.senderWallet == null ? zeroAddress : addr(o.senderWallet, 'senderWallet'),
    senderToken: addr(o.senderToken, 'senderToken'),
    senderAmount: big(o.senderAmount, 'senderAmount'),
    v,
    r: hex32(o.r, 'r'),
    s: hex32(o.s, 's'),
  }
}

export const typedMessage = (o: NormalizedOrder) => ({
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

export const orderHash = (chainId: number, swap: Address, o: NormalizedOrder): Hex =>
  hashTypedData({ domain: domainFor(chainId, swap), types: ORDER_TYPES, primaryType: 'OrderERC20', message: typedMessage(o) })

export const packedSignature = (o: Pick<NormalizedOrder, 'r' | 's' | 'v'>): Hex => `${o.r}${o.s.slice(2)}${o.v.toString(16).padStart(2, '0')}` as Hex

/** EOA fast path: recover the signatory locally (no RPC). */
export const recoverSignatory = (chainId: number, swap: Address, o: NormalizedOrder): Promise<Address> =>
  recoverTypedDataAddress({
    domain: domainFor(chainId, swap),
    types: ORDER_TYPES,
    primaryType: 'OrderERC20',
    message: typedMessage(o),
    signature: packedSignature(o),
  })

/** Funds the signer must hold and approve: amount + protocol fee (fee is paid by the signer on top). */
export const requiredSignerFunds = (o: Pick<NormalizedOrder, 'signerAmount' | 'protocolFee'>): bigint => o.signerAmount + (o.signerAmount * o.protocolFee) / FEE_DIVISOR

/**
 * Pure, RPC-free checks. Throws OrderError on the first violation.
 * @param ctx now = chain time, fee = current on-chain protocolFee
 */
export function validateShape(o: NormalizedOrder, chain: Pick<ChainCfg, 'tokens' | 'minExpirySec' | 'maxExpirySec'>, ctx: { now: bigint; fee: bigint }): void {
  const tokS = chain.tokens[o.signerToken], tokR = chain.tokens[o.senderToken]
  if (!tokS) throw new OrderError('token_not_allowed', `signerToken ${o.signerToken} not whitelisted`)
  if (!tokR) throw new OrderError('token_not_allowed', `senderToken ${o.senderToken} not whitelisted`)
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
  const minS = tokS.min, minR = tokR.min
  if ((minS != null && o.signerAmount < minS) || (minR != null && o.senderAmount < minR)) throw new OrderError('amount_too_small', 'order below the minimum size for this token')
}
