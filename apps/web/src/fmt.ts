// Formatting, ported 1:1 from the prototype (it-IT, grouping always on, decimals per token and per price magnitude).
import { displayDecimals } from './tokens.js'

export const pdec = (p: number): number => Math.min(8, Math.max(2, 5 - Math.floor(Math.log10(Math.max(p, 1e-9))) - 1))
export const roundP = (p: number): number => { const k = 10 ** pdec(p); return Math.round(p * k) / k }
export const qdec = (sym: string): number => Math.min(displayDecimals(sym), 4)
/** Parse a user-typed Italian number ("1.234,5") — the prototype's rule: dots are thousands, comma is the decimal mark. */
export const num = (s: unknown): number => { const n = parseFloat(String(s ?? '').replace(/\./g, '').replace(',', '.')); return Number.isFinite(n) && n > 0 ? n : 0 }
export const fmt = (n: number, max: number, min = 0): string =>
  (Number.isFinite(n) ? n : 0).toLocaleString('it-IT', { minimumFractionDigits: Math.min(min, max), maximumFractionDigits: max, useGrouping: 'always' } as Intl.NumberFormatOptions)
export const fp = (p: number): string => fmt(p, pdec(p), pdec(p))
export const fq = (sym: string, q: number): string => fmt(q, qdec(sym))
export const fa = (sym: string, a: number): string => fmt(a, displayDecimals(sym))
export const fusd = (v: number | null): string => (v == null ? '—' : '≈ ' + fmt(v, v >= 100 ? 0 : 2, v >= 100 ? 0 : 2) + ' $')
export const short$ = (v: number | null): string => (v == null ? '—' : v >= 1e6 ? fmt(v / 1e6, 1, 1) + ' M$' : v >= 1e3 ? fmt(v / 1e3, 0) + ' k$' : fmt(v, 0) + ' $')
export const esc = (s: unknown): string => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string)
export const amtHTML = (n: number, d: number): string => { const s = fmt(n, d), i = s.indexOf(','); return i < 0 ? esc(s) : esc(s.slice(0, i)) + '<span class="dec">' + esc(s.slice(i)) + '</span>' }
export const clean = (v: string): string => v.replace(/[^\d.,]/g, '')
export const ago = (tMs: number, now = Date.now()): string => { const s = Math.max(0, Math.round((now - tMs) / 1000)); return s < 5 ? 'ora' : s < 60 ? s + ' s fa' : s < 3600 ? Math.round(s / 60) + ' min fa' : s < 86400 ? Math.round(s / 3600) + ' h fa' : Math.round(s / 86400) + ' g fa' }
export const shortAddr = (a: string | null | undefined): string => (a ? `${a.slice(0, 4)}…${a.slice(-4)}` : '—')
/** Time left until a unix-seconds expiry, as the prototype writes it ("tra 23 h", "tra 6 giorni"). */
export const until = (expirySec: number, nowSec: number): string => {
  const s = expirySec - nowSec
  if (s <= 0) return 'scaduta'
  if (s < 3600) return `tra ${Math.max(1, Math.round(s / 60))} min`
  if (s < 86400 * 2) return `tra ${Math.round(s / 3600)} h`
  return `tra ${Math.round(s / 86400)} giorni`
}
