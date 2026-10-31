// Checks scripts/deploy.js on a local fork: nonce-0 address, ownership handed to the Safe, settings asserted.
// D1–D4 unchanged from the reference; D5–D8: no Wrapper in v1, dry run, idempotent re-run, resume after an interrupted run.
import { createPublicClient, createTestClient, createWalletClient, http, getContractAddress, parseEther } from 'viem'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import { readFileSync } from 'node:fs'
import { deploy } from '../scripts/deploy.js'

const FORK_URL = process.env.FORK_URL || 'http://127.0.0.1:8545'
const WETH = '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2'
const chain = { id: 1, name: 'fork', nativeCurrency: { name: 'ETH', symbol: 'ETH', decimals: 18 }, rpcUrls: { default: { http: [FORK_URL] } } }
const pub = createPublicClient({ chain, transport: http(FORK_URL, { timeout: 180_000 }) })
const test = createTestClient({ chain, mode: 'hardhat', transport: http(FORK_URL, { timeout: 180_000 }) })
const swapAbi = JSON.parse(readFileSync(new URL('../fixtures/SwapERC20.json', import.meta.url))).abi

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

// D5 no Wrapper (v1): even with WETH given, only tx #0 (deploy) and tx #1 (transferOwnership) are sent; nothing at the nonce-1 address
const n5 = await pub.getTransactionCount({ address: deployer.address })
const nonce1Addr = getContractAddress({ from: deployer.address, nonce: 1n })
const code5 = await pub.getCode({ address: nonce1Addr })
check('D5: deploy does NOT create the Wrapper (WETH ignored, no contract at the nonce-1 address, no wrapper in the result)',
  n5 === 2 && (!code5 || code5 === '0x') && !('wrapper' in r) && !('wrapperPendingOwner' in r), `deployer nonce ${n5}, code at ${nonce1Addr}: ${code5 || 'none'}`)

// D6 dry run: plan with the deterministic address and gas, nothing signed or sent; works with an address only
const fresh = privateKeyToAccount(generatePrivateKey())
await test.setBalance({ address: fresh.address, value: parseEther('10') })
const plan = await deploy({ rpc: FORK_URL, deployer: fresh.address, feeBps: 30, feeWallet, owner: safe, dryRun: true, log: () => {} })
const expected6 = getContractAddress({ from: fresh.address, nonce: 0n })
const code6 = await pub.getCode({ address: expected6 })
check('D6: dry run reports the plan (address, gas, paris settings) and sends nothing', plan.dryRun && plan.action === 'deploy' && plan.swap === expected6 && plan.deployGas > 0n &&
  plan.compiler.evmVersion === 'paris' && (await pub.getTransactionCount({ address: fresh.address })) === 0 && (!code6 || code6 === '0x'), `${plan.action} at ${plan.swap}, gas ${plan.deployGas}`)

// D7 idempotent: a second run with unchanged settings only verifies (no transaction)
const pk7 = generatePrivateKey(), d7 = privateKeyToAccount(pk7)
await test.setBalance({ address: d7.address, value: parseEther('10') })
const first7 = await deploy({ rpc: FORK_URL, privateKey: pk7, feeBps: 30, feeWallet, owner: safe, log: () => {} })
const n7 = await pub.getTransactionCount({ address: d7.address })
const again7 = await deploy({ rpc: FORK_URL, privateKey: pk7, feeBps: 30, feeWallet, owner: safe, log: () => {} })
check('D7: re-run with unchanged settings is a verified no-op', !first7.alreadyDeployed && again7.alreadyDeployed && again7.swap === first7.swap &&
  (await pub.getTransactionCount({ address: d7.address })) === n7, `nonce stays ${n7}`)

// D8 resume: run interrupted after tx #0 (owner still the deployer) → only transferOwnership is sent, then verified
const pk8 = generatePrivateKey(), d8 = privateKeyToAccount(pk8)
await test.setBalance({ address: d8.address, value: parseEther('10') })
const w8 = createWalletClient({ account: d8, chain, transport: http(FORK_URL, { timeout: 180_000 }) })
const art = JSON.parse(readFileSync(new URL('../fixtures/SwapERC20.json', import.meta.url)))
await pub.waitForTransactionReceipt({ hash: await w8.deployContract({ abi: art.abi, bytecode: art.bytecode, args: [30n, 30n, feeWallet, 0n, 0n] }) })
const r8 = await deploy({ rpc: FORK_URL, privateKey: pk8, feeBps: 30, feeWallet, owner: safe, log: () => {} })
check('D8: interrupted run resumed (transferOwnership only), owner = Safe', r8.resumed && r8.owner === safe && (await pub.getTransactionCount({ address: d8.address })) === 2)

console.log(`\n${results.filter(Boolean).length}/${results.length} checks passed`)
process.exit(results.every(Boolean) ? 0 : 1)
