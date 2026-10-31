// Minimal in-house schema validator for the server configuration (decision A-03: no runtime dependency but viem).
// Every field carries its default and a description, so the documentation is generated from the same source.
// Unknown keys are errors. All errors are collected and reported together, with their path.
export interface Field<T> {
  readonly kind: string
  readonly doc: string
  readonly default?: T
  readonly optional?: boolean
  parse(v: unknown, path: string, errs: string[]): T
}
export type Infer<F> = F extends Field<infer T> ? T : never
type Shape = Record<string, Field<unknown>>
type ObjOut<S extends Shape> = { [K in keyof S]: Infer<S[K]> }

export class ConfigError extends Error {
  readonly errors: string[]
  constructor(errors: string[]) {
    super(`invalid configuration:\n  - ${errors.join('\n  - ')}`)
    this.errors = errors
  }
}

const show = (v: unknown) => (typeof v === 'string' ? JSON.stringify(v) : v === undefined ? 'nothing' : JSON.stringify(v) ?? String(v))
const fail = <T>(errs: string[], path: string, want: string, v: unknown): T => { errs.push(`${path}: expected ${want}, got ${show(v)}`); return undefined as T }

/** Edit distance, for "did you mean" on unknown keys. */
function near(key: string, known: string[]): string | undefined {
  const d = (a: string, b: string) => {
    const m = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array<number>(b.length).fill(0)])
    for (let j = 1; j <= b.length; j++) (m[0] as number[])[j] = j
    for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) {
      const row = m[i] as number[], prev = m[i - 1] as number[]
      row[j] = Math.min((prev[j] as number) + 1, (row[j - 1] as number) + 1, (prev[j - 1] as number) + (a[i - 1] === b[j - 1] ? 0 : 1))
    }
    return (m[a.length] as number[])[b.length] as number
  }
  const best = known.map((k) => [k, d(key.toLowerCase(), k.toLowerCase())] as const).sort((a, b) => a[1] - b[1])[0]
  return best && best[1] <= Math.max(2, Math.floor(key.length / 3)) ? best[0] : undefined
}

const field = <T>(kind: string, doc: string, parse: Field<T>['parse'], extra: { default?: T; optional?: boolean } = {}): Field<T> => ({ kind, doc, parse, ...extra })

export const int = (doc: string, o: { default?: number; min?: number; max?: number } = {}): Field<number> =>
  field(`integer${o.min != null ? ` ≥ ${o.min}` : ''}${o.max != null ? ` ≤ ${o.max}` : ''}`, doc, (v, path, errs) => {
    const n = typeof v === 'string' && /^\d+$/.test(v) ? Number(v) : v
    if (typeof n !== 'number' || !Number.isSafeInteger(n) || (o.min != null && n < o.min) || (o.max != null && n > o.max)) {
      return fail(errs, path, `an integer${o.min != null ? ` ≥ ${o.min}` : ''}${o.max != null ? ` ≤ ${o.max}` : ''}`, v)
    }
    return n
  }, o.default != null ? { default: o.default } : {})

export const num = (doc: string, o: { default?: number; min?: number } = {}): Field<number> =>
  field(`number${o.min != null ? ` ≥ ${o.min}` : ''}`, doc, (v, path, errs) =>
    typeof v === 'number' && Number.isFinite(v) && (o.min == null || v >= o.min) ? v : fail(errs, path, `a number${o.min != null ? ` ≥ ${o.min}` : ''}`, v),
  o.default != null ? { default: o.default } : {})

export const str = (doc: string, o: { default?: string; pattern?: RegExp; what?: string; oneOf?: readonly string[] } = {}): Field<string> =>
  field(o.oneOf ? o.oneOf.map((x) => `"${x}"`).join(' | ') : o.what ?? 'string', doc, (v, path, errs) =>
    typeof v === 'string' && v.length > 0 && (!o.pattern || o.pattern.test(v)) && (!o.oneOf || o.oneOf.includes(v))
      ? v : fail(errs, path, o.oneOf ? `one of ${o.oneOf.join(', ')}` : o.what ?? 'a non-empty string', v),
  o.default != null ? { default: o.default } : {})

