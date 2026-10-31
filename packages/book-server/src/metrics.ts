// In-house metrics registry rendered in the Prometheus text exposition format (version 0.0.4). No dependency.
type Labels = Record<string, string | number>
const esc = (v: string) => v.replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/"/g, '\\"')
const key = (l: Labels) => JSON.stringify(Object.keys(l).sort().map((k) => [k, String(l[k])]))
const fmt = (l: Labels, extra: Labels = {}) => {
  const all = { ...l, ...extra }
  const ks = Object.keys(all)
  return ks.length ? `{${ks.map((k) => `${k}="${esc(String(all[k]))}"`).join(',')}}` : ''
}
const num = (n: number) => (Number.isFinite(n) ? String(n) : n > 0 ? '+Inf' : n < 0 ? '-Inf' : 'NaN')

interface Metric { name: string; help: string; type: 'counter' | 'gauge' | 'histogram'; render(): string[] }

export class Counter implements Metric {
  readonly type = 'counter' as const
  private v = new Map<string, { l: Labels; n: number }>()
  constructor(readonly name: string, readonly help: string) {}
  inc(l: Labels = {}, by = 1) { const k = key(l); const e = this.v.get(k); if (e) e.n += by; else this.v.set(k, { l, n: by }) }
  get(l: Labels = {}) { return this.v.get(key(l))?.n ?? 0 }
  render() { return [...this.v.values()].map((e) => `${this.name}${fmt(e.l)} ${num(e.n)}`) }
}

export class Gauge implements Metric {
  readonly type = 'gauge' as const
  private v = new Map<string, { l: Labels; n: number }>()
  /** @param collect optional: recompute the values at scrape time (e.g. orders per status from the DB) */
  constructor(readonly name: string, readonly help: string, private readonly collect?: (set: (l: Labels, n: number) => void) => void) {}
  set(l: Labels, n: number) { this.v.set(key(l), { l, n }) }
  get(l: Labels = {}) { return this.v.get(key(l))?.n }
  render() {
    if (this.collect) { this.v.clear(); this.collect((l, n) => this.set(l, n)) }
    return [...this.v.values()].map((e) => `${this.name}${fmt(e.l)} ${num(e.n)}`)
  }
}

export class Histogram implements Metric {
  readonly type = 'histogram' as const
  private v = new Map<string, { l: Labels; counts: number[]; sum: number; count: number }>()
  constructor(readonly name: string, readonly help: string, readonly buckets: number[]) { this.buckets = [...buckets].sort((a, b) => a - b) }
  observe(l: Labels, x: number) {
    const k = key(l)
    let e = this.v.get(k)
    if (!e) { e = { l, counts: this.buckets.map(() => 0), sum: 0, count: 0 }; this.v.set(k, e) }
    this.buckets.forEach((b, i) => { if (x <= b) (e as { counts: number[] }).counts[i]! += 1 })
    e.sum += x
    e.count++
  }
  /** Observed values for `l` (count, sum) — tests and quantile estimates. */
  stats(l: Labels = {}) { const e = this.v.get(key(l)); return e ? { count: e.count, sum: e.sum, buckets: this.buckets.map((b, i) => [b, e.counts[i] as number] as const) } : null }
  render() {
    const out: string[] = []
    for (const e of this.v.values()) {
      this.buckets.forEach((b, i) => out.push(`${this.name}_bucket${fmt(e.l, { le: num(b) })} ${e.counts[i]}`))
      out.push(`${this.name}_bucket${fmt(e.l, { le: '+Inf' })} ${e.count}`, `${this.name}_sum${fmt(e.l)} ${num(e.sum)}`, `${this.name}_count${fmt(e.l)} ${e.count}`)
    }
    return out
  }
}

export class Registry {
  private metrics: Metric[] = []
  counter(name: string, help: string) { return this.add(new Counter(name, help)) }
  gauge(name: string, help: string, collect?: ConstructorParameters<typeof Gauge>[2]) { return this.add(new Gauge(name, help, collect)) }
  histogram(name: string, help: string, buckets: number[]) { return this.add(new Histogram(name, help, buckets)) }
  private add<M extends Metric>(m: M): M {
    if (!/^[a-zA-Z_:][a-zA-Z0-9_:]*$/.test(m.name) || this.metrics.some((x) => x.name === m.name)) throw new Error(`bad or duplicate metric name ${m.name}`)
    this.metrics.push(m)
    return m
  }
  /** Prometheus text format; content type `text/plain; version=0.0.4; charset=utf-8`. */
  render(): string {
    return this.metrics.map((m) => [`# HELP ${m.name} ${m.help.replace(/\n/g, ' ')}`, `# TYPE ${m.name} ${m.type}`, ...m.render()].join('\n')).join('\n') + '\n'
  }
}
export const PROMETHEUS_CONTENT_TYPE = 'text/plain; version=0.0.4; charset=utf-8'
