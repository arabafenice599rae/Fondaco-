// Who pays the protocol fee, measured on-chain: SwapERC20 v4.3 (fixture compiled from tag v4.3, commit 6ad0137) on a mainnet fork.
// Expected: the signer pays fee = floor(signerAmount * protocolFee / 10000) in signerToken, on top of signerAmount;
// the sender pays exactly senderAmount and receives exactly signerAmount.
import { readFileSync } from 'node:fs'
import { createPublicClient, createWalletClient, createTestClient, http, parseAbi, encodeAbiParameters, keccak256, toHex, getAddress } from 'viem'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'

const FORK_URL = process.env.FORK_URL || 'http://127.0.0.1:8545'
const USDC = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', WETH = '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2'
const chain = { id: 1, name: 'fork', nativeCurrency: { name: 'ETH', symbol: 'ETH', decimals: 18 }, rpcUrls: { default: { http: [FORK_URL] } } }
const t = () => http(FORK_URL, { timeout: 180_000 })
const pub = createPublicClient({ chain, transport: t() }), test = createTestClient({ chain, mode: 'hardhat', transport: t() })
const ERC20 = parseAbi(['function approve(address,uint256)', 'function deposit() payable', 'function balanceOf(address) view returns (uint256)'])
const Art = JSON.parse(readFileSync(new URL('../fixtures/SwapERC20.json', import.meta.url)))
const results = []
const check = (n, ok, d = '') => { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'} | ${n}${d ? ' | ' + d : ''}`) }
const wallet = async () => { const account = privateKeyToAccount(generatePrivateKey()); await test.setBalance({ address: account.address, value: 10n ** 21n }); return { account, address: account.address, client: createWalletClient({ account, chain, transport: t() }) } }
const send = async (w, r) => { const rc = await pub.waitForTransactionReceipt({ hash: await w.client.writeContract(r) }); if (rc.status !== 'success') throw new Error('reverted'); return rc }
const bal = (tok, a) => pub.readContract({ address: tok, abi: ERC20, functionName: 'balanceOf', args: [a] })

const [owner, signer, sender, feeWallet] = await Promise.all(Array.from({ length: 4 }, wallet))
const FEE = 30n
const SWAP = getAddress((await pub.waitForTransactionReceipt({ hash: await owner.client.deployContract({ abi: Art.abi, bytecode: Art.bytecode, args: [FEE, FEE, feeWallet.address, 0n, 0n] }) })).contractAddress)
await send(signer, { address: WETH, abi: ERC20, functionName: 'deposit', value: 3n * 10n ** 18n })
await send(signer, { address: WETH, abi: ERC20, functionName: 'approve', args: [SWAP, 2n ** 256n - 1n] })
await test.setStorageAt({ address: USDC, index: keccak256(encodeAbiParameters([{ type: 'address' }, { type: 'uint256' }], [sender.address, 9n])), value: toHex(10n ** 12n, { size: 32 }) })
await send(sender, { address: USDC, abi: ERC20, functionName: 'approve', args: [SWAP, 2n ** 256n - 1n] })

async function signed(signerAmount, senderAmount, nonce) {
  const now = (await pub.getBlock()).timestamp
  const message = { nonce, expiry: now + 3600n, signerWallet: signer.address, signerToken: WETH, signerAmount, protocolFee: FEE, senderWallet: '0x0000000000000000000000000000000000000000', senderToken: USDC, senderAmount }
  const types = { OrderERC20: [{ name: 'nonce', type: 'uint256' }, { name: 'expiry', type: 'uint256' }, { name: 'signerWallet', type: 'address' }, { name: 'signerToken', type: 'address' }, { name: 'signerAmount', type: 'uint256' }, { name: 'protocolFee', type: 'uint256' }, { name: 'senderWallet', type: 'address' }, { name: 'senderToken', type: 'address' }, { name: 'senderAmount', type: 'uint256' }] }
  const sig = await signer.account.signTypedData({ domain: { name: 'SWAP_ERC20', version: '4.3', chainId: 1, verifyingContract: SWAP }, types, primaryType: 'OrderERC20', message })
  return { ...message, v: parseInt(sig.slice(130, 132), 16), r: '0x' + sig.slice(2, 66), s: '0x' + sig.slice(66, 130) }
}
const snap = async () => ({ sW: await bal(WETH, signer.address), sU: await bal(USDC, signer.address), rW: await bal(WETH, sender.address), rU: await bal(USDC, sender.address), fW: await bal(WETH, feeWallet.address), fU: await bal(USDC, feeWallet.address) })

for (const [label, fn] of [['swapAnySender', 'swapAnySender'], ['swap', 'swap']]) {
  const signerAmount = 10n ** 18n + 12_345n, senderAmount = 2_500n * 10n ** 6n
  // swap() binds the sender: the order must be signed for sender.address
  const o = label === 'swap' ? await (async () => { const x = await signed(signerAmount, senderAmount, 2n); return x })() : await signed(signerAmount, senderAmount, 1n)
  if (label === 'swap') {
    const now = (await pub.getBlock()).timestamp
    const message = { nonce: 2n, expiry: now + 3600n, signerWallet: signer.address, signerToken: WETH, signerAmount, protocolFee: FEE, senderWallet: sender.address, senderToken: USDC, senderAmount }
    const types = { OrderERC20: [{ name: 'nonce', type: 'uint256' }, { name: 'expiry', type: 'uint256' }, { name: 'signerWallet', type: 'address' }, { name: 'signerToken', type: 'address' }, { name: 'signerAmount', type: 'uint256' }, { name: 'protocolFee', type: 'uint256' }, { name: 'senderWallet', type: 'address' }, { name: 'senderToken', type: 'address' }, { name: 'senderAmount', type: 'uint256' }] }
    const sig = await signer.account.signTypedData({ domain: { name: 'SWAP_ERC20', version: '4.3', chainId: 1, verifyingContract: SWAP }, types, primaryType: 'OrderERC20', message })
    Object.assign(o, message, { v: parseInt(sig.slice(130, 132), 16), r: '0x' + sig.slice(2, 66), s: '0x' + sig.slice(66, 130) })
  }
  const b0 = await snap()
  await send(sender, { address: SWAP, abi: Art.abi, functionName: fn, args: [sender.address, o.nonce, o.expiry, o.signerWallet, o.signerToken, o.signerAmount, o.senderToken, o.senderAmount, o.v, o.r, o.s] })
  const b1 = await snap()
  const fee = (signerAmount * FEE) / 10000n
  const d = { signerWETH: b0.sW - b1.sW, signerUSDC: b1.sU - b0.sU, senderWETH: b1.rW - b0.rW, senderUSDC: b0.rU - b1.rU, feeWETH: b1.fW - b0.fW, feeUSDC: b1.fU - b0.fU }
  check(`F-${label}: fee paid by the signer in signerToken; sender pays/receives exact amounts`,
    d.feeWETH === fee && d.feeUSDC === 0n && d.signerWETH === signerAmount + fee && d.senderWETH === signerAmount && d.senderUSDC === senderAmount && d.signerUSDC === senderAmount,
    `fee wallet +${d.feeWETH} wei WETH (= floor(${signerAmount}·30/10000) = ${fee}), +${d.feeUSDC} USDC; signer −${d.signerWETH} WETH; sender −${d.senderUSDC} USDC, +${d.senderWETH} WETH`)
}
const failed = results.filter((x) => !x).length
console.log(`\n${results.length - failed}/${results.length} checks passed`)
process.exit(failed ? 1 : 0)
