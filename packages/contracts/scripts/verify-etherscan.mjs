// Source verification of the testnet SwapERC20 on Etherscan (Sepolia) and Basescan (Base Sepolia) through the Etherscan v2
// API: one key for both. The standard-JSON input is taken from Sourcify, where the contract is already an exact match, and
// checked against the pinned compiler settings before anything is sent. PREPARED, NOT RUN: it needs ETHERSCAN_API_KEY
// (in the local .env) and --confirm.
//   node scripts/verify-etherscan.mjs <sepolia|baseSepolia|all>            dry run: builds and checks the request, sends nothing
//   ETHERSCAN_API_KEY=… node scripts/verify-etherscan.mjs all --confirm     submits and waits for the result
import { encodeAbiParameters } from 'viem'
import { readFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const settings = JSON.parse(readFileSync(resolve(HERE, '../compiler-settings.json'), 'utf8'))
const SWAP = '0xf86E2c4789F45A8a7AAA2CA98379716070B80131'
const SAFE = '0xc5ec52f78D049760c41c6223ECC8755B64371F31' // owner and fee wallet on both networks
const NETS = { sepolia: 11155111, baseSepolia: 84532 }
const [which = 'all'] = process.argv.slice(2).filter((a) => !a.startsWith('--'))
const CONFIRM = process.argv.includes('--confirm')
const key = process.env.ETHERSCAN_API_KEY
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function one(name, chainId) {
  const s = await (await fetch(`https://sourcify.dev/server/v2/contract/${chainId}/${SWAP}?fields=compilation,stdJsonInput`)).json()
  if (s.match !== 'exact_match') throw new Error(`${name}: Sourcify match is ${s.match}, not exact_match`)
  const c = s.compilation, cs = c.compilerSettings
  const okSettings = c.compilerVersion === '0.8.23+commit.f704f362' && cs.evmVersion === 'paris' && cs.optimizer?.enabled === true && cs.optimizer?.runs === 999999 && c.fullyQualifiedName === 'contracts/SwapERC20.sol:SwapERC20'
  if (!okSettings) throw new Error(`${name}: compiler settings differ from compiler-settings.json (${JSON.stringify(c)})`)
  if (settings.evmVersion && settings.evmVersion !== cs.evmVersion) throw new Error(`${name}: evmVersion differs`)
  // constructor (_protocolFee, _protocolFeeLight, _protocolFeeWallet, _bonusScale, _bonusMax) = (30, 30, Safe, 0, 0), as deploy.js
  const args = encodeAbiParameters([{ type: 'uint256' }, { type: 'uint256' }, { type: 'address' }, { type: 'uint256' }, { type: 'uint256' }], [30n, 30n, SAFE, 0n, 0n]).slice(2)
  const body = new URLSearchParams({ module: 'contract', action: 'verifysourcecode', contractaddress: SWAP, sourceCode: JSON.stringify(s.stdJsonInput), codeformat: 'solidity-standard-json-input', contractname: c.fullyQualifiedName, compilerversion: 'v' + c.compilerVersion, constructorArguements: args })
  console.log(`${name} (${chainId}): request ready — ${Object.keys(s.stdJsonInput.sources).length} sources, ${c.fullyQualifiedName}, v${c.compilerVersion}, constructor args ${args.length / 2} bytes`)
  if (!CONFIRM) return
  if (!key) throw new Error('ETHERSCAN_API_KEY is not set')
  const api = `https://api.etherscan.io/v2/api?chainid=${chainId}`
  const sub = await (await fetch(`${api}&apikey=${key}`, { method: 'POST', body })).json()
  if (sub.status !== '1') { console.log(`${name}: submit → ${sub.result}`); return }
  for (let i = 0; i < 20; i++) {
    await sleep(5000)
    const st = await (await fetch(`${api}&module=contract&action=checkverifystatus&guid=${sub.result}&apikey=${key}`)).json()
    if (!/pending/i.test(st.result)) { console.log(`${name}: ${st.result}`); return }
  }
  console.log(`${name}: still pending, guid ${sub.result}`)
}

for (const [name, id] of Object.entries(NETS)) if (which === 'all' || which === name) await one(name, id)
