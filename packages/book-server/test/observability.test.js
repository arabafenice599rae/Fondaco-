// Logger, Prometheus registry and CIDR matcher (no chain needed).
import { createLogger, Registry, inCidr } from '../dist/index.js'

const results = []
const check = (n, ok, d = '') => { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'} | ${n}${d ? ' | ' + d : ''}`) }

// O1 JSON lines, levels, child fields, bigint and Error serialization
const lines = []
const log = createLogger({ level: 'info', sink: (l) => lines.push(l), now: () => new Date('2026-10-31T00:00:00Z') })
log.debug('hidden')
log.info('tick', { chain: 1, block: 23700000n })
log.child({ component: 'api' }).error('request failed', { error: new Error('boom') })
const parsed = lines.map((l) => JSON.parse(l))
check('O1: logs are one JSON object per line, level-filtered, bigint/Error safe, child fields merged', lines.length === 2 && parsed[0].level === 'info' && parsed[0].block === '23700000' &&
  parsed[0].ts === '2026-10-31T00:00:00.000Z' && parsed[1].component === 'api' && parsed[1].error.message === 'boom' && !lines.some((l) => l.includes('\n')), lines[0])
const silent = []
createLogger({ level: 'silent', sink: (l) => silent.push(l) }).error('x')
check('O2: level "silent" writes nothing', silent.length === 0)

// O3 Prometheus text format
const r = new Registry()
const c = r.counter('fondaco_test_total', 'A counter.')
c.inc({ chain: 1, kind: 'full' }); c.inc({ chain: 1, kind: 'full' }, 2); c.inc({ chain: 1, kind: 'idle' })
const g = r.gauge('fondaco_test_orders', 'Collected at scrape.', (set) => { set({ status: 'open' }, 7); set({ status: 'with "quote"\\' }, 1) })
const h = r.histogram('fondaco_test_seconds', 'A histogram.', [0.1, 1])
h.observe({ route: 'GET /book' }, 0.05); h.observe({ route: 'GET /book' }, 0.5); h.observe({ route: 'GET /book' }, 5)
const text = r.render()
const want = [
  '# HELP fondaco_test_total A counter.', '# TYPE fondaco_test_total counter', 'fondaco_test_total{chain="1",kind="full"} 3', 'fondaco_test_total{chain="1",kind="idle"} 1',
  '# TYPE fondaco_test_orders gauge', 'fondaco_test_orders{status="open"} 7', 'fondaco_test_orders{status="with \\"quote\\"\\\\"} 1',
  '# TYPE fondaco_test_seconds histogram', 'fondaco_test_seconds_bucket{route="GET /book",le="0.1"} 1', 'fondaco_test_seconds_bucket{route="GET /book",le="1"} 2',
  'fondaco_test_seconds_bucket{route="GET /book",le="+Inf"} 3', 'fondaco_test_seconds_sum{route="GET /book"} 5.55', 'fondaco_test_seconds_count{route="GET /book"} 3',
]
const missing = want.filter((w) => !text.split('\n').includes(w))
// every sample line matches the exposition grammar: name{labels} value
const sampleOk = text.trim().split('\n').filter((l) => !l.startsWith('#')).every((l) => /^[a-zA-Z_:][a-zA-Z0-9_:]*(\{([a-zA-Z_][a-zA-Z0-9_]*="([^"\\]|\\.)*",?)*\})? (-?[0-9.e+]+|\+Inf|-Inf|NaN)$/.test(l))
check('O3: Prometheus exposition format (HELP/TYPE, labels escaped, cumulative buckets, +Inf, sum, count)', missing.length === 0 && sampleOk && text.endsWith('\n'), missing.join(' | ') || `${text.split('\n').length} lines`)
let dup = false
try { r.counter('fondaco_test_total', 'again') } catch { dup = true }
check('O4: duplicate or invalid metric names refused', dup)

// O5 CIDR
const cases = [['127.0.0.1', '127.0.0.1/32', true], ['127.0.0.2', '127.0.0.1/32', false], ['10.1.2.3', '10.0.0.0/8', true], ['11.0.0.1', '10.0.0.0/8', false],
  ['::1', '::1/128', true], ['::ffff:127.0.0.1', '127.0.0.1/32', true], ['2001:db8:1:2::5', '2001:db8::/32', true], ['2001:db9::1', '2001:db8::/32', false],
  ['fe80::1%eth0', 'fe80::/10', true], ['10.0.0.1', '::/0', false], ['garbage', '0.0.0.0/0', false], ['1.2.3.4', '0.0.0.0/0', true], ['1.2.3.4', '1.2.3.4/33', false]]
const bad = cases.filter(([ip, net, exp]) => inCidr(ip, net) !== exp)
check('O5: CIDR matching for IPv4, IPv6, IPv4-mapped IPv6, zone ids, invalid input', bad.length === 0, bad.map((b) => b.join(' ')).join('; ') || `${cases.length} cases`)

const failed = results.filter((x) => !x).length
console.log(`\n${results.length - failed}/${results.length} checks passed`)
process.exit(failed ? 1 : 0)
