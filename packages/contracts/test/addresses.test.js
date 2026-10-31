// @fondaco/contracts library checks against the fork: addresses, ABI, EIP-712 helpers and fee formula vs the real contract.
import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import { createPublicClient, createTestClient, createWalletClient, http, parseAbi, getAddress, domainSeparator, hexToString, parseEther } from 'viem'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import { CHAINS, MULTICALL3, swapErc20Abi, domainFor, ORDER_TYPES, protocolFeeOf, requiredSignerFunds, predictSwapAddress, COMPILER_SETTINGS, EVM_VERSION } from '../dist/index.js'
import { deploy } from '../scripts/deploy.js'

const FORK_URL = process.env.FORK_URL || 'http://127.0.0.1:8545'
const chain = { id: 1, name: 'fork', nativeCurrency: { name: 'ETH', symbol: 'ETH', decimals: 18 }, rpcUrls: { default: { http: [FORK_URL] } } }
const pub = createPublicClient({ chain, transport: http(FORK_URL) })
const test = createTestClient({ chain, mode: 'anvil', transport: http(FORK_URL) })
const results = []
const check = (n, ok, d = '') => { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'} | ${n}${d ? ' | ' + d : ''}`) }
const META = parseAbi(['function symbol() view returns (string)', 'function decimals() view returns (uint8)'])

// A1 mainnet tokens and Multicall3 as recorded
const toks = Object.entries(CHAINS[1].tokens)
const seen = await Promise.all(toks.map(async ([, t]) => [await pub.readContract({ address: t.address, abi: META, functionName: 'symbol' }), await pub.readContract({ address: t.address, abi: META, functionName: 'decimals' })]))
const mc = await pub.getCode({ address: MULTICALL3 })
const checksummed = Object.values(CHAINS).every((c) => Object.values(c.tokens).every((t) => getAddress(t.address) === t.address))
check('A1: mainnet token symbols/decimals and Multicall3 match the recorded addresses; all addresses checksummed',
  toks.every(([k, t], i) => seen[i][0] === t.symbol && Number(seen[i][1]) === t.decimals && k === t.symbol) && mc && mc.length > 2 && checksummed && CHAINS[1].swapERC20 === null,
  toks.map(([k], i) => `${k}=${seen[i].join('/')}`).join(' '))

// A2 typed ABI = fixture ABI; settings = verified bytecode
const fx = JSON.parse(readFileSync(new URL('../fixtures/SwapERC20.json', import.meta.url)))
const sha = createHash('sha256').update(Buffer.from(fx.bytecode.slice(2), 'hex')).digest('hex')
check('A2: typed ABI equals the fixture ABI; compiler settings (paris) bind the fixture hash', isDeepStrictEqual(JSON.parse(JSON.stringify(swapErc20Abi)), fx.abi) &&
  EVM_VERSION === 'paris' && COMPILER_SETTINGS.settings.evmVersion === 'paris' && COMPILER_SETTINGS.fixtures.SwapERC20.creationBytecodeSha256 === sha)

// A3 deploy, then the library's domain/types produce signatures the contract accepts, and its fee formula is the contract's
const pk = generatePrivateKey(), deployer = privateKeyToAccount(pk)
await test.setBalance({ address: deployer.address, value: parseEther('10') })
const safe = privateKeyToAccount(generatePrivateKey()).address, feeWallet = privateKeyToAccount(generatePrivateKey()).address
const r = await deploy({ rpc: FORK_URL, privateKey: pk, feeBps: 30, feeWallet, owner: safe, log: () => {} })
check('A3: predictSwapAddress(deployer) = deployed address', predictSwapAddress(deployer.address) === r.swap, r.swap)

const signer = privateKeyToAccount(generatePrivateKey())
const now = (await pub.getBlock()).timestamp
const message = { nonce: 1n, expiry: now + 3600n, signerWallet: signer.address, signerToken: CHAINS[1].tokens.USDC.address, signerAmount: 10n ** 6n, protocolFee: 30n,
  senderWallet: '0x0000000000000000000000000000000000000000', senderToken: CHAINS[1].tokens.WETH.address, senderAmount: 10n ** 15n }
const domain = domainFor(1, r.swap)
const sig = await signer.signTypedData({ domain, types: ORDER_TYPES, primaryType: 'OrderERC20', message })
const v = parseInt(sig.slice(130, 132), 16), rr = '0x' + sig.slice(2, 66), ss = '0x' + sig.slice(66, 130)
const errs = (await pub.readContract({ address: r.swap, abi: swapErc20Abi, functionName: 'check', args: [message.senderWallet, message.nonce, message.expiry, message.signerWallet, message.signerToken, message.signerAmount, message.senderToken, message.senderAmount, v, rr, ss] }))
  .map((e) => hexToString(e, { size: 32 }).replace(/\0+$/, ''))
const domainSep = await pub.readContract({ address: r.swap, abi: swapErc20Abi, functionName: 'DOMAIN_SEPARATOR' })
check('A4: domainFor matches DOMAIN_SEPARATOR; ORDER_TYPES signatures accepted by check() (only funding errors remain)', !errs.includes('SignatureInvalid') && errs.every((e) => e.startsWith('Signer')) &&
  domainSeparator({ domain }) === domainSep,
  `check(): [${errs.join(',')}]`)

const amounts = [1n, 333n, 334n, 10n ** 6n + 1n, 123_456_789_012_345_678n, 10n ** 30n]
const onchain = await Promise.all(amounts.map((a) => pub.readContract({ address: r.swap, abi: swapErc20Abi, functionName: 'calculateProtocolFee', args: [signer.address, a] })))
check('A5: protocolFeeOf = contract calculateProtocolFee; requiredSignerFunds = amount + fee', amounts.every((a, i) => protocolFeeOf(a, 30n) === onchain[i] && requiredSignerFunds({ signerAmount: a, protocolFee: 30n }) === a + onchain[i]),
  amounts.map((a, i) => `${a}→${onchain[i]}`).join(' '))

const failed = results.filter((x) => !x).length
console.log(`\n${results.length - failed}/${results.length} checks passed`)
process.exit(failed ? 1 : 0)
