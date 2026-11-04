// Post-deploy checklist of a SwapERC20 deployment (read-only):
//   C1 code at the address = the fixture's runtime (creation simulated by eth_call on the same chain; the two immutables,
//      DOMAIN_CHAIN_ID and DOMAIN_SEPARATOR, masked and checked separately)
//   C2 owner = the Safe, and the Safe is a contract
//   C3 protocolFee = FEE_BPS, protocolFeeLight = protocolFee, protocolFeeWallet = FEE_WALLET
//   C4 stakingToken = 0, bonusMax = 0, bonusScale = 0
//   C5 DOMAIN_SEPARATOR = EIP712(SWAP_ERC20, 4.3, chainId, address), DOMAIN_CHAIN_ID = chainId, ORDER_TYPEHASH
//   C6 the address = CREATE(deployer, nonce 0) (same on every chain)
//   node scripts/post-deploy-check.mjs   env: RPC_URL, SWAP (optional: computed from DEPLOYER), DEPLOYER, OWNER, FEE_WALLET, FEE_BPS
import { createPublicClient, http, getAddress, getContractAddress, encodeDeployData, keccak256, toHex, domainSeparator, parseAbi } from 'viem'
import { loadVerifiedFixture, readState, mismatches } from './deploy.js'

const ZERO = '0x0000000000000000000000000000000000000000'
const ORDER_TYPE = 'OrderERC20(uint256 nonce,uint256 expiry,address signerWallet,address signerToken,uint256 signerAmount,uint256 protocolFee,address senderWallet,address senderToken,uint256 senderAmount)'

/** Mask every 32-byte occurrence of `words` in a hex code string. */
const mask = (code, words) => { let c = code.toLowerCase(); for (const w of words) c = c.split(w.slice(2).toLowerCase()).join('00'.repeat(32)); return c }

/** @returns [{ id, item, ok, detail }] */
export async function postDeployCheck({ rpc, swap, deployer, owner, feeWallet, feeBps }) {
  const pub = createPublicClient({ transport: http(rpc) })
  const chainId = await pub.getChainId()
  const art = loadVerifiedFixture()
  deployer = getAddress(deployer)
  const expected = getContractAddress({ from: deployer, nonce: 0n })
  swap = getAddress(swap ?? expected)
  const fee = BigInt(feeBps)
  const out = []
  const add = (id, item, ok, detail = '') => out.push({ id, item, ok: !!ok, detail })
  const code = await pub.getCode({ address: swap })
  add('C6', 'address = CREATE(deployer, nonce 0): identical on every chain', swap === expected, `${swap}${swap === expected ? '' : ' ≠ ' + expected}`)
  if (!code || code === '0x') { add('C1', 'contract deployed', false, 'no code'); return { chainId, swap, items: out } }
  const st = await readState(pub, art.abi, swap)
  const chainWord = toHex(BigInt(chainId), { size: 32 })
  const immutCheck = await pub.readContract({ address: swap, abi: parseAbi(['function DOMAIN_CHAIN_ID() view returns (uint256)']), functionName: 'DOMAIN_CHAIN_ID' })
  // the runtime the fixture produces on this chain (eth_call of the creation code)
  const sim = await pub.call({ account: deployer, data: encodeDeployData({ abi: art.abi, bytecode: art.bytecode, args: [fee, fee, getAddress(feeWallet), 0n, 0n] }) })
  const simSep = domainSeparator({ domain: { name: 'SWAP_ERC20', version: '4.3', chainId, verifyingContract: getContractAddress({ from: deployer, nonce: BigInt(await pub.getTransactionCount({ address: deployer })) }) } })
  const same = mask(code, [st.domainSeparator, chainWord]) === mask(sim.data ?? '0x', [simSep, chainWord])
  add('C1', 'runtime code = fixture (immutables masked)', same && code.length === (sim.data ?? '').length, `${(code.length - 2) / 2} bytes, keccak ${keccak256(code).slice(0, 18)}…`)
  const ownerCode = await pub.getCode({ address: st.owner })
  add('C2', 'owner = Safe (a contract)', st.owner === getAddress(owner) && !!ownerCode && ownerCode !== '0x', `${st.owner}${ownerCode && ownerCode !== '0x' ? ' (contract)' : ' (NO CODE)'}`)
  const bad = mismatches(st, { chainId, swap, fee, feeWallet: getAddress(feeWallet) })
  add('C3', `protocolFee = protocolFeeLight = ${fee}, fee wallet`, st.protocolFee === fee && st.protocolFeeLight === st.protocolFee && st.protocolFeeWallet === getAddress(feeWallet), `${st.protocolFee}/${st.protocolFeeLight}, ${st.protocolFeeWallet}`)
  add('C4', 'staking 0, bonusMax 0, bonusScale 0', st.stakingToken === ZERO && st.bonusMax === 0n && st.bonusScale === 0n, `${st.stakingToken}, ${st.bonusMax}, ${st.bonusScale}`)
  const dom = domainSeparator({ domain: { name: 'SWAP_ERC20', version: '4.3', chainId, verifyingContract: swap } })
  add('C5', 'DOMAIN_SEPARATOR, DOMAIN_CHAIN_ID, ORDER_TYPEHASH', st.domainSeparator === dom && immutCheck === BigInt(chainId) && st.orderTypehash === keccak256(toHex(ORDER_TYPE)) && !bad.some((b) => /DOMAIN|TYPEHASH/.test(b)), `${st.domainSeparator.slice(0, 18)}…, chain ${immutCheck}`)
  return { chainId, swap, items: out }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const e = process.env
  postDeployCheck({ rpc: e.RPC_URL, swap: e.SWAP, deployer: e.DEPLOYER, owner: e.OWNER, feeWallet: e.FEE_WALLET, feeBps: e.FEE_BPS ?? '30' }).then((r) => {
    for (const i of r.items) console.log(`${i.ok ? 'PASS' : 'FAIL'} | ${i.id} ${i.item} | ${i.detail}`)
    const ok = r.items.every((i) => i.ok)
    console.log(`\nchain ${r.chainId}, ${r.swap}: ${ok ? 'all checks passed' : 'CHECKS FAILED'}`)
    process.exit(ok ? 0 : 1)
  }).catch((err) => { console.error(err.message); process.exit(1) })
}
