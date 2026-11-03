// App configuration (public/config.json, shipped with the build) and the user's overrides from Impostazioni.
// The app trusts ITS configuration for the contract and the tokens; the book only says which offers exist.
import { getAddress, isAddress, type Address } from 'viem'
import type { TokenView } from './tokens.js'
import { isStableSymbol } from './tokens.js'

export interface ChainConf { name: string; rpc: string; swap: Address | null; explorer?: string; tokens: Record<Address, TokenView> }
export interface AppConfig { book: string; defaultChain: number; chains: Record<string, ChainConf> }
export interface Settings { book?: string; chains?: Record<string, { rpc?: string; swap?: string }> }
export interface Effective extends AppConfig { overridden: { book: boolean; rpc: Record<string, boolean>; swap: Record<string, boolean> } }

export const SETTINGS_KEY = 'fondaco-settings'
const isUrl = (s: string) => { try { const u = new URL(s); return u.protocol === 'https:' || u.protocol === 'http:' } catch { return false } }

/** Validate and normalize raw config.json (throws with every problem listed). */
export function parseAppConfig(raw: unknown): AppConfig {
  const errs: string[] = []
  const r = (raw ?? {}) as Record<string, unknown>
  const book = typeof r.book === 'string' ? r.book.trim().replace(/\/+$/, '') : ''
  if (book && !isUrl(book)) errs.push('book: not an http(s) URL')
  const chains: Record<string, ChainConf> = {}
  for (const [id, c0] of Object.entries((r.chains ?? {}) as Record<string, Record<string, unknown>>)) {
    if (!/^[1-9]\d*$/.test(id)) { errs.push(`chains.${id}: not a chain id`); continue }
    const rpc = typeof c0.rpc === 'string' ? c0.rpc.trim() : ''
    if (rpc && !isUrl(rpc)) errs.push(`chains.${id}.rpc: not an http(s) URL`)
    const swap = c0.swap == null || c0.swap === '' ? null : typeof c0.swap === 'string' && isAddress(c0.swap, { strict: false }) ? getAddress(c0.swap) : (errs.push(`chains.${id}.swap: not an address`), null)
    const tokens: Record<Address, TokenView> = {}
    const seen = new Set<string>()
    for (const [a, t0] of Object.entries((c0.tokens ?? {}) as Record<string, Record<string, unknown>>)) {
      if (!isAddress(a, { strict: false })) { errs.push(`chains.${id}.tokens.${a}: not an address`); continue }
      const symbol = String(t0.symbol ?? ''), decimals = Number(t0.decimals)
      if (!symbol || !Number.isInteger(decimals) || decimals < 0 || decimals > 36) { errs.push(`chains.${id}.tokens.${a}: symbol and decimals required`); continue }
      if (seen.has(symbol)) errs.push(`chains.${id}.tokens: symbol ${symbol} used twice`)
      seen.add(symbol)
      tokens[getAddress(a)] = { address: getAddress(a), symbol, decimals, name: String(t0.name ?? symbol), stable: t0.stable === true || isStableSymbol(symbol) }
    }
    chains[id] = { name: String(c0.name ?? `Chain ${id}`), rpc, swap, ...(typeof c0.explorer === 'string' ? { explorer: c0.explorer } : {}), tokens }
  }
  const defaultChain = Number(r.defaultChain ?? Object.keys(chains)[0] ?? 1)
  if (!chains[String(defaultChain)]) errs.push(`defaultChain ${defaultChain} is not in chains`)
  if (errs.length) throw new Error(`config.json non valido:\n- ${errs.join('\n- ')}`)
  return { book, defaultChain, chains }
}

/** Validate user overrides; returns the problems (empty = ok). */
export function validateSettings(s: Settings, cfg: AppConfig): string[] {
  const errs: string[] = []
  if (s.book != null && s.book !== '' && !isUrl(s.book)) errs.push('L’indirizzo della bacheca deve iniziare con https:// (o http:// in locale).')
  for (const [id, c] of Object.entries(s.chains ?? {})) {
    const name = cfg.chains[id]?.name ?? id
    if (c.rpc && !isUrl(c.rpc)) errs.push(`RPC di ${name}: deve essere un indirizzo https://.`)
    if (c.swap && !isAddress(c.swap, { strict: false })) errs.push(`Contratto di ${name}: indirizzo non valido.`)
  }
  return errs
}

type StorageLike = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>
export function readSettings(storage: StorageLike | null): Settings {
  try { const v = JSON.parse(storage?.getItem(SETTINGS_KEY) ?? '{}') as unknown; return v && typeof v === 'object' && !Array.isArray(v) ? (v as Settings) : {} } catch { return {} }
}
export function writeSettings(storage: StorageLike | null, s: Settings): void { try { storage?.setItem(SETTINGS_KEY, JSON.stringify(s)) } catch { /* private mode: session only */ } }
export function clearSettings(storage: StorageLike | null): void { try { storage?.removeItem(SETTINGS_KEY) } catch { /* ignore */ } }

/** Configuration in force: config.json + the user's overrides (book URL, RPC, and the contract only with explicit consent). */
export function effective(cfg: AppConfig, s: Settings): Effective {
  const out: Effective = { ...cfg, chains: {}, overridden: { book: false, rpc: {}, swap: {} } }
  if (s.book && isUrl(s.book)) { out.book = s.book.replace(/\/+$/, ''); out.overridden.book = out.book !== cfg.book }
  for (const [id, c] of Object.entries(cfg.chains)) {
    const o = s.chains?.[id] ?? {}
    const rpc = o.rpc != null && (o.rpc === '' || isUrl(o.rpc)) ? o.rpc : c.rpc
    const swap = o.swap && isAddress(o.swap, { strict: false }) ? getAddress(o.swap) : c.swap
    out.chains[id] = { ...c, rpc, swap }
    out.overridden.rpc[id] = rpc !== c.rpc
    out.overridden.swap[id] = swap !== c.swap
  }
  return out
}
