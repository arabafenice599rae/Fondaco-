// EIP-712 model of SwapERC20 v4.3 orders. Must match _domainNameAndVersion() and ORDER_TYPEHASH in the tagged source.
import { getAddress, type Address, type Hex } from 'viem'

export const DOMAIN_NAME = 'SWAP_ERC20'
export const DOMAIN_VERSION = '4.3'
export const FEE_DIVISOR = 10_000n

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
} as const

/** The signed fields. `senderWallet = 0x0` = public order (swapAnySender); an address = private order (swap). */
export interface OrderERC20 {
  nonce: bigint
  expiry: bigint
  signerWallet: Address
  signerToken: Address
  signerAmount: bigint
  protocolFee: bigint
  senderWallet: Address
  senderToken: Address
  senderAmount: bigint
}

/** A signed order: v is 27 or 28, r and s are 32-byte hex. The recipient is NOT signed: the taker chooses it. */
export interface SignedOrderERC20 extends OrderERC20 {
  v: 27 | 28
  r: Hex
  s: Hex
}

/** Wire format (JSON): every integer as a decimal string. */
export type SignedOrderJson = { [K in keyof OrderERC20]: string } & { v: number; r: string; s: string }

export const domainFor = (chainId: number | bigint, swap: Address) => ({
  name: DOMAIN_NAME,
  version: DOMAIN_VERSION,
  chainId: Number(chainId),
  verifyingContract: getAddress(swap),
}) as const

/** Fee paid by the SIGNER in signerToken, on top of signerAmount: floor(signerAmount × protocolFee / 10000). */
export const protocolFeeOf = (signerAmount: bigint, protocolFee: bigint): bigint => (signerAmount * protocolFee) / FEE_DIVISOR

/** What the signer must hold and approve: signerAmount + fee. The taker pays exactly senderAmount. */
export const requiredSignerFunds = (o: Pick<OrderERC20, 'signerAmount' | 'protocolFee'>): bigint => o.signerAmount + protocolFeeOf(o.signerAmount, o.protocolFee)
