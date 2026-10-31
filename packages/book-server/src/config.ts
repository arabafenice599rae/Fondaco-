// Server configuration: schema with documented defaults (docs/CONFIG.md is generated from it), validation at startup.
import { getAddress, isAddress, type Address } from 'viem'
import { MULTICALL3 } from '@fondaco/contracts'
import { obj, record, int, num, str, bool, list, oneOrMany, optional, validate, type Field, type Infer } from './schema.js'
import type { ChainCfg, TokenCfg } from './types.js'

const address = (doc: string, def?: Address): Field<Address> => {
  const base = str(doc, { what: 'an address (0x + 40 hex)' })
  return { kind: 'address', doc, ...(def ? { default: def } : {}), parse: (v: unknown, path: string, errs: string[]): Address => {
    const s = base.parse(v, path, errs)
    if (s === undefined) return undefined as unknown as Address
    if (!isAddress(s, { strict: false })) { errs.push(`${path}: expected an address (0x + 40 hex), got ${JSON.stringify(s)}`); return undefined as unknown as Address }
    return getAddress(s)
  } }
}
const url = (doc: string) => str(doc, { pattern: /^https?:\/\/\S+$/, what: 'an http(s) URL' })
const uint = (doc: string, o: { default?: string } = {}): Field<string> => {
  const f = str(doc, { pattern: /^\d+$/, what: 'a non-negative integer (number or decimal string)' })
  return { ...f, kind: 'integer (decimal string allowed)', ...(o.default != null ? { default: o.default } : {}),
    parse: (v, path, errs) => f.parse(typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 ? String(v) : v, path, errs) }
}
const cidr = (doc: string) => str(doc, { pattern: /^[0-9a-fA-F:.]+\/\d{1,3}$/, what: 'a CIDR block (e.g. 10.0.0.0/8, ::1/128)' })

export const TOKEN = obj({
  symbol: str('Display symbol.'),
  decimals: int('Token decimals.', { min: 0, max: 36 }),
  min: optional(uint('Minimum order size in base units, for both sides (amount_too_small).')),
}, 'Whitelisted token. No fee-on-transfer or rebasing tokens.')

export const CHAIN = obj({
  rpc: oneOrMany(url('JSON-RPC endpoint.'), 'One RPC URL or a list (automatic failover to the next one).'),
  rpcTimeoutMs: int('Timeout of one RPC request.', { default: 15_000, min: 100 }),
  swap: address('SwapERC20 v5.0.0 address on this chain.'),
  multicall: address('Multicall3 address (same on every major EVM chain).', MULTICALL3),
  startBlock: uint('First block to index (deployment block of the contract). 0 = start from the current head.', { default: '0' }),
  pollMs: int('Interval between two indexing rounds.', { default: 4_000, min: 100 }),
  logChunk: int('Max blocks per eth_getLogs of the swap contract.', { default: 2_000, min: 1 }),
  reorgDepth: int('Blocks rolled back and re-read after a reorg (64 ≈ finality on Ethereum).', { default: 64, min: 1 }),
  signalMaxBlocks: int('A gap longer than this many blocks triggers a full sweep instead of token logs.', { default: 50, min: 1 }),
  logSignerChunk: int('Up to this many live signers, token logs are filtered by the node; above, read unfiltered and filtered here.', { default: 200, min: 1 }),
  fullSweepMs: int('Interval between full verifications of every live order.', { default: 60_000, min: 1_000 }),
  expiryBufferSec: int('Orders expiring within this many seconds are not offered in /book.', { default: 30, min: 0 }),
  minExpirySec: int('Minimum remaining validity at submission (expiry_too_short).', { default: 60, min: 0 }),
  maxExpirySec: int('Maximum validity at submission (expiry_too_long).', { default: 7 * 86_400, min: 1 }),
  maxOpenPerSigner: int('Max live orders per signer and token (too_many_orders).', { default: 200, min: 1 }),
  maxLiveOrders: int('Max live orders on this chain (book_full).', { default: 100_000, min: 1 }),
  maxStalenessMs: int('Fail-closed: if no indexing round has succeeded for this long, GET /book answers 503 stale instead of serving unverified offers.', { default: 120_000, min: 1_000 }),
  tokens: record(address('Token address.'), TOKEN, 'Token whitelist: address → { symbol, decimals, min? }.', { min: 2 }),
}, 'One chain served by the book.')