export const bool = (doc: string, o: { default?: boolean } = {}): Field<boolean> =>
  field('boolean', doc, (v, path, errs) => (typeof v === 'boolean' ? v : fail(errs, path, 'true or false', v)), o.default != null ? { default: o.default } : {})

export const optional = <T>(f: Field<T>): Field<T | undefined> => ({ ...f, optional: true }) as Field<T | undefined>
export const withDefault = <T>(f: Field<T>, d: T): Field<T> => ({ ...f, default: d })

export const list = <T>(item: Field<T>, doc: string, o: { default?: T[]; min?: number } = {}): Field<T[]> =>
  field(`list of ${item.kind}`, doc, (v, path, errs) => {
    if (!Array.isArray(v) || v.length < (o.min ?? 0)) return fail(errs, path, `a list${o.min ? ` with at least ${o.min} item(s)` : ''}`, v)
    return v.map((x, i) => item.parse(x, `${path}[${i}]`, errs))
  }, o.default != null ? { default: o.default } : {})

/** A single value or a non-empty list of them; normalized to a list. */
export const oneOrMany = <T>(item: Field<T>, doc: string): Field<T[]> =>
  field(`${item.kind} or list of ${item.kind}`, doc, (v, path, errs) => (Array.isArray(v) ? list(item, doc, { min: 1 }).parse(v, path, errs) : [item.parse(v, path, errs)]))

export function obj<S extends Shape>(shape: S, doc: string, o: { default?: Partial<ObjOut<S>> | 'fields' } = {}): Field<ObjOut<S>> & { shape: S } {
  const parse = (v: unknown, path: string, errs: string[]): ObjOut<S> => {
    if (v == null && o.default) v = {}
    if (!v || typeof v !== 'object' || Array.isArray(v)) return fail(errs, path, 'an object', v)
    const input = v as Record<string, unknown>, out: Record<string, unknown> = {}
    for (const k of Object.keys(input)) {
      if (input[k] === undefined || k in shape) continue
      const hint = near(k, Object.keys(shape))
      errs.push(`${path}.${k}: unknown key${hint ? ` (did you mean "${hint}"?)` : ''}`)
    }
    for (const [k, f] of Object.entries(shape)) {
      const val = input[k]
      if (val === undefined) {
        if (f.default !== undefined) out[k] = f.parse(f.default, `${path}.${k}`, errs)
        else if (f.optional) continue
        else errs.push(`${path}.${k}: required (${f.kind}) — ${f.doc}`)
      } else out[k] = f.parse(val, `${path}.${k}`, errs)
    }
    return out as ObjOut<S>
  }
  return { kind: 'object', doc, parse, shape, ...(o.default ? { default: {} as ObjOut<S> } : {}) }
}

/** Object with free keys (validated by `key`) and values of one type. */
export const record = <K extends string, T>(key: Field<K>, value: Field<T>, doc: string, o: { min?: number } = {}): Field<Record<K, T>> & { value: Field<T> } => ({
  kind: `map ${key.kind} → ${value.kind}`, doc, value,
  parse(v, path, errs) {
    if (!v || typeof v !== 'object' || Array.isArray(v)) return fail(errs, path, 'an object', v)
    const out = {} as Record<K, T>
    const entries = Object.entries(v as Record<string, unknown>)
    if (entries.length < (o.min ?? 0)) errs.push(`${path}: at least ${o.min} entry required`)
    for (const [k, x] of entries) {
      const nk = key.parse(k, `${path} key ${JSON.stringify(k)}`, errs)
      if (nk !== undefined) out[nk] = value.parse(x, `${path}.${k}`, errs)
    }
    return out
  },
})

export function validate<F extends Field<unknown>>(f: F, input: unknown, root = 'config'): Infer<F> {
  const errs: string[] = []
  const out = f.parse(input, root, errs)
  if (errs.length) throw new ConfigError(errs)
  return out as Infer<F>
}
