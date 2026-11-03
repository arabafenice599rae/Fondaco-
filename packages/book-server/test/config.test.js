// Configuration schema (no chain needed): defaults, unknown keys, readable aggregated errors, normalization, docs in sync.
import { readFileSync } from 'node:fs'
import { parseConfig, configDoc, ConfigError, start } from '../dist/index.js'

const results = []
const check = (n, ok, d = '') => { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'} | ${n}${d ? ' | ' + d : ''}`) }
const SWAP = '0x1111111111111111111111111111111111111111'
const USDC = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', WETH = '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2'
const minimal = (chain = {}, top = {}) => ({ ...top, chains: { 1: { rpc: 'http://127.0.0.1:8545', swap: SWAP, tokens: { [USDC]: { symbol: 'USDC', decimals: 6 }, [WETH]: { symbol: 'WETH', decimals: 18 } }, ...chain } } })
const errorsOf = (raw) => { try { parseConfig(raw); return [] } catch (e) { return e instanceof ConfigError ? e.errors : [`not a ConfigError: ${e.message}`] } }

// C1 defaults = the reference engine's defaults
const c = parseConfig(minimal())
const ch = c.chains[1]
const expected = { rpcTimeoutMs: 15000, pollMs: 4000, logChunk: 2000, reorgDepth: 64, signalMaxBlocks: 50, logSignerChunk: 1000, /* reference 200; 1000 confirmed (A-07, docs/LOAD.md) */ fullSweepMs: 60000, expiryBufferSec: 30,
  minExpirySec: 60, maxExpirySec: 604800, maxOpenPerSigner: 200, maxLiveOrders: 100000, startBlock: '0', multicall: '0xcA11bde05977b3631167028862bE2a173976CA11' }
const top = { port: 8080, host: '127.0.0.1', db: 'book.sqlite', corsOrigin: '*', trustProxy: 0, maxConcurrentSubmits: 8, ssePerClient: 4 }
const diff = [...Object.entries(expected).filter(([k, v]) => ch[k] !== v), ...Object.entries(top).filter(([k, v]) => c[k] !== v)].map(([k]) => k)
check('C1: defaults filled and equal to the reference server defaults (except logSignerChunk 1000, A-07)', diff.length === 0 && c.rateLimit.capacity === 60 && c.rateLimit.refillPerSec === 2 &&
  c.log.level === 'info' && c.metrics.enabled === false && c.metrics.allow.join() === '127.0.0.1/32,::1/128', diff.join(',') || 'all equal')

// C2 unknown keys are rejected with a readable error and a suggestion
const e2 = errorsOf(minimal({ confirmations: 0, pollMS: 1000 }, { metric: {} }))
check('C2: unknown keys rejected (confirmations removed; typos get "did you mean")',
  e2.some((x) => x === 'config.chains.1.confirmations: unknown key') && e2.some((x) => x.includes('config.chains.1.pollMS: unknown key (did you mean "pollMs"?)')) &&
  e2.some((x) => x.includes('config.metric: unknown key (did you mean "metrics"?)')), e2.join(' / '))

// C3 every problem in one error, with path and expectation
const e3 = errorsOf({ port: -1, chains: { 1: { rpc: 'ftp://x', tokens: { '0x12': { symbol: 'X', decimals: 6 } }, maxLiveOrders: 'many' }, abc: {} } })
const want3 = ['config.port: expected an integer ≥ 0 ≤ 65535, got -1', 'config.chains.1.rpc: expected an http(s) URL, got "ftp://x"', 'config.chains.1.swap: required',
  'config.chains.1.maxLiveOrders: expected an integer ≥ 1, got "many"', 'config.chains.1.tokens key "0x12": expected an address', 'config.chains.1.tokens: at least 2 entry required',
  'config.chains key "abc": expected a chain id']
check('C3: all errors collected at once, each with its path and what was expected', want3.every((w) => e3.some((x) => x.startsWith(w))), `${e3.length} errors`)
let msg3 = ''
try { parseConfig({ chains: {} }) } catch (e) { msg3 = e.message }
check('C3b: error message is readable as a whole', msg3.startsWith('invalid configuration:\n  - config.chains: at least 1 entry required'), JSON.stringify(msg3.slice(0, 80)))

// C4 normalization
const c4 = parseConfig(minimal({ rpc: ['http://a.example', 'https://b.example'], startBlock: 123, tokens: { [USDC.toLowerCase()]: { symbol: 'USDC', decimals: 6, min: 1000000 }, [WETH]: { symbol: 'WETH', decimals: 18 } } }, { rateLimit: undefined }))
const t4 = c4.chains[1].tokens
check('C4: rpc list kept, token addresses checksummed, numbers and decimal strings accepted, undefined = absent',
  c4.chains[1].rpc.length === 2 && t4[USDC]?.min === '1000000' && c4.chains[1].startBlock === '123' && c4.rateLimit.capacity === 60 && parseConfig(minimal({ rpc: 'http://x.example' })).chains[1].rpc.length === 1)

// C5 metrics and log constraints
const e5 = errorsOf(minimal({}, { metrics: { enabled: true, token: 'short', allow: ['10.0.0.0/8', 'nope'] }, log: { level: 'loud' } }))
check('C5: metrics token ≥ 16 chars, CIDR syntax and log level validated', e5.some((x) => x.startsWith('config.metrics.token: expected a token of at least 16')) &&
  e5.some((x) => x.startsWith('config.metrics.allow[1]: expected a CIDR')) && e5.some((x) => x.startsWith('config.log.level: expected one of debug, info, warn, error, silent')), e5.join(' / '))

// C6 example config and docs
// the template keeps a placeholder for the not-yet-deployed contract: it must be the only thing to fill in
const exampleText = readFileSync(new URL('../config.example.json', import.meta.url), 'utf8')
const exErr = errorsOf(JSON.parse(exampleText))
const example = JSON.parse(exampleText.replaceAll('0xYOUR_SWAPERC20_ADDRESS', SWAP))
check('C6: config.example.json is valid once the swap placeholder is filled (and invalid until then)', errorsOf(example).length === 0 && exErr.length === 2 && exErr.every((x) => x.includes('.swap: expected an address')), errorsOf(example).join(' / '))
const doc = readFileSync(new URL('../../../docs/CONFIG.md', import.meta.url), 'utf8')
check('C7: docs/CONFIG.md generated from the schema is up to date, every key documented with its default', doc === configDoc() + '\n' && doc.includes('| `fullSweepMs` | integer ≥ 1000 | `60000` |') && doc.includes('| `swap` | address | **obbligatoria** |'))

// C8 start() validates before touching the database or the network
let e8 = null
try { await start(minimal({ confirmations: 0 }, { db: '/nonexistent/dir/x.sqlite' }), { log: () => {} }) } catch (e) { e8 = e }
check('C8: start() refuses an invalid configuration before opening the DB or any RPC', e8 instanceof ConfigError && e8.errors.length === 1, e8?.message.split('\n')[1])

const failed = results.filter((x) => !x).length
console.log(`\n${results.length - failed}/${results.length} checks passed`)
process.exit(failed ? 1 : 0)
