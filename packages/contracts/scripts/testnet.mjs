// Testnet deployment of SwapERC20 v4.3 on Sepolia and Base Sepolia — PREPARATION ONLY: nothing here broadcasts to a testnet.
//
//   node scripts/testnet.mjs plan        read-only: for each network the deployer's nonce (must be 0 on both), the address
//                                        CREATE(deployer, 0) (identical on both), the exact transactions and their cost at
//                                        the current gas price (Base: + L1 data fee from the GasPriceOracle predeploy)
//   node scripts/testnet.mjs rehearse    the real deploy script + post-deploy checklist + a test fill, on LOCAL anvil forks
//                                        of both testnets, with one fresh deployer key (same address on both): measures gas
//
// The actual deploy (after explicit confirmation) is, per network:
//   RPC_URL=… PRIVATE_KEY=… CONFIRM_CHAIN_ID=… FEE_BPS=30 FEE_WALLET=… OWNER=<Safe> node scripts/deploy.js
//   RPC_URL=… DEPLOYER=… OWNER=… FEE_WALLET=… FEE_BPS=30 node scripts/post-deploy-check.mjs
//   RPC_URL=… SWAP=… SIGNER_KEY=… TAKER_KEY=… FEE_WALLET=… node scripts/test-fill.mjs <sepolia|baseSepolia>
// env for plan: DEPLOYER (address of the dedicated key), OWNER_SEPOLIA, OWNER_BASE_SEPOLIA (test Safes), FEE_WALLET;
// SEPOLIA_RPC_URL / BASE_SEPOLIA_RPC_URL optional (public defaults in testnets.json).
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { createPublicClient, createTestClient, http, getAddress, getContractAddress, encodeDeployData, encodeFunctionData, parseAbi, formatEther, keccak256, encodeAbiParameters, toHex } from 'viem'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import { deploy, loadVerifiedFixture } from './deploy.js'
import { postDeployCheck } from './post-deploy-check.mjs'
import { runTestFill } from './test-fill.mjs'

const NETS = JSON.parse(readFileSync(new URL('./testnets.json', import.meta.url)))
const ORACLE = '0x420000000000000000000000000000000000000F' // OP Stack GasPriceOracle (Base)
const ORACLE_ABI = parseAbi(['function getL1Fee(bytes) view returns (uint256)'])
const json = (x) => JSON.stringify(x, (_, v) => (typeof v === 'bigint' ? v.toString() : v), 2)
const rpcOf = (n) => process.env[n.rpcEnv] || n.defaultRpc
// gas of the two non-deploy transactions and of the test fill, measured by `rehearse` (reports/testnet-rehearsal.json)
const MEASURED = (() => { try { return JSON.parse(readFileSync(new URL('../../../reports/testnet-rehearsal.json', import.meta.url))) } catch { return null } })()

async function plan() {
  const e = process.env
  const deployer = e.DEPLOYER ? getAddress(e.DEPLOYER) : privateKeyToAccount(generatePrivateKey()).address
  const art = loadVerifiedFixture()
  const out = { deployer, deployerProvided: !!e.DEPLOYER, networks: [] }
  for (const [key, n] of Object.entries(NETS).filter(([k]) => !k.startsWith('$'))) {
    const pub = createPublicClient({ transport: http(rpcOf(n)) })
    const chainId = await pub.getChainId()
    if (chainId !== n.chainId) throw new Error(`${n.name}: RPC is chain ${chainId}`)
    const owner = e[key === 'sepolia' ? 'OWNER_SEPOLIA' : 'OWNER_BASE_SEPOLIA'] ?? null
    const feeWallet = e.FEE_WALLET ? getAddress(e.FEE_WALLET) : deployer
    const data = encodeDeployData({ abi: art.abi, bytecode: art.bytecode, args: [30n, 30n, feeWallet, 0n, 0n] })
    const [nonce, gasPrice, deployGas] = await Promise.all([pub.getTransactionCount({ address: deployer }), pub.getGasPrice(), pub.estimateGas({ account: deployer, data })])
    const transferGas = BigInt(MEASURED?.gas?.transferOwnership ?? 30_000)
    // a public node estimating for an unfunded account may return a fallback limit: the gas measured by `rehearse`
    // (same bytecode, same EVM) is the reference, +20 %; the node's estimate is reported next to it
    const deployRef = MEASURED?.gas?.deploy ? (BigInt(MEASURED.gas.deploy) * 12n) / 10n : deployGas
    const stress = key === 'baseSepolia' ? 100_000_000n : 30_000_000_000n // 0.1 gwei on Base Sepolia, 30 gwei on Sepolia
    const l1 = key === 'baseSepolia' ? await pub.readContract({ address: ORACLE, abi: ORACLE_ABI, functionName: 'getL1Fee', args: [data] }) : 0n
    const l1t = key === 'baseSepolia' ? await pub.readContract({ address: ORACLE, abi: ORACLE_ABI, functionName: 'getL1Fee', args: [encodeFunctionData({ abi: art.abi, functionName: 'transferOwnership', args: [owner ?? deployer] })] }) : 0n
    const cost = deployRef * gasPrice + l1 + transferGas * gasPrice + l1t, costStress = (deployRef + transferGas) * stress + l1 + l1t
    const swap = getContractAddress({ from: deployer, nonce: 0n })
    out.networks.push({ network: n.name, chainId, nonce, nonceZero: nonce === 0, swap, owner, gasPriceWei: gasPrice,
      transactions: [
        { n: 0, from: deployer, nonce: 0, what: 'deploy SwapERC20 v4.3 (fixture, args 30, 30, FEE_WALLET, 0, 0)', to: null, gas: deployRef, gasMeasured: MEASURED?.gas?.deploy ?? null, gasNodeEstimate: deployGas, l1FeeWei: l1 },
        { n: 1, from: deployer, nonce: 1, what: `SwapERC20(${swap}).transferOwnership(${owner ?? 'OWNER Safe — to provide'})`, to: swap, gas: transferGas, l1FeeWei: l1t },
      ],
      costWei: cost, costEth: formatEther(cost), stressGasPriceWei: stress, costAtStressEth: formatEther(costStress),
      testFill: MEASURED?.gas?.testFill ? { transactions: ['signer WETH.deposit', 'signer WETH.approve', 'taker USDC.approve', 'taker swapAnySender'], gas: MEASURED.gas.testFill.map(String), costEth: formatEther(MEASURED.gas.testFill.reduce((s, g) => s + BigInt(g), 0n) * gasPrice) } : null })
  }
  out.sameAddress = new Set(out.networks.map((x) => x.swap)).size === 1
  return out
}

