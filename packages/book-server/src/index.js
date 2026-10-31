// Entry point: node src/index.js [config.json]
import { readFileSync } from 'node:fs'
import { openDb } from './db.js'
import { Engine } from './engine.js'
import { createServer } from './api.js'

export async function start(config, { log = console.log } = {}) {
  const db = openDb(config.db || 'book.sqlite')
  const counter = { n: {}, inc(c) { this.n[c] = (this.n[c] || 0) + 1 } }
  const engine = new Engine(config, db, { counter })
  await engine.init()
  const server = createServer(engine, { corsOrigin: config.corsOrigin || '*', rate: config.rateLimit, trustProxy: Number(config.trustProxy || 0), maxConcurrentSubmits: config.maxConcurrentSubmits, ssePerClient: config.ssePerClient })
  await new Promise((r) => server.listen(config.port ?? 8080, config.host || '127.0.0.1', r))
  const timers = []
  for (const [id, c] of engine.chains) {
    const every = Number(config.chains[id].pollMs ?? 4000)
    const loop = () => engine.tick(id).catch((e) => log(`[chain ${id}] tick error: ${e.shortMessage || e.message}`))
    timers.push(setInterval(loop, every))
    loop()
  }
  log(`book listening on http://${config.host || '127.0.0.1'}:${server.address().port}`)
  return {
    engine, server, db, counter,
    async stop() {
      timers.forEach(clearInterval)
      for (const c of server.sseClients) c.end()
      await new Promise((r) => server.close(r))
      db.raw.close()
    },
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const file = process.argv[2] || 'config.json'
  start(JSON.parse(readFileSync(file, 'utf8'))).catch((e) => { console.error(e); process.exit(1) })
}
