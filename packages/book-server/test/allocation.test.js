// Property-based tests (fast-check) of the funding allocation (pure function used by the engine).
//   A1 never more than min(balance, allowance) is assigned
//   A2 funding order is always oldest first (an order is funded iff it fits in what older funded orders left)
//   A3 the result does not depend on the order the orders (or the events that produced them) arrive in
//   A4 nothing left over could fund an unfunded order (no order is starved by mistake)
import fc from 'fast-check'
import { allocate } from '../dist/index.js'

const results = []
const check = (n, ok, d = '') => { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'} | ${n}${d ? ' | ' + d : ''}`) }
const RUNS = Number(process.env.FC_RUNS || 2000)
const prop = (name, p) => {
  const r = fc.check(p, { numRuns: RUNS, seed: 0x46 })
  check(name, !r.failed, r.failed ? `counterexample ${fc.stringify(r.counterexample)} (seed ${r.seed}, path ${r.counterexamplePath})` : `${r.numRuns} runs`)
}

// orders with possibly equal timestamps (ties broken by seq), amounts from dust to huge
const order = fc.record({ need: fc.bigInt({ min: 1n, max: 10n ** 30n }), createdAt: fc.integer({ min: 0, max: 50 }) })
const book = fc.array(order, { maxLength: 40 }).map((os) => os.map((o, seq) => ({ ...o, seq })))
const funds = fc.record({ balance: fc.bigInt({ min: 0n, max: 10n ** 31n }), allowance: fc.bigInt({ min: 0n, max: 10n ** 31n }) })
const avail = ({ balance, allowance }) => (balance < allowance ? balance : allowance) // as in chain.ts snapshot()

/** Reference model, written from the specification text only. */
function model(orders, available) {
  const sorted = [...orders].sort((a, b) => a.createdAt - b.createdAt || a.seq - b.seq)
  const out = new Map()
  let left = available
  for (const o of sorted) { const ok = o.need <= left; if (ok) left -= o.need; out.set(o.seq, ok) }
  return orders.map((o) => out.get(o.seq))
}

prop('A1: total assigned ≤ min(balance, allowance)', fc.property(book, funds, (os, f) => {
  const got = allocate(os, avail(f))
  return os.reduce((s, o, i) => (got[i] ? s + o.need : s), 0n) <= avail(f)
}))

prop('A2: oldest first — identical to the specification model; every unfunded order exceeded what was left at its turn', fc.property(book, funds, (os, f) => {
  const got = allocate(os, avail(f))
  if (got.some((x, i) => x !== model(os, avail(f))[i])) return false
  const sorted = os.map((o, i) => ({ ...o, i })).sort((a, b) => a.createdAt - b.createdAt || a.seq - b.seq)
  let left = avail(f)
  for (const o of sorted) { if (got[o.i]) left -= o.need; else if (o.need <= left) return false }
  return true
}))

prop('A3: result independent of arrival order (any permutation of the same orders)', fc.property(book, funds, fc.infiniteStream(fc.nat()), (os, f, rnd) => {
  const perm = os.map((o) => ({ o, k: rnd.next().value })).sort((a, b) => a.k - b.k).map((x) => x.o)
  const a = allocate(os, avail(f)), b = allocate(perm, avail(f))
  const byseq = (list, res) => new Map(list.map((o, i) => [o.seq, res[i]]))
  const ma = byseq(os, a), mb = byseq(perm, b)
  return os.every((o) => ma.get(o.seq) === mb.get(o.seq))
}))

prop('A4: whatever is left over is smaller than every unfunded order', fc.property(book, funds, (os, f) => {
  const got = allocate(os, avail(f))
  const left = avail(f) - os.reduce((s, o, i) => (got[i] ? s + o.need : s), 0n)
  return os.every((o, i) => got[i] || o.need > left)
}))

// fixed examples documenting the semantics (skip-and-continue, ties)
const ex = allocate([{ need: 5n, createdAt: 1, seq: 0 }, { need: 10n, createdAt: 2, seq: 1 }, { need: 3n, createdAt: 3, seq: 2 }], 9n)
const tie = allocate([{ need: 6n, createdAt: 1, seq: 1 }, { need: 6n, createdAt: 1, seq: 0 }], 6n)
check('A5: examples — an order that does not fit is skipped and a younger, smaller one is still funded; equal timestamps → insertion order',
  ex.join() === 'true,false,true' && tie.join() === 'false,true', `${ex} / ${tie}`)

const failed = results.filter((x) => !x).length
console.log(`\n${results.length - failed}/${results.length} checks passed`)
process.exit(failed ? 1 : 0)