function anvilFork(url) {
  return new Promise((res, rej) => {
    const port = 18000 + Math.floor(Math.random() * 2000)
    const bin = process.env.ANVIL_BIN || (process.env.HOME + '/.foundry/bin/anvil')
    const p = spawn(require_anvil(bin), ['--fork-url', url, '--port', String(port), '--silent', '--retries', '10', '--timeout', '60000'], { stdio: 'ignore' })
    const rpc = `http://127.0.0.1:${port}`
    const t0 = Date.now()
    const poll = async () => { try { await createPublicClient({ transport: http(rpc) }).getChainId(); res({ rpc, stop: () => p.kill() }) } catch { if (Date.now() - t0 > 60_000) rej(new Error('anvil fork did not start')); else setTimeout(poll, 300) } }
    poll()
  })
}
function require_anvil(bin) { for (const b of [bin, '/opt/tools/bin/anvil', 'anvil']) { try { readFileSync(b); return b } catch {} } return 'anvil' }

async function rehearse() {
  const deployerKey = generatePrivateKey(), deployer = privateKeyToAccount(deployerKey).address
  const result = { deployer, networks: [], gas: {} }
  for (const [key, n] of Object.entries(NETS).filter(([k]) => !k.startsWith('$'))) {
    const fork = await anvilFork(rpcOf(n))
    try {
      const pub = createPublicClient({ transport: http(fork.rpc) })
      const test = createTestClient({ mode: 'anvil', transport: http(fork.rpc) })
      const safe = privateKeyToAccount(generatePrivateKey()).address, feeWallet = privateKeyToAccount(generatePrivateKey()).address
      await test.setBalance({ address: deployer, value: 10n ** 18n })
      await test.setCode({ address: safe, bytecode: '0x00' }) // stands in for the test Safe (a contract)
      const logs = []
      const dep = await deploy({ rpc: fork.rpc, privateKey: deployerKey, feeBps: '30', feeWallet, owner: safe, log: (m) => logs.push(m) })
      const gasOf = (re) => Number((logs.find((l) => re.test(l)) ?? '').match(/gas (\d+)/)?.[1] ?? 0)
      const chk = await postDeployCheck({ rpc: fork.rpc, deployer, owner: safe, feeWallet, feeBps: '30' })
      // test fill: fresh signer (ETH → WETH) and taker (USDC written into the token's balance slot on the fork)
      const sk = generatePrivateKey(), tk = generatePrivateKey(), sA = privateKeyToAccount(sk).address, tA = privateKeyToAccount(tk).address
      await test.setBalance({ address: sA, value: 10n ** 18n }); await test.setBalance({ address: tA, value: 10n ** 18n })
      let slotOk = false
      for (const slot of [9n, 0n, 1n, 2n, 3n, 51n]) {
        await test.setStorageAt({ address: n.usdc, index: keccak256(encodeAbiParameters([{ type: 'address' }, { type: 'uint256' }], [tA, slot])), value: toHex(10n ** 8n, { size: 32 }) })
        if ((await pub.readContract({ address: n.usdc, abi: parseAbi(['function balanceOf(address) view returns (uint256)']), functionName: 'balanceOf', args: [tA] })) === 10n ** 8n) { slotOk = true; break }
      }
      if (!slotOk) throw new Error(`${n.name}: could not give test USDC to the taker on the fork`)
      const fill = await runTestFill({ net: key, rpc: fork.rpc, swap: dep.swap, signerKey: sk, takerKey: tk, feeWallet, log: () => {} })
      result.gas.deploy = gasOf(/deploy SwapERC20/); result.gas.transferOwnership = gasOf(/transferOwnership/); result.gas.testFill = fill.gasUsed.map(String)
      result.networks.push({ network: n.name, chainId: dep.chainId, swap: dep.swap, owner: dep.owner, checks: chk.items, testFill: { ok: fill.ok, deltas: fill.deltas, fee: fill.fee } })
    } finally { fork.stop() }
  }
  result.sameAddress = new Set(result.networks.map((x) => x.swap)).size === 1
  result.allChecks = result.networks.every((x) => x.checks.every((c) => c.ok) && x.testFill.ok)
  return result
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const mode = process.argv[2] ?? 'plan'
  mkdirSync(new URL('../../../reports/', import.meta.url), { recursive: true })
  const f = mode === 'rehearse' ? rehearse : mode === 'plan' ? plan : null
  if (!f) { console.error('usage: testnet.mjs plan|rehearse'); process.exit(2) }
  f().then((r) => {
    writeFileSync(new URL(`../../../reports/testnet-${mode === 'rehearse' ? 'rehearsal' : 'plan'}.json`, import.meta.url), json(r))
    console.log(json(r))
    process.exit(mode === 'rehearse' ? (r.allChecks && r.sameAddress ? 0 : 1) : 0)
  }).catch((e) => { console.error(e.stack || e.message); process.exit(1) })
}
