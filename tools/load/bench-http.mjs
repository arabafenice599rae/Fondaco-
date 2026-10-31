// Closed-loop HTTP load generator, run as a SEPARATE process (never shares the server's event loop).
//   node bench-http.mjs <url> <seconds> <connections> [header:value ...]
// Prints one JSON line: requests, rps, status counts, latency percentiles in ms (exact, from every sample).
import http from 'node:http'

const [url, secs = '10', conns = '20', ...hdrs] = process.argv.slice(2)
const headers = Object.fromEntries(hdrs.map((h) => [h.slice(0, h.indexOf(':')), h.slice(h.indexOf(':') + 1)]))
const agent = new http.Agent({ keepAlive: true, maxSockets: Number(conns) })
const u = new URL(url)
const lat = [], codes = {}
let bytes = 0
const end = Date.now() + Number(secs) * 1000
const one = () => new Promise((resolve) => {
  const t0 = process.hrtime.bigint()
  const req = http.request({ host: u.hostname, port: u.port, path: u.pathname + u.search, agent, headers }, (res) => {
    res.on('data', (c) => { bytes += c.length })
    res.on('end', () => { lat.push(Number(process.hrtime.bigint() - t0) / 1e6); codes[res.statusCode] = (codes[res.statusCode] || 0) + 1; resolve() })
  })
  req.on('error', () => { codes.error = (codes.error || 0) + 1; resolve() })
  req.end()
})
const worker = async () => { while (Date.now() < end) await one() }
const t0 = Date.now()
await Promise.all(Array.from({ length: Number(conns) }, worker))
const dur = (Date.now() - t0) / 1000
lat.sort((a, b) => a - b)
const q = (p) => (lat.length ? +lat[Math.min(lat.length - 1, Math.floor((p / 100) * lat.length))].toFixed(2) : null)
console.log(JSON.stringify({ url: u.pathname + u.search.slice(0, 60), seconds: +dur.toFixed(1), connections: Number(conns), requests: lat.length, rps: Math.round(lat.length / dur),
  codes, bytesPerResponse: lat.length ? Math.round(bytes / lat.length) : 0, ms: { p50: q(50), p95: q(95), p99: q(99), max: q(100) } }))
agent.destroy()
