// Self-test of the fork helpers: fixed fork block, random code-free wallets, token funding by storage and by deposit.
import { parseAbi } from 'viem'
import { forkClients, randomWallet, setTokenBalance, depositWeth, TOKENS } from './index.js'

const ctx = forkClients()
const { pub } = ctx
const results = []
const check = (n, ok, d = '') => { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'} | ${n}${d ? ' | ' + d : ''}`) }
const ERC20 = parseAbi(['function balanceOf(address) view returns (uint256)'])
const bal = (t, a) => pub.readContract({ address: t, abi: ERC20, functionName: 'balanceOf', args: [a] })

const expectBlock = BigInt(process.env.FORK_BLOCK ?? 23_700_000)
const head = await pub.getBlockNumber()
check('K1: fork pinned to the configured block', head === expectBlock, `head ${head}, FORK_BLOCK ${expectBlock}`)

// default dev accounts (mnemonic "test test … junk") are public keys on mainnet too: anyone can attach an EIP-7702 delegation
const DEV0 = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266'
const code0 = await pub.getCode({ address: DEV0 })
const w = await randomWallet(ctx)
check('K2: random wallets carry no code (no EIP-7702 delegation)', !(await pub.getCode({ address: w.address })),
  `dev account #0 on this fork: ${code0 && code0 !== '0x' ? `has code ${code0.slice(0, 10)}… (7702: ${code0.startsWith('0xef0100')})` : 'no code'}`)

const amounts = { USDC: 1234n * 10n ** 6n, USDT: 567n * 10n ** 6n, WETH: 3n * 10n ** 18n, DAI: 89n * 10n ** 18n }
const got = {}
for (const [sym, amt] of Object.entries(amounts)) { await setTokenBalance(ctx, TOKENS[sym].address, w.address, amt); got[sym] = await bal(TOKENS[sym].address, w.address) }
check('K3: balances set via storage (USDC slot 9, USDT slot 2, WETH slot 3, DAI slot 2)', Object.entries(amounts).every(([s, a]) => got[s] === a), Object.entries(got).map(([s, v]) => `${s}=${v}`).join(' '))

const before = await bal(TOKENS.WETH.address, w.address)
const rc = await depositWeth(ctx, w, 10n ** 17n)
check('K4: WETH via a real deposit (Deposit event)', (await bal(TOKENS.WETH.address, w.address)) - before === 10n ** 17n && rc.logs.some((l) => l.topics[0] === '0xe1fffcc4923d04b559f4d29a8bfc6cda04eb5b0d3c460751c2402c5c5cc9109c'))

const failed = results.filter((x) => !x).length
console.log(`\n${results.length - failed}/${results.length} checks passed`)
process.exit(failed ? 1 : 0)
