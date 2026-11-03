// Client of the book server: JSON API with ETag caching, SSE with reconnection. Never throws on a 503 stale: reports it.
import type { BookEntry, CandleResponse, MyOrder } from './model.js'

export interface BookChainConfig {
  swap: string; protocolFee: string; protocolFeeLight?: string; domain: { name: string; version: string; chainId: number; verifyingContract: string }
  tokens: Record<string, { symbol: string; decimals: number; min?: string }>; markets?: { base: string; quote: string }[]
  minExpirySec: number; maxExpirySec: number; expiryBufferSec: number
}
export type BookResult = { status: 'ok'; asks: BookEntry[]; bids: BookEntry[] } | { status: 'stale'; message: string } | { status: 'error'; message: string }
export interface Trade { price: number; base: number; quote: number; side: 'buy' | 'sell'; ts: number; tx: string }
export type StreamEvent = { type: 'order' | 'fee' | 'reorg' | 'trade' | 'governance'; data: Record<string, unknown> }

export class BookApi {
  private etags = new Map<string, { etag: string; body: unknown }>()
  constructor(readonly base: string, private readonly fetchImpl: typeof fetch = (...a) => fetch(...a)) {}

  private async get<T>(path: string, cache = false): Promise<{ status: number; body: T | null }> {
    const hit = cache ? this.etags.get(path) : undefined
    const r = await this.fetchImpl(this.base + path, { headers: hit ? { 'if-none-match': hit.etag } : {}, cache: 'no-store' })
    if (r.status === 304 && hit) return { status: 200, body: hit.body as T }
    const body = r.headers.get('content-type')?.includes('json') ? ((await r.json()) as T) : null
    const etag = r.headers.get('etag')
    if (cache && r.ok && etag) this.etags.set(path, { etag, body })
    return { status: r.status, body }
  }

  async config(): Promise<Record<string, BookChainConfig>> {
    const r = await this.get<Record<string, BookChainConfig>>('/config')
    if (r.status !== 200 || !r.body) throw new Error(`/config → ${r.status}`)
    return r.body
  }
  async book(chainId: number, base: string, quote: string, limit = 100): Promise<BookResult> {
    try {
      const r = await this.get<{ asks: BookEntry[]; bids: BookEntry[]; error?: string; message?: string }>(`/book?chainId=${chainId}&base=${base}&quote=${quote}&limit=${limit}&signed=1`, true)
      if (r.status === 200 && r.body) return { status: 'ok', asks: r.body.asks, bids: r.body.bids }
      if (r.status === 503 && (r.body as { error?: string } | null)?.error === 'stale') return { status: 'stale', message: (r.body as { message?: string }).message ?? 'stale' }
      return { status: 'error', message: `HTTP ${r.status}` }
    } catch (e) { return { status: 'error', message: (e as Error).message } }
  }
  async trades(chainId: number, base: string, quote: string, limit = 30): Promise<Trade[] | null> {
    const r = await this.get<{ trades: Trade[] }>(`/trades?chainId=${chainId}&base=${base}&quote=${quote}&limit=${limit}`, true).catch(() => null)
    return r?.status === 200 && r.body ? r.body.trades : null
  }
  async candles(chainId: number, base: string, quote: string, interval = 300, limit = 288): Promise<CandleResponse | null> {
    const r = await this.get<CandleResponse>(`/candles?chainId=${chainId}&base=${base}&quote=${quote}&interval=${interval}&limit=${limit}`, true).catch(() => null)
    return r?.status === 200 && r.body ? r.body : null
  }
  async orders(chainId: number, signer: string): Promise<MyOrder[]> {
    const r = await this.get<{ orders: MyOrder[] }>(`/orders?chainId=${chainId}&signer=${signer}`)
    return r.status === 200 && r.body ? r.body.orders : []
  }
  async submit(chainId: number, orders: unknown[]): Promise<{ hash?: string; status?: string; error?: string; message?: string }[]> {
    const r = await this.fetchImpl(this.base + '/orders', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ chainId, orders }) })
    const body = (await r.json().catch(() => ({}))) as { results?: { hash?: string; status?: string; error?: string; message?: string }[]; error?: string; message?: string }
    if (body.results) return body.results
    return orders.map(() => ({ error: body.error ?? `http_${r.status}`, message: body.message ?? `HTTP ${r.status}` }))
  }

  /**
   * SSE with reconnection: exponential backoff (1 s → 30 s) and `onState(true)` after each (re)connection, so the caller
   * refetches what it may have missed. Returns a stop function.
   */
  stream(onEvent: (e: StreamEvent) => void, onState: (up: boolean) => void, ES: typeof EventSource = EventSource): () => void {
    let es: EventSource | null = null, delay = 1000, stopped = false, timer: ReturnType<typeof setTimeout> | undefined
    const open = () => {
      if (stopped) return
      es = new ES(this.base + '/stream')
      es.onopen = () => { delay = 1000; onState(true) }
      for (const type of ['order', 'fee', 'reorg', 'trade', 'governance'] as const) {
        es.addEventListener(type, (m) => { try { onEvent({ type, data: JSON.parse((m as MessageEvent<string>).data) as Record<string, unknown> }) } catch { /* ignore */ } })
      }
      es.onerror = () => {
        es?.close(); es = null; onState(false)
        if (!stopped) { timer = setTimeout(open, delay); delay = Math.min(delay * 2, 30_000) }
      }
    }
    open()
    return () => { stopped = true; clearTimeout(timer); es?.close() }
  }
}
