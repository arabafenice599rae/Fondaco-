// Real-mainnet cost of the incremental round's token-log query, unfiltered vs filtered by signer (logSignerChunk trade-off).
// Uses MAINNET_RPC_URL (read-only). Signers = up to 1 000 addresses really active in a recent range (worst case for filtering).
import { loadEnv } from '@fondaco/testkit/env'
const RPC = loadEnv().MAINNET_RPC_URL
const out = []
const toks = ['0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2', '0xdAC17F958D2ee523a2206206994597C13D831ec7']
const T = ['0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef', '0x8c5be1e5ebec7d5bd14f71427d1e84f3dd0314c0f7b2291e5b200ac8c7c3b925', '0xe1fffcc4923d04b559f4d29a8bfc6cda04eb5b0d3c460751c2402c5c5cc9109c', '0x7fcf532c15f0a6db0bd6d0e038bea71d30d808c7d98cb3bf7268a95bf5081b65']
const call = async (params) => { const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_getLogs', params: [params] }); const t = performance.now(); const r = await fetch(RPC, { method: 'POST', headers: { 'content-type': 'application/json' }, body }); const txt = await r.text(); const j = JSON.parse(txt); return { ms: Math.round(performance.now() - t), reqKB: +(body.length / 1024).toFixed(1), resKB: +(txt.length / 1024).toFixed(1), logs: j.result?.length, error: j.error?.message } }
const from = '0x1699ad7'
// 1000 real senders seen in a recent range, as topic list (signer-filtered query like the engine's)

const r0 = await fetch(RPC, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_getLogs', params: [{ address: toks, fromBlock: '0x1699a00', toBlock: '0x1699a0a', topics: [T] }] }) }).then((r) => r.json())
const senders = [...new Set(r0.result.map((l) => l.topics[1]).filter(Boolean))].slice(0, 1000)
for (const blocks of [1, 5]) {
  const to = '0x' + (parseInt(from, 16) + blocks - 1).toString(16)
  out.push({ blocks, unfiltered: await call({ address: toks, fromBlock: from, toBlock: to, topics: [T] }), [`filtered_${senders.length}_signers`]: await call({ address: toks, fromBlock: from, toBlock: to, topics: [T, senders] }), filtered_200_signers: await call({ address: toks, fromBlock: from, toBlock: to, topics: [T, senders.slice(0, 200)] }) })
}
console.log(JSON.stringify(out))
