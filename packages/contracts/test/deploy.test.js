// Checks scripts/deploy.js on a local fork: nonce-0 address, ownership handed to the Safe, settings asserted.
import { createPublicClient, createTestClient, createWalletClient, http, getContractAddress, parseEther } from 'viem'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import { readFileSync } from 'node:fs'
import { deploy } from '../scripts/deploy.js'

const FORK_URL = process.env.FORK_URL || 'http://127.0.0.1:8545'
const WETH = '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2'
const chain = { id: 1, name: 'fork', nativeCurrency: { name: 'ETH', symbol: 'ETH', decimals: 18 }, rpcUrls: { default: { http: [FORK_URL] } } }
const pub = createPublicClient({ chain, transport: http(FORK_URL, { timeout: 180_000 }) })
const test = createTestClient({ chain, mode: 'hardhat', transport: http(FORK_URL, { timeout: 180_000 }) })
const swapAbi = JSON.parse(readFileSync(new URL('./fixtures/SwapERC20.json', import.meta.url))).abi

const results = []
const check = (n, ok, d = '') => { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'} | ${n}${d ? ' | ' + d : ''}`) }

const pk = generatePrivateKey()
const deployer = privateKeyToAccount(pk)
const safe = privateKeyToAccount(generatePrivateKey()).address
const feeWallet = privateKeyToAccount(generatePrivateKey()).address
await test.setBalance({ address: deployer.address, value: parseEther('10') })

const r = await deploy({ rpc: FORK_URL, privateKey: pk, feeBps: 30, feeWallet, owner: safe, weth: WETH, log: () => {} })
check('D1: SwapERC20 at the nonce-0 address of the deployer', r.swap === getContractAddress({ from: deployer.address, nonce: 0n }), r.swap)
check('D2: owner is the Safe, fee/feeLight 30, staking unset, bonus 0', r.owner === safe && r.protocolFee === 30n && r.protocolFeeLight === 30n && r.bonusMax === 0n)

// deployer lost admin rights; Safe has them
const dw = createWalletClient({ account: deployer, chain, transport: http(FORK_URL, { timeout: 180_000 }) })
let blocked = false
try { await pub.simulateContract({ account: deployer, address: r.swap, abi: swapAbi, functionName: 'setProtocolFee', args: [40n] }) } catch { blocked = true }
await test.impersonateAccount({ address: safe })
await test.setBalance({ address: safe, value: parseEther('1') })
const sw = createWalletClient({ account: safe, chain, transport: http(FORK_URL, { timeout: 180_000 }) })
const h = await sw.writeContract({ address: r.swap, abi: swapAbi, functionName: 'setProtocolFee', args: [40n] })
const ok = (await pub.waitForTransactionReceipt({ hash: h })).status === 'success'
check('D3: deployer can no longer administer; Safe can', blocked && ok)

let again = false
try { await deploy({ rpc: FORK_URL, privateKey: pk, feeBps: 30, feeWallet, owner: safe, log: () => {} }) } catch (e) { again = /nonce is/.test(e.message) }
check('D4: re-running with a used deployer key is refused (protects address determinism)', again)
void dw

console.log(`\n${results.filter(Boolean).length}/${results.length} checks passed`)
process.exit(results.every(Boolean) ? 0 : 1)
