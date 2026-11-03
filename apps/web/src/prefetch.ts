// Early book requests are made by public/boot.js (first script of the page, while the main bundle downloads): it asks the
// book for /config and, in one /books request, the book of every pair between the configured tokens. Here: the same pair rule (guessPairs) and the
// hand-over (takePrefetched, by exact URL). A miss is a normal request, so a wrong guess only costs bandwidth.
type Tok = { symbol?: string }
type Cfg = { book?: string; defaultChain?: number; chains?: Record<string, { tokens?: Record<string, Tok> }> }

const QUOTE_RANK = ['USDC', 'USDT', 'DAI', 'WETH']
/** Pairs between tokens, oriented like the book's default markets: the quote is the highest-ranked of the two. */
export function guessPairs(tokens: Record<string, Tok>): { base: string; quote: string; id: string }[] {
  const t = Object.entries(tokens).map(([address, v]) => ({ address, symbol: String(v.symbol ?? '') }))
  const rank = (s: string) => { const i = QUOTE_RANK.indexOf(s); return i < 0 ? 99 : i }
  const out: { base: string; quote: string; id: string }[] = []
  for (let i = 0; i < t.length; i++) for (let j = i + 1; j < t.length; j++) {
    const a = t[i] as { address: string; symbol: string }, b = t[j] as { address: string; symbol: string }
    const [base, quote] = rank(a.symbol) <= rank(b.symbol) ? [b, a] : [a, b]
    out.push({ base: base.address, quote: quote.address, id: `${base.symbol}-${quote.symbol}` })
  }
  return out
}
export const bookPath = (chainId: number, base: string, quote: string, limit: number) => `/book?chainId=${chainId}&base=${base}&quote=${quote}&limit=${limit}&signed=1`
/** Same string as public/boot.js builds (lowercase addresses, at most 10 pairs). */
export const booksPath = (chainId: number, pairs: readonly { base: string; quote: string }[], limit = 100) =>
  `/books?chainId=${chainId}&pairs=${pairs.slice(0, 10).map((m) => `${m.base}:${m.quote}`.toLowerCase()).join(',')}&limit=${limit}&signed=1`

type Store = Map<string, Promise<Response>>
declare global { interface Window { __fondacoPrefetch?: Store } }

/** The prefetched response for `url`, once (null if none). */
export function takePrefetched(url: string): Promise<Response> | null {
  const s = typeof window !== 'undefined' ? window.__fondacoPrefetch : undefined
  const p = s?.get(url) ?? null
  if (p) s?.delete(url)
  return p
}

