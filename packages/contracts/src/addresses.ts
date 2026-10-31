// Addresses per chain. Token and Multicall3 addresses were checked on-chain (symbol, decimals, code) on 2026-10-31;
// packages/contracts/test/addresses.test.js re-checks the mainnet ones on the fork.
// swapERC20 is null until FONDACO deploys it on that chain (deterministic: nonce 0 of the dedicated deployer).
import { getContractAddress, type Address } from 'viem'

export const MULTICALL3: Address = '0xcA11bde05977b3631167028862bE2a173976CA11'

export interface TokenInfo { address: Address; symbol: string; decimals: number }
export interface ChainAddresses {
  chainId: number
  name: string
  /** FONDACO's SwapERC20 v5.0.0 deployment, null = not deployed yet */
  swapERC20: Address | null
  multicall3: Address
  tokens: Readonly<Record<string, TokenInfo>>
}

export const CHAINS: Readonly<Record<number, ChainAddresses>> = {
  1: {
    chainId: 1,
    name: 'Ethereum',
    swapERC20: null,
    multicall3: MULTICALL3,
    tokens: {
      USDC: { address: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', symbol: 'USDC', decimals: 6 },
      USDT: { address: '0xdAC17F958D2ee523a2206206994597C13D831ec7', symbol: 'USDT', decimals: 6 },
      WETH: { address: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2', symbol: 'WETH', decimals: 18 },
    },
  },
  8453: {
    chainId: 8453,
    name: 'Base',
    swapERC20: null,
    multicall3: MULTICALL3,
    tokens: {
      USDC: { address: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', symbol: 'USDC', decimals: 6 },
      WETH: { address: '0x4200000000000000000000000000000000000006', symbol: 'WETH', decimals: 18 },
    },
  },
}

export function chainAddresses(chainId: number): ChainAddresses {
  const c = CHAINS[chainId]
  if (!c) throw new Error(`chain ${chainId} is not configured`)
  return c
}

/** SwapERC20 address for a dedicated deployer: always its nonce-0 CREATE address, identical on every chain. */
export const predictSwapAddress = (deployer: Address): Address => getContractAddress({ from: deployer, nonce: 0n })
