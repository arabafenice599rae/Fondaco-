// Deploy SwapERC20 v5.0.0 (+ optional Wrapper) from the tagged-source fixtures and hand ownership to a Safe.
//
// Same address on every chain: use a DEDICATED deployer key whose nonce is 0 on each chain.
// CREATE addresses depend only on (deployer, nonce), so tx #0 = SwapERC20 and tx #1 = Wrapper land at the
// same addresses everywhere. (Do NOT use a CREATE2 factory: SwapERC20 sets owner = msg.sender in its
// constructor, so the factory would become the owner and fee settings would be frozen forever.)
//
// env: RPC_URL, PRIVATE_KEY, FEE_BPS, FEE_WALLET, OWNER (Safe), WETH (optional → deploys Wrapper)
import { readFileSync } from 'node:fs'
import { createPublicClient, createWalletClient, http, getContractAddress, getAddress, domainSeparator } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'

const load = (n) => JSON.parse(readFileSync(new URL(`../fixtures/${n}.json`, import.meta.url)))
const need = (k) => { const v = process.env[k]; if (!v) throw new Error(`missing env ${k}`); return v }

export async function deploy({ rpc, privateKey, feeBps, feeWallet, owner, weth, allowNonZeroNonce = false, log = console.log }) {
  const account = privateKeyToAccount(privateKey)
  const pub = createPublicClient({ transport: http(rpc) })
  const chainId = await pub.getChainId()
  const chain = { id: chainId, name: `chain-${chainId}`, nativeCurrency: { name: 'ETH', symbol: 'ETH', decimals: 18 }, rpcUrls: { default: { http: [rpc] } } }
  const wallet = createWalletClient({ account, chain, transport: http(rpc) })
  const swapArt = load('SwapERC20'), wrapArt = load('Wrapper')
  const fee = BigInt(feeBps)
  if (fee <= 0n || fee > 100n) throw new Error('FEE_BPS out of the sane range 1..100 (contract allows up to 9999)')
  owner = getAddress(owner)
  feeWallet = getAddress(feeWallet)

  const nonce = await pub.getTransactionCount({ address: account.address })
  if (nonce !== 0 && !allowNonZeroNonce) throw new Error(`deployer nonce is ${nonce}, expected 0 for a cross-chain identical address`)
  const expected = getContractAddress({ from: account.address, nonce: BigInt(nonce) })

  const wait = async (hash, what) => {
    const rc = await pub.waitForTransactionReceipt({ hash })
    if (rc.status !== 'success') throw new Error(`${what} reverted (${hash})`)
    log(`${what}: ok (gas ${rc.gasUsed})`)
    return rc
  }

  // 1) SwapERC20(protocolFee, protocolFeeLight, feeWallet, bonusScale=0, bonusMax=0); stakingToken stays unset
  const rc = await wait(await wallet.deployContract({ abi: swapArt.abi, bytecode: swapArt.bytecode, args: [fee, fee, feeWallet, 0n, 0n] }), 'deploy SwapERC20')
  const swap = getAddress(rc.contractAddress)
  if (swap !== expected) throw new Error(`unexpected address ${swap} (expected ${expected})`)

  // 2) optional Wrapper (native ETH for takers)
  let wrapper = null
  if (weth) {
    const wr = await wait(await wallet.deployContract({ abi: wrapArt.abi, bytecode: wrapArt.bytecode, args: [swap, getAddress(weth)] }), 'deploy Wrapper')
    wrapper = getAddress(wr.contractAddress)
  }

  // 3) hand over ownership. SwapERC20 (solady Ownable): direct transfer. Wrapper (OZ Ownable2Step): Safe must acceptOwnership().
  await wait(await wallet.writeContract({ address: swap, abi: swapArt.abi, functionName: 'transferOwnership', args: [owner] }), 'SwapERC20.transferOwnership')
  if (wrapper) await wait(await wallet.writeContract({ address: wrapper, abi: wrapArt.abi, functionName: 'transferOwnership', args: [owner] }), 'Wrapper.transferOwnership (pending accept)')

  // 4) post-deploy assertions
  const read = (fn) => pub.readContract({ address: swap, abi: swapArt.abi, functionName: fn })
  const state = {
    owner: getAddress(await read('owner')),
    protocolFee: await read('protocolFee'),
    protocolFeeLight: await read('protocolFeeLight'),
    protocolFeeWallet: getAddress(await read('protocolFeeWallet')),
    stakingToken: getAddress(await read('stakingToken')),
    bonusMax: await read('bonusMax'),
    bonusScale: await read('bonusScale'),
    domainSeparator: await read('DOMAIN_SEPARATOR'),
  }
  // DOMAIN_SEPARATOR is an immutable baked in at deploy (chainId + address), so runtime bytecode differs per chain:
  // verify the domain explicitly instead of comparing raw bytecode across chains.
  const expectedDomain = domainSeparator({ domain: { name: 'SWAP_ERC20', version: '4.3', chainId, verifyingContract: swap } })
  const ok = state.owner === owner && state.protocolFee === fee && state.protocolFeeLight === fee && state.protocolFeeWallet === feeWallet &&
    state.stakingToken === '0x0000000000000000000000000000000000000000' && state.bonusMax === 0n && state.bonusScale === 0n &&
    state.domainSeparator === expectedDomain
  if (!ok) throw new Error(`post-deploy check failed: ${JSON.stringify(state, (_, v) => (typeof v === 'bigint' ? v.toString() : v))}`)
  if (wrapper) {
    const wread = (fn) => pub.readContract({ address: wrapper, abi: wrapArt.abi, functionName: fn })
    const w = { swap: getAddress(await wread('swapERC20Contract')), weth: getAddress(await wread('wethContract')), pending: getAddress(await wread('pendingOwner')) }
    if (w.swap !== swap || w.weth !== getAddress(weth) || w.pending !== owner) throw new Error(`Wrapper post-deploy check failed: ${JSON.stringify(w)}`)
  }
  return { chainId, swap, wrapper, ...state, wrapperPendingOwner: wrapper ? owner : null }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  deploy({ rpc: need('RPC_URL'), privateKey: need('PRIVATE_KEY'), feeBps: need('FEE_BPS'), feeWallet: need('FEE_WALLET'), owner: need('OWNER'), weth: process.env.WETH })
    .then((r) => console.log(JSON.stringify(r, (_, v) => (typeof v === 'bigint' ? v.toString() : v), 2)))
    .catch((e) => { console.error(e.message); process.exit(1) })
}
