// Deploy AirSwap SwapERC20 v4.3 (unmodified, from the verified fixture) and hand ownership to a Safe.
//
// Same address on every chain: a DEDICATED deployer key whose nonce is 0 on each chain. CREATE addresses depend only
// on (deployer, nonce), so tx #0 = SwapERC20 lands at the same address everywhere. Do NOT use a CREATE2 factory:
// SwapERC20 sets owner = msg.sender in its constructor, so the factory would become the owner.
//
// The Wrapper (native ETH) is excluded from v1 and is never deployed.
//
// Idempotent:
//   nonce 0                              → deploy (tx #0), transferOwnership (tx #1), verify
//   nonce > 0, contract at the nonce-0 address with the expected settings:
//     owner = deployer (interrupted run)  → transferOwnership only, verify
//     owner = Safe                        → nothing sent, verify only (alreadyDeployed: true)
//   anything else                        → refused: the deterministic address is no longer available
// Dry run (dryRun: true / --dry-run): reads only, signs and sends nothing; works with DEPLOYER (an address) instead of a key.
//
// Build settings of the fixture: packages/contracts/compiler-settings.json (solc 0.8.23, optimizer 999999 runs,
// evmVersion paris). The fixture's bytecode hash is checked against it before anything is sent.
//
// env: RPC_URL, PRIVATE_KEY (or DEPLOYER for --dry-run), FEE_BPS, FEE_WALLET, OWNER (Safe), CONFIRM_CHAIN_ID (required to broadcast)
import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { createPublicClient, createWalletClient, http, getContractAddress, getAddress, domainSeparator, encodeDeployData, keccak256, toHex } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'

const load = (p) => JSON.parse(readFileSync(new URL(`../${p}`, import.meta.url)))
const need = (k) => { const v = process.env[k]; if (!v) throw new Error(`missing env ${k}`); return v }
const ZERO = '0x0000000000000000000000000000000000000000'
const ORDER_TYPE = 'OrderERC20(uint256 nonce,uint256 expiry,address signerWallet,address signerToken,uint256 signerAmount,uint256 protocolFee,address senderWallet,address senderToken,uint256 senderAmount)'
const json = (x) => JSON.stringify(x, (_, v) => (typeof v === 'bigint' ? v.toString() : v), 2)

export const COMPILER_SETTINGS = load('compiler-settings.json')

/** The fixture must be the verified one (same SHA-256 as recorded by tools/verify-source). */
export function loadVerifiedFixture() {
  const meta = COMPILER_SETTINGS.fixtures.SwapERC20
  const art = load(meta.file)
  const sha = createHash('sha256').update(Buffer.from(art.bytecode.slice(2), 'hex')).digest('hex')
  if (sha !== meta.creationBytecodeSha256) throw new Error(`fixture ${meta.file} SHA-256 ${sha} ≠ compiler-settings.json ${meta.creationBytecodeSha256}: run tools/verify-source`)
  return art
}

export async function readState(pub, abi, swap) {
  const read = (fn) => pub.readContract({ address: swap, abi, functionName: fn })
  return {
    owner: getAddress(await read('owner')),
    protocolFee: await read('protocolFee'),
    protocolFeeLight: await read('protocolFeeLight'),
    protocolFeeWallet: getAddress(await read('protocolFeeWallet')),
    stakingToken: getAddress(await read('stakingToken')),
    bonusMax: await read('bonusMax'),
    bonusScale: await read('bonusScale'),
    domainSeparator: await read('DOMAIN_SEPARATOR'),
    orderTypehash: await read('ORDER_TYPEHASH'),
  }
}

/** Every post-deploy assertion, as a list of human-readable mismatches (empty = OK). `owner` is checked separately. */
export function mismatches(state, { chainId, swap, fee, feeWallet }) {
  // DOMAIN_SEPARATOR is an immutable (chainId + address) baked in at deploy: verify it rather than comparing runtime bytecode.
  const expectedDomain = domainSeparator({ domain: { name: 'SWAP_ERC20', version: '4.3', chainId, verifyingContract: swap } })
  const out = []
  const eq = (k, got, want) => { if (got !== want) out.push(`${k} ${got} ≠ ${want}`) }
  eq('protocolFee', state.protocolFee, fee)
  eq('protocolFeeLight', state.protocolFeeLight, fee)
  eq('protocolFeeWallet', state.protocolFeeWallet, feeWallet)
  eq('stakingToken', state.stakingToken, ZERO)
  eq('bonusMax', state.bonusMax, 0n)
  eq('bonusScale', state.bonusScale, 0n)
  eq('DOMAIN_SEPARATOR', state.domainSeparator, expectedDomain)
  eq('ORDER_TYPEHASH', state.orderTypehash, keccak256(toHex(ORDER_TYPE)))
  return out
}

/**
 * @param opts { rpc, privateKey?, deployer? (dry run only), feeBps, feeWallet, owner, dryRun = false, weth? (ignored: no Wrapper in v1), log }
 */