export const CONFIG = obj({
  port: int('HTTP port (0 = any free port).', { default: 8080, min: 0, max: 65_535 }),
  host: str('Listen address.', { default: '127.0.0.1' }),
  db: str('SQLite file (":memory:" for tests). WAL mode.', { default: 'book.sqlite' }),
  corsOrigin: str('Access-Control-Allow-Origin.', { default: '*' }),
  trustProxy: int('Number of reverse proxies in front; X-Forwarded-For is used only when > 0 (N-th address from the right).', { default: 0, min: 0, max: 10 }),
  maxConcurrentSubmits: int('Parallel POST /orders being processed; beyond: 503 busy.', { default: 8, min: 1 }),
  ssePerClient: int('Max /stream connections per client key.', { default: 4, min: 1 }),
  rateLimit: obj({
    capacity: num('Bucket size (burst) per client key; IPv6 /48 gets 16×.', { default: 60, min: 1 }),
    refillPerSec: num('Tokens refilled per second.', { default: 2, min: 0 }),
  }, 'Token bucket per client (IPv4 address, IPv6 /64, plus a /48 bucket).', { default: 'fields' }),
  log: obj({
    level: str('Minimum level written.', { default: 'info', oneOf: ['debug', 'info', 'warn', 'error', 'silent'] as const }),
  }, 'Structured JSON logs on stdout, one object per line.', { default: 'fields' }),
  metrics: obj({
    enabled: bool('Serve GET /metrics (Prometheus text format).', { default: false }),
    token: optional(str('Bearer token accepted on /metrics (Authorization: Bearer …), from any address.', { pattern: /^\S{16,}$/, what: 'a token of at least 16 characters' })),
    allow: list(cidr('Network allowed without token.'), 'Source networks allowed on /metrics without a token (direct peer address, never X-Forwarded-For).', { default: ['127.0.0.1/32', '::1/128'] }),
  }, 'Prometheus metrics endpoint: off by default; when on, only from `allow` or with `token`.', { default: 'fields' }),
  chains: record(str('Chain id.', { pattern: /^[1-9]\d*$/, what: 'a chain id (positive integer)' }), CHAIN, 'Chains served: chain id → chain settings.', { min: 1 }),
}, 'Book server configuration.')

export type Config = Infer<typeof CONFIG>
export type ChainConfig = Infer<typeof CHAIN>

/** Validate raw configuration (JSON). Throws ConfigError listing every problem with its path. */
export const parseConfig = (raw: unknown): Config => validate(CONFIG, raw)

/** Engine view of one validated chain. */
export function toChainCfg(id: string, c: ChainConfig): ChainCfg {
  const tokens: Record<Address, TokenCfg> = {}
  for (const [a, t] of Object.entries(c.tokens) as [Address, Infer<typeof TOKEN>][]) {
    tokens[a] = { symbol: t.symbol, decimals: t.decimals, ...(t.min != null ? { min: BigInt(t.min) } : {}) }
  }
  return {
    id: Number(id), rpc: c.rpc.length === 1 ? (c.rpc[0] as string) : c.rpc, rpcTimeoutMs: c.rpcTimeoutMs, swap: c.swap, multicall: c.multicall, tokens,
    startBlock: BigInt(c.startBlock), logChunk: BigInt(c.logChunk), reorgDepth: BigInt(c.reorgDepth), signalMaxBlocks: BigInt(c.signalMaxBlocks),
    logSignerChunk: c.logSignerChunk, fullSweepMs: c.fullSweepMs, expiryBufferSec: c.expiryBufferSec, minExpirySec: c.minExpirySec,
    maxExpirySec: c.maxExpirySec, maxOpenPerSigner: c.maxOpenPerSigner, maxLiveOrders: c.maxLiveOrders, maxStalenessMs: c.maxStalenessMs,
  }
}

/** Markdown reference of every key, default and constraint (docs/CONFIG.md). */
export function configDoc(): string {
  const lines = ['# Configurazione del book server', '', 'Generato da `packages/book-server/src/config.ts` (`pnpm --filter @fondaco/book-server docs:config`). Non modificare a mano.', '',
    'Le chiavi sconosciute sono un errore all\'avvio. Tutti gli errori vengono elencati insieme, con il percorso.', '']
  const table = (title: string, shape: Record<string, Field<unknown>>) => {
    lines.push(`## ${title}`, '', '| Chiave | Tipo | Default | Descrizione |', '|---|---|---|---|')
    for (const [k, f] of Object.entries(shape)) {
      const d = f.default === undefined ? (f.optional ? '—' : '**obbligatoria**') : `\`${JSON.stringify(f.default)}\``
      lines.push(`| \`${k}\` | ${f.kind} | ${f.kind === 'object' ? '(vedi sotto)' : d} | ${f.doc} |`)
    }
    lines.push('')
  }
  table('Radice', CONFIG.shape)
  table('`rateLimit`', (CONFIG.shape.rateLimit as unknown as { shape: Record<string, Field<unknown>> }).shape)
  table('`log`', (CONFIG.shape.log as unknown as { shape: Record<string, Field<unknown>> }).shape)
  table('`metrics`', (CONFIG.shape.metrics as unknown as { shape: Record<string, Field<unknown>> }).shape)
  table('`chains.<chainId>`', CHAIN.shape)
  table('`chains.<chainId>.tokens.<address>`', TOKEN.shape)
  return lines.join('\n')
}
