// Entry point: node dist/index.js [config.json]
import { readFileSync } from 'node:fs'
import { realpathSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { openDb, type Db } from './db.js'
import { Engine } from './engine.js'
import { createServer, type BookServer } from './api.js'
import { parseConfig, toChainCfg, type Config } from './config.js'
import { createLogger, type Logger, type Level } from './log.js'
import { Registry } from './metrics.js'
import type { RequestCounter } from './chain.js'

export { parseConfig, configDoc, CONFIG } from './config.js'
export { ConfigError } from './schema.js'
export { openDb } from './db.js'
export { migrate, MIGRATIONS, LATEST_VERSION, MigrationError } from './migrations.js'
export { Engine } from './engine.js'
export { createServer, clientKeys, rateLimiter } from './api.js'
export { createLogger } from './log.js'
export { Registry } from './metrics.js'
export { inCidr } from './cidr.js'
export { allocate, byAge } from './allocation.js'
export * from './types.js'

export interface StartOptions {
  /** a Logger, or a function receiving each JSON log line (tests pass `() => {}` to silence) */
  log?: Logger | ((line: string) => void)
}
export interface App {
  engine: Engine
  server: BookServer
  db: Db
  counter: RequestCounter
  config: Config
  metrics: Registry
  log: Logger
  stop(): Promise<void>
}

const TICK_BUCKETS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30]
const RPC_BUCKETS = [0, 1, 2, 3, 4, 6, 8, 12, 16, 32, 64, 128]
const HTTP_BUCKETS = [0.0005, 0.001, 0.0025, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5]

export async function start(rawConfig: unknown, { log: logOpt }: StartOptions = {}): Promise<App> {
  const config = parseConfig(rawConfig) // throws ConfigError with every problem listed
  const log: Logger = typeof logOpt === 'function' ? createLogger({ level: config.log.level as Level, sink: logOpt })
    : logOpt ?? createLogger({ level: config.log.level as Level })
  const db = openDb(config.db)
  if (db.migration.applied.length || db.migration.adoptedLegacy) log.info('database migrated', { ...db.migration })

  const metrics = new Registry()
  const rpcTotal = metrics.counter('fondaco_rpc_requests_total', 'JSON-RPC HTTP requests sent, per chain.')
  const counter: RequestCounter = { n: {}, inc(c) { this.n[c] = (this.n[c] || 0) + 1; rpcTotal.inc({ chain: c }) } }
  const ticks = metrics.counter('fondaco_ticks_total', 'Indexing rounds, by kind (idle = no new block, incremental, full sweep).')
  const tickDuration = metrics.histogram('fondaco_tick_duration_seconds', 'Duration of one indexing round.', TICK_BUCKETS)
  const tickRpc = metrics.histogram('fondaco_tick_rpc_requests', 'RPC requests used by one indexing round.', RPC_BUCKETS)
  const tickErrors = metrics.counter('fondaco_tick_errors_total', 'Indexing rounds that failed (the next round retries).')
  const reorgs = metrics.counter('fondaco_reorgs_total', 'Reorgs detected.')
  const rolledBack = metrics.counter('fondaco_reorg_rolled_back_orders_total', 'Order statuses rolled back by reorgs.')
  const filterFallbacks = metrics.counter('fondaco_log_filter_fallback_total', 'Signer-filtered token-log queries rejected by the provider (the round fell back to the unfiltered query).')
  const httpDuration = metrics.histogram('fondaco_http_request_duration_seconds', 'API latency by route and status code (SSE excluded).', HTTP_BUCKETS)
  const sseClients = metrics.gauge('fondaco_sse_clients', 'Open /stream connections.')
  metrics.gauge('fondaco_orders', 'Orders in the database by chain and status.', (set) => { for (const r of db.countByStatus()) set({ chain: r.chain_id, status: r.status }, r.n) })
  const engine = new Engine(Object.entries(config.chains).map(([id, c]) => toChainCfg(id, c)), db, {
    counter,
    hooks: {
      onTick: (e) => {
        ticks.inc({ chain: e.chainId, kind: e.kind })
        tickDuration.observe({ chain: e.chainId, kind: e.kind }, e.ms / 1000)
        tickRpc.observe({ chain: e.chainId, kind: e.kind }, e.rpc)
        if (e.kind !== 'idle') log.debug('tick', { ...e })
      },
      onReorg: (e) => { reorgs.inc({ chain: e.chainId }); rolledBack.inc({ chain: e.chainId }, e.rolledBack); log.warn('reorg', { ...e }) },
      onLogFilterFallback: (e) => { filterFallbacks.inc({ chain: e.chainId }); log.warn('log filter rejected by the provider: unfiltered token logs for the next 10 min', { ...e }) },
    },
  })
  metrics.gauge('fondaco_chain_head_block', 'Last head block seen, per chain.', (set) => { for (const c of engine.chains.values()) if (c.head?.number != null) set({ chain: c.cfg.id }, Number(c.head.number)) })
  metrics.gauge('fondaco_indexed_block', 'Last block indexed, per chain.', (set) => { for (const c of engine.chains.values()) set({ chain: c.cfg.id }, Number(db.getMeta(`last_block:${c.cfg.id}`) ?? 0)) })
  await engine.init()
  const server = createServer(engine, {
    corsOrigin: config.corsOrigin, rate: config.rateLimit, trustProxy: config.trustProxy, maxConcurrentSubmits: config.maxConcurrentSubmits,
    ssePerClient: config.ssePerClient, log,
    metrics: { enabled: config.metrics.enabled, token: config.metrics.token, allow: config.metrics.allow, registry: metrics, httpDuration, sseClients },
  })
  await new Promise<void>((r) => server.listen(config.port, config.host, r))
  const timers: NodeJS.Timeout[] = []
  for (const [id, c] of engine.chains) {
    const every = config.chains[String(id)]?.pollMs ?? 4000
    const loop = () => engine.tick(id).catch((e: Error & { shortMessage?: string }) => { tickErrors.inc({ chain: c.cfg.id }); log.error('tick error', { chain: id, error: e.shortMessage || e.message }) })
    timers.push(setInterval(loop, every))
    void loop()
  }
  const addr = server.address()
  log.info('book listening', { url: `http://${config.host}:${typeof addr === 'object' && addr ? addr.port : config.port}`, chains: [...engine.chains.keys()], metrics: config.metrics.enabled })
  return {
    engine, server, db, counter, config, metrics, log,
    async stop() {
      timers.forEach(clearInterval)
      for (const c of server.sseClients) c.end()
      await new Promise((r) => server.close(r))
      db.raw.close()
    },
  }
}

const isMain = (() => { try { return realpathSync(process.argv[1] ?? '') === realpathSync(fileURLToPath(import.meta.url)) } catch { return false } })()
if (isMain) {
  const file = process.argv[2] || 'config.json'
  start(JSON.parse(readFileSync(file, 'utf8'))).catch((e: Error) => { process.stderr.write(`${e.message}\n`); process.exit(1) })
}