export async function deploy({ rpc, privateKey, deployer, feeBps, feeWallet, owner, weth, dryRun = false, log = console.log }) {
  const swapArt = loadVerifiedFixture()
  if (weth) log('note: WETH ignored — the Wrapper is excluded from v1 and is not deployed')
  const account = privateKey ? privateKeyToAccount(privateKey) : null
  if (!account && !dryRun) throw new Error('PRIVATE_KEY required (only --dry-run works with DEPLOYER alone)')
  const from = getAddress(account ? account.address : deployer)
  const pub = createPublicClient({ transport: http(rpc) })
  const chainId = await pub.getChainId()
  const chain = { id: chainId, name: `chain-${chainId}`, nativeCurrency: { name: 'ETH', symbol: 'ETH', decimals: 18 }, rpcUrls: { default: { http: [rpc] } } }
  const fee = BigInt(feeBps)
  if (fee <= 0n || fee > 100n) throw new Error('FEE_BPS out of the sane range 1..100 (contract allows up to 9999)')
  owner = getAddress(owner)
  feeWallet = getAddress(feeWallet)
  if (owner === from) throw new Error('OWNER must be the Safe, not the deployer')

  const nonce = await pub.getTransactionCount({ address: from })
  const swap = getContractAddress({ from, nonce: 0n }) // the deterministic address, whatever the current nonce
  const code = await pub.getCode({ address: swap })
  const deployed = !!code && code !== '0x'
  const ctx = { chainId, swap, fee, feeWallet }
  const constructorArgs = [fee, fee, feeWallet, 0n, 0n] // protocolFee, protocolFeeLight, feeWallet, bonusScale = 0, bonusMax = 0

  // ---- decide what to do (read-only)
  let action, existing = null
  if (nonce === 0 && !deployed) action = 'deploy'
  else if (deployed) {
    existing = await readState(pub, swapArt.abi, swap)
    const bad = mismatches(existing, ctx)
    if (bad.length) throw new Error(`deployer nonce is ${nonce}, and the existing deployment at ${swap} does not match: ${bad.join('; ')}`)
    if (existing.owner === owner) action = 'verify'
    else if (existing.owner === from) action = 'transfer'
    else throw new Error(`deployer nonce is ${nonce}, and ${swap} is owned by ${existing.owner}, neither the deployer nor OWNER`)
  } else throw new Error(`deployer nonce is ${nonce}, expected 0 for a cross-chain identical address (no contract at ${swap})`)

  if (dryRun) {
    const plan = { dryRun: true, chainId, deployer: from, nonce, swap, action, owner, feeWallet, protocolFee: fee, compiler: COMPILER_SETTINGS.settings, solc: COMPILER_SETTINGS.solc.version,
      balanceWei: await pub.getBalance({ address: from }) }
    if (action === 'deploy') plan.deployGas = await pub.estimateGas({ account: from, data: encodeDeployData({ abi: swapArt.abi, bytecode: swapArt.bytecode, args: constructorArgs }) })
    if (existing) plan.existing = existing
    log(`dry run: ${action} on chain ${chainId} at ${swap} — nothing signed or sent`)
    return plan
  }

  const wallet = createWalletClient({ account, chain, transport: http(rpc) })
  const wait = async (hash, what) => {
    const rc = await pub.waitForTransactionReceipt({ hash })
    if (rc.status !== 'success') throw new Error(`${what} reverted (${hash})`)
    log(`${what}: ok (gas ${rc.gasUsed})`)
    return rc
  }
  if (action === 'deploy') {
    const rc = await wait(await wallet.deployContract({ abi: swapArt.abi, bytecode: swapArt.bytecode, args: constructorArgs, nonce: 0 }), 'deploy SwapERC20')
    if (getAddress(rc.contractAddress) !== swap) throw new Error(`unexpected address ${rc.contractAddress} (expected ${swap})`)
  }
  if (action === 'deploy' || action === 'transfer') {
    // SwapERC20 uses solady Ownable: transferOwnership is immediate (no accept step)
    await wait(await wallet.writeContract({ address: swap, abi: swapArt.abi, functionName: 'transferOwnership', args: [owner] }), 'SwapERC20.transferOwnership')
  }

  // ---- post-deploy assertions (always)
  const state = await readState(pub, swapArt.abi, swap)
  const bad = mismatches(state, ctx)
  if (state.owner !== owner) bad.push(`owner ${state.owner} ≠ ${owner}`)
  if (bad.length) throw new Error(`post-deploy check failed: ${bad.join('; ')}\n${json(state)}`)
  const { orderTypehash, ...rest } = state
  return { chainId, swap, ...rest, alreadyDeployed: action === 'verify', resumed: action === 'transfer', compiler: COMPILER_SETTINGS.settings }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const dryRun = process.argv.includes('--dry-run') || process.env.DRY_RUN === '1'
  const run = async () => {
    const rpc = need('RPC_URL')
    if (!dryRun) {
      // explicit target chain: a wrong RPC_URL must never broadcast to an unintended network
      const id = await createPublicClient({ transport: http(rpc) }).getChainId()
      if (String(id) !== need('CONFIRM_CHAIN_ID')) throw new Error(`RPC_URL is chain ${id}, CONFIRM_CHAIN_ID is ${process.env.CONFIRM_CHAIN_ID}: refusing to broadcast`)
    }
    return deploy({ rpc, privateKey: process.env.PRIVATE_KEY, deployer: process.env.DEPLOYER, feeBps: need('FEE_BPS'), feeWallet: need('FEE_WALLET'), owner: need('OWNER'), dryRun })
  }
  run().then((r) => console.log(json(r))).catch((e) => { console.error(e.message); process.exit(1) })
}
