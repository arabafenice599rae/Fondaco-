// Test helpers for a local mainnet fork: chain definition, RANDOM funded wallets (the default anvil/hardhat accounts
// may carry EIP-7702 delegations on mainnet, which would make them contracts), token funding via storage or deposit.
import { createPublicClient, createTestClient, createWalletClient, http, parseAbi, encodeAbiParameters, keccak256, toHex, getAddress } from 'viem'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'

export const TOKENS = {
  USDC: { address: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', decimals: 6, balanceSlot: 9n },
  USDT: { address: '0xdAC17F958D2ee523a2206206994597C13D831ec7', decimals: 6, balanceSlot: 2n },
  WETH: { address: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2', decimals: 18, balanceSlot: 3n },
  DAI: { address: '0x6B175474E89094C44Da98b954EedeAC495271d0F', decimals: 18, balanceSlot: 2n },
}
const ERC20 = parseAbi(['function balanceOf(address) view returns (uint256)', 'function deposit() payable'])

export const forkChain = (url) => ({ id: 1, name: 'fork', nativeCurrency: { name: 'ETH', symbol: 'ETH', decimals: 18 }, rpcUrls: { default: { http: [url] } } })

export function forkClients(url = process.env.FORK_URL || 'http://127.0.0.1:8545', { pollingInterval } = {}) {
  const chain = forkChain(url)
  const transport = () => http(url, { timeout: 180_000 })
  return {
    chain, transport,
    pub: createPublicClient({ chain, transport: transport(), ...(pollingInterval ? { pollingInterval } : {}) }),
    test: createTestClient({ chain, mode: 'anvil', transport: transport() }),
  }
}

/** A fresh random EOA with ETH. Asserts it has no code (no EIP-7702 delegation). */
export async function randomWallet({ pub, test, chain, transport }, eth = 10n ** 21n) {
  const account = privateKeyToAccount(generatePrivateKey())
  await test.setBalance({ address: account.address, value: eth })
  const code = await pub.getCode({ address: account.address })
  if (code && code !== '0x') throw new Error(`random wallet ${account.address} unexpectedly has code`)
  return { account, address: account.address, client: createWalletClient({ account, chain, transport: transport() }) }
}

/** Solidity mapping(address => uint256) slot for `holder` at mapping slot `slot`. */
export const mappingSlot = (holder, slot) => keccak256(encodeAbiParameters([{ type: 'address' }, { type: 'uint256' }], [getAddress(holder), slot]))

/** Set a token balance by writing its balance mapping, then read it back (fails loudly if the layout is wrong). */
export async function setTokenBalance({ pub, test }, token, holder, amount) {
  const t = typeof token === 'string' ? Object.values(TOKENS).find((x) => getAddress(x.address) === getAddress(token)) : token
  if (!t) throw new Error(`unknown token layout for ${token}`)
  await test.setStorageAt({ address: t.address, index: mappingSlot(holder, t.balanceSlot), value: toHex(amount, { size: 32 }) })
  const got = await pub.readContract({ address: t.address, abi: ERC20, functionName: 'balanceOf', args: [holder] })
  if (got !== amount) throw new Error(`balance write failed for ${t.address}: read back ${got}, expected ${amount}`)
  return got
}

/** Wrap ETH into WETH with a real deposit (emits Deposit, like a user would). */
export async function depositWeth({ pub }, w, amount) {
  const rc = await pub.waitForTransactionReceipt({ hash: await w.client.writeContract({ address: TOKENS.WETH.address, abi: ERC20, functionName: 'deposit', value: amount }) })
  if (rc.status !== 'success') throw new Error('WETH deposit reverted')
  return rc
}
