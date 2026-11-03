// Live backend: the book server (API + SSE) for offers, the user's wallet for everything on-chain.
import { getAddress, type Address, type Hex } from 'viem'
import { protectionStatus, createRpcConfirmations, type ProtectionStatus, type TakerEvent, type VerifiedQuote } from '@fondaco/client'
import { BookApi, type BookChainConfig, type Trade } from './api.js'
import { guessPairs } from './prefetch.js'
import { Wallet, randomNonce } from './wallet.js'
import type { PublicClient, WalletClient } from 'viem'

/** viem clients, balances, approvals and execution: loaded on first use, off the path that shows the book */
const rt = () => import('./wallet-rt.js')
import { chainNotice, feeOf, type BookEntry, type CandleResponse, type Market, type MyOrder, type OrderTerms } from './model.js'
import type { Effective } from './config.js'
import type { Backend, Notice, PublishResult, SignedOrderView, TakerLike } from './backend.js'
export type { SignedOrderView }

const ORDER_TYPES = {
  OrderERC20: [
    { name: 'nonce', type: 'uint256' }, { name: 'expiry', type: 'uint256' }, { name: 'signerWallet', type: 'address' }, { name: 'signerToken', type: 'address' },
    { name: 'signerAmount', type: 'uint256' }, { name: 'protocolFee', type: 'uint256' }, { name: 'senderWallet', type: 'address' }, { name: 'senderToken', type: 'address' },
    { name: 'senderAmount', type: 'uint256' },
  ],
} as const
const ZERO = '0x0000000000000000000000000000000000000000'

export class LiveBackend implements Backend {
  readonly demo = false
  private api: BookApi | null
  private bookCfg: Record<string, BookChainConfig> | null = null
  private bookError: string | null = null
  private chain: number
  private mkts: Market[] = []
  private books = new Map<string, { asks: BookEntry[]; bids: BookEntry[] }>()
  private trades = new Map<string, Trade[]>()
  private candles = new Map<string, CandleResponse>()
  private my: MyOrder[] = []
  private fundsByToken: Record<Address, { balance: bigint; allowance: bigint }> | null = null
  private stale: string | null = null
  private down = false
  private governance: { event: string; block: number }[] = []
  private focused: string | null = null
  private listeners = new Set<(w: string) => void>()
  private timers: ReturnType<typeof setTimeout>[] = []
  private stopStream: (() => void) | null = null
  private chainTime = { sec: Math.floor(Date.now() / 1000), at: Date.now() }
  readonly wallet: Wallet
  private confirmations = createRpcConfirmations((() => { try { return localStorage } catch { return null } })())

  constructor(readonly cfg: Effective, wallet?: Wallet) {
    this.wallet = wallet ?? new Wallet()
    this.api = cfg.book ? new BookApi(cfg.book) : null
    this.chain = cfg.defaultChain
    this.wallet.on(() => {
      const c = this.wallet.state.chainId
      if (c && this.cfg.chains[String(c)] && c !== this.chain) { this.chain = c; this.rebuildMarkets(); void this.refreshAll() } else { void this.refreshMine() }
      this.emit('wallet')
    })
  }

  // ------------------------------------------------------------------ lifecycle
  async start(): Promise<void> {
    await this.loadConfig()
    if (this.api) this.stopStream = this.api.stream((e) => this.onEvent(e.type, e.data), (up) => {
      this.down = !up && this.bookCfg != null
      if (up) void this.refreshAll()
      this.emit('status')
    })
    // safety net: the SSE can be silent behind some proxies; stale detection needs a periodic read anyway
    const poll = () => { void this.refreshFocused(true); this.timers.push(setTimeout(poll, 15_000)) }
    this.timers.push(setTimeout(poll, 15_000))
    const funds = () => { void this.refreshFunds(); this.timers.push(setTimeout(funds, 12_000)) }
    this.timers.push(setTimeout(funds, 12_000))
  }
  stop(): void { this.stopStream?.(); this.timers.forEach(clearTimeout) }

  private async loadConfig(): Promise<void> {
    if (!this.api) { this.bookError = 'Nessuna bacheca configurata: impostane una in Impostazioni.'; this.emit('status'); return }
    // first paint of the book in one round trip: ask /config and the books of the pairs this app can show at the same time
    const guess = this.guessMarkets()
    const batch = (this.api as BookApi).books(this.chain, guess.map((m) => ({ base: m.base.address, quote: m.quote.address })))
    const early = new Map(guess.map((m) => [m.id, batch.then((b) => b?.get(`${m.base.address}:${m.quote.address}`.toLowerCase()) ?? null)] as const))
    try { this.bookCfg = await this.api.config(); this.bookError = null } catch (e) { this.bookCfg = null; this.bookError = `Bacheca non raggiungibile (${(e as Error).message}).` }
    this.rebuildMarkets()
    let allEarly = !!this.bookCfg
    if (this.bookCfg) {
      for (const m of this.mkts) {
        const r = await early.get(m.id)
        if (r?.status === 'ok') this.books.set(m.id, { asks: r.asks, bids: r.bids }); else allEarly = false
        if (r?.status === 'stale') this.stale = r.message
      }
      if (allEarly) this.emit('book')
    }
    await this.refreshAll(allEarly)
  }

  /** Markets = the book's markets whose BOTH tokens are in the app's own configuration (address match). */
  private rebuildMarkets(): void {
    const appTokens = this.cfg.chains[String(this.chain)]?.tokens ?? {}
    const bc = this.bookCfg?.[String(this.chain)]
    const out: Market[] = []
    for (const m of bc?.markets ?? []) {
      const b = appTokens[getAddress(m.base)], q = appTokens[getAddress(m.quote)]
      if (b && q) out.push({ id: `${b.symbol}-${q.symbol}`, base: b, quote: q })
    }
    this.mkts = out
  }

  private emit(what: string): void { for (const f of this.listeners) try { f(what) } catch (e) { console.error(e) } }
  onChange(f: (what: string) => void): void { this.listeners.add(f) }

  private debounce = new Map<string, ReturnType<typeof setTimeout>>()
  private soon(key: string, f: () => Promise<void>, ms = 250): void {
    clearTimeout(this.debounce.get(key))
    this.debounce.set(key, setTimeout(() => { void f() }, ms))
  }
  private onEvent(type: string, data: Record<string, unknown>): void {
    if (Number(data.chainId) !== this.chain) return
    if (type === 'order') { this.soon('books', () => this.refreshBooks()); this.soon('mine', () => this.refreshMine(), 400) }
    else if (type === 'trade') this.soon('trades', () => this.refreshTrades())
    else if (type === 'fee' || type === 'reorg') this.soon('all', () => this.refreshAll())
    else if (type === 'governance') {
      this.governance.push({ event: String(data.event), block: Number(data.block) })
      this.soon('all', () => this.refreshAll())
      this.emit('status')
    }
  }

  /** Pairs between the app's tokens, oriented like the book's default (same rule as prefetch.ts, which asked for them already). */
  private guessMarkets(): Market[] {
    const toks = this.cfg.chains[String(this.chain)]?.tokens ?? {}
    return guessPairs(toks).map((p) => ({ id: p.id, base: toks[p.base as Address] as Market['base'], quote: toks[p.quote as Address] as Market['quote'] }))
  }

  async refreshAll(booksFresh = false): Promise<void> {
    if (this.api && !this.bookCfg) { await this.loadConfigQuiet() }
    await Promise.all([booksFresh ? Promise.resolve() : this.refreshBooks(false), this.refreshTrades(), this.refreshMine(), this.refreshFunds()])
    this.emit('all')
  }
  private async loadConfigQuiet(): Promise<void> {
    try { this.bookCfg = await (this.api as BookApi).config(); this.bookError = null; this.rebuildMarkets() } catch { /* keep the error */ }
  }
  private async refreshBooks(withConfig = true): Promise<void> {
    if (!this.api) return
    if (withConfig) try { this.bookCfg = await this.api.config(); this.rebuildMarkets() } catch { /* the book call below reports it */ }
    const rs = await Promise.all(this.mkts.map(async (m) => [m, await (this.api as BookApi).book(this.chain, m.base.address, m.quote.address, m.id === this.focused ? 100 : 30)] as const))
    let stale: string | null = null, anyOk = false
    for (const [m, r] of rs) {
      if (r.status === 'ok') { this.books.set(m.id, { asks: r.asks, bids: r.bids }); anyOk = true }
      else if (r.status === 'stale') { stale = r.message; this.books.delete(m.id) }
    }
    this.stale = stale
    if (anyOk) this.bookError = null
    this.emit('book')
  }
  private async refreshFocused(withBooks: boolean): Promise<void> { if (withBooks) await this.refreshBooks(); await this.refreshTrades() }
  private async refreshTrades(): Promise<void> {
    const m = this.mkts.find((x) => x.id === this.focused) ?? this.mkts[0]
    if (!this.api || !m) return
    const [t, c] = await Promise.all([this.api.trades(this.chain, m.base.address, m.quote.address), this.api.candles(this.chain, m.base.address, m.quote.address)])
    if (t) this.trades.set(m.id, t)
    if (c) { this.candles.set(m.id, c); this.chainTime = { sec: c.now, at: Date.now() } }
    // the rail shows 24 h change for every market: candles of the others, less often
    for (const o of this.mkts) if (o.id !== m.id && !this.candles.has(o.id)) {
      const k = await this.api.candles(this.chain, o.base.address, o.quote.address)
      if (k) this.candles.set(o.id, k)
    }
    this.emit('trades')
  }
  async refreshMine(): Promise<void> {
    const me = this.account()
    if (!this.api || !me) { this.my = []; this.emit('mine'); return }
    this.my = await this.api.orders(this.chain, me).catch(() => this.my)
    this.emit('mine')
  }
  async refreshFunds(): Promise<void> {
    const me = this.account()
    if (!me) { this.fundsByToken = null; this.emit('funds'); return }
    const r = await rt(), pc = (await this.clients()).publicClient
    if (!pc) { this.fundsByToken = null; this.emit('funds'); return }
    const tokens = Object.keys(this.cfg.chains[String(this.chain)]?.tokens ?? {}) as Address[]
    try { this.fundsByToken = await r.readFunds(pc, me, tokens, this.swapAddress()); this.emit('funds') } catch { /* keep the last values */ }
  }

  // ------------------------------------------------------------------ reads
  chainId(): number { return this.chain }
  chains() { return Object.entries(this.cfg.chains).map(([id, c]) => ({ id: Number(id), name: c.name })) }
  swapAddress(): Address | null { return this.cfg.chains[String(this.chain)]?.swap ?? null }
  protocolFee(): bigint { return BigInt(this.bookCfg?.[String(this.chain)]?.protocolFee ?? '30') }
  markets(): Market[] { return this.mkts }
  bookOf(id: string) { return this.books.get(id) }
  tradesOf(id: string): Trade[] { return this.trades.get(id) ?? [] }
  candlesOf(id: string) { return this.candles.get(id) }
  myOrders(): MyOrder[] { return this.my }
  funds() { return this.fundsByToken }
  account(): Address | null { return this.wallet.state.chainId === this.chain ? this.wallet.state.address : this.wallet.state.address }
  nowSec(): number { return this.chainTime.sec + Math.floor((Date.now() - this.chainTime.at) / 1000) }
  ready(): boolean { return this.bookCfg != null }
  focus(id: string): void { if (this.focused !== id) { this.focused = id; void this.refreshTrades() } }

  notices(): Notice[] {
    const out: Notice[] = []
    const c = this.cfg.chains[String(this.chain)]
    if (this.bookError) out.push({ id: 'book', level: 'danger', title: 'Bacheca non disponibile', text: this.bookError, blocksTrading: true })
    if (this.down && !this.bookError) out.push({ id: 'down', level: 'warn', title: 'Connessione alla bacheca interrotta', text: 'Riconnessione in corso: i prezzi potrebbero non essere aggiornati.', blocksTrading: false })
    if (this.stale) out.push({ id: 'stale', level: 'danger', title: 'Dati non aggiornati', text: 'La bacheca non riesce a verificare le offerte sulla blockchain: lo scambio è bloccato finché i dati non tornano aggiornati.', blocksTrading: true })
    const n = chainNotice(c?.swap ?? null, this.bookCfg?.[String(this.chain)])
    if (n.notDeployed) out.push({ id: 'nodeploy', level: 'info', title: `Contratto non configurato su ${c?.name ?? this.chain}`, text: 'Lo scambio su questa rete non è ancora disponibile.', blocksTrading: true })
    if (n.contractMismatch) out.push({ id: 'mismatch', level: 'danger', title: 'La bacheca usa un altro contratto', text: `La bacheca dichiara ${this.bookCfg?.[String(this.chain)]?.swap}, l’app è configurata per ${c?.swap}. Scambi e offerte sono bloccati.`, blocksTrading: true })
    if (n.feeLightDiffers || this.governance.length) {
      const ev = this.governance.map((g) => g.event).join(', ')
      out.push({ id: 'gov', level: 'warn', title: 'Parametri del contratto modificati', text: n.feeLightDiffers ? 'Le due commissioni del contratto non coincidono: un parametro è stato cambiato dall’owner. Controlla prima di proporre o accettare offerte.' + (ev ? ` Eventi: ${ev}.` : '') : `L’owner ha modificato il contratto (${ev}). Controlla le commissioni prima di proporre o accettare offerte.`, blocksTrading: false })
    }
    if (this.bookCfg && this.mkts.length === 0) out.push({ id: 'nomarkets', level: 'info', title: 'Nessun mercato', text: 'La bacheca non offre coppie tra le monete configurate per questa rete.', blocksTrading: true })
    return out
  }

  // ------------------------------------------------------------------ wallet
  private async clients(): Promise<{ publicClient: PublicClient | null; walletClient: WalletClient | null }> {
    const c = this.cfg.chains[String(this.chain)] as Effective['chains'][string]
    const r = await rt()
    return r.clientsFor(this.wallet, r.viemChain(this.chain, c.name, c.rpc))
  }
  wallets() { return this.wallet.state.wallets }
  selectedWallet() { return this.wallet.state.selected }
  async connect(w: Parameters<Wallet['connect']>[0]): Promise<void> {
    await this.wallet.connect(w)
    const c = this.wallet.state.chainId
    if (c && this.cfg.chains[String(c)]) this.chain = c
    this.rebuildMarkets()
    await this.refreshAll()
  }
  async switchChain(id: number): Promise<void> {
    if (this.wallet.state.selected) await this.wallet.switchChain(id)
    this.chain = id
    this.rebuildMarkets()
    await this.refreshAll()
  }
  protection(): ProtectionStatus {
    const rdns = this.wallet.state.selected?.info.rdns ?? null
    return protectionStatus({ rdns, chainId: this.chain, userSetRpc: this.confirmations.has(rdns, this.chain) })
  }
  rpcConfirmed(): boolean { return this.confirmations.has(this.wallet.state.selected?.info.rdns ?? null, this.chain) }
  setRpcConfirmed(on: boolean): void { const r = this.wallet.state.selected?.info.rdns; if (r) this.confirmations.set(r, this.chain, on); this.emit('wallet') }

  // ------------------------------------------------------------------ actions
  private async need(): Promise<{ pc: PublicClient; wc: WalletClient; swap: Address }> {
    const { publicClient, walletClient } = await this.clients()
    const swap = this.swapAddress()
    if (!walletClient || !publicClient) throw new Error('Collega il wallet sulla rete selezionata.')
    if (!swap) throw new Error('Contratto non configurato su questa rete.')
    return { pc: publicClient, wc: walletClient, swap }
  }
  taker(onUpdate: (e: TakerEvent) => void): TakerLike {
    const make = async () => {
      const [{ pc, wc, swap }, r] = await Promise.all([this.need(), rt()])
      // a browser wallet sends through its own RPC: wallet mode (protection depends on the wallet, shown in the MEV row)
      const submitter = r.createSubmitter({ publicClient: pc, walletClient: wc, chainId: this.chain })
      return r.createTaker({ publicClient: pc, walletClient: wc, swap, submitter, onUpdate, timeoutMs: this.cfg.txTimeoutSec * 1000 })
    }
    const t = make()
    t.catch(() => { /* reported by verify/execute */ })
    return {
      verify: async (p) => (await t).verify(p),
      execute: async (q, o) => { const res = await (await t).execute(q, o); void this.refreshFunds(); void this.refreshMine(); return res },
    }
  }
  async estimateGasWei(q: VerifiedQuote): Promise<bigint | null> {
    try {
      const { pc, swap } = await this.need()
      const leg = q.legs[0]
      const me = this.account()
      if (!leg || !me) return null
      const o = leg.order
      const gas = await pc.estimateContractGas({ account: me, address: swap, abi: [{ type: 'function', name: 'swapAnySender', stateMutability: 'nonpayable', inputs: ['address', 'uint256', 'uint256', 'address', 'address', 'uint256', 'address', 'uint256', 'uint8', 'bytes32', 'bytes32'].map((type, i) => ({ type, name: `a${i}` })), outputs: [] }] as const,
        functionName: 'swapAnySender', args: [me, o.nonce, o.expiry, o.signerWallet, o.signerToken, o.signerAmount, o.senderToken, o.senderAmount, o.v, o.r, o.s] as never })
      const price = await pc.getGasPrice()
      return gas * price
    } catch { return null }
  }
  async approveFor(token: Address, amount: bigint): Promise<void> {
    const [{ pc, wc, swap }, r] = await Promise.all([this.need(), rt()])
    await r.approve(pc, wc, token, swap, amount, this.fundsByToken?.[token]?.allowance ?? 0n)
    await this.refreshFunds()
  }

  /** Sign each part (EIP-712, domain from the APP's contract and chain) and post them as one batch. */
  async publish(terms: OrderTerms[], expirySec: number, counterparty: Address | null = null): Promise<PublishResult> {
    const { wc, swap } = await this.need()
    const me = this.account() as Address
    const fee = this.protocolFee()
    const domain = { name: 'SWAP_ERC20', version: '4.3', chainId: this.chain, verifyingContract: swap } as const
    const signed = []
    for (const t of terms) {
      const message = { nonce: t.nonce ?? randomNonce(), expiry: BigInt(expirySec), signerWallet: me, signerToken: t.signerToken, signerAmount: t.signerAmount, protocolFee: fee,
        senderWallet: (counterparty ?? ZERO) as Address, senderToken: t.senderToken, senderAmount: t.senderAmount }
      const sig = await wc.signTypedData({ account: me, domain, types: ORDER_TYPES, primaryType: 'OrderERC20', message })
      signed.push({ ...Object.fromEntries(Object.entries(message).map(([k, v]) => [k, String(v)])), v: parseInt(sig.slice(130, 132), 16), r: `0x${sig.slice(2, 66)}` as Hex, s: `0x${sig.slice(66, 130)}` as Hex })
    }
    const res = await (this.api as BookApi).submit(this.chain, signed)
    await this.refreshMine()
    void this.refreshBooks()
    return { ok: res.filter((r) => r.hash).length, hashes: res.filter((r) => r.hash).map((r) => r.hash as string), errors: [...new Set(res.filter((r) => r.error).map((r) => r.message ?? r.error ?? 'errore'))] }
  }
  async privateOrder(hash: string) {
    if (!this.api || !/^0x[0-9a-fA-F]{64}$/.test(hash)) return null
    const o = await this.api.order(hash)
    return o && o.order.senderWallet && getAddress(String(o.order.senderWallet)) !== ZERO ? o : null
  }

  async cancel(nonces: string[]) {
    const [{ pc, wc, swap }, m] = await Promise.all([this.need(), rt()])
    const submitter = m.createSubmitter({ publicClient: pc, walletClient: wc, chainId: this.chain })
    const r = await m.cancelOrders({ publicClient: pc, walletClient: wc, submitter, swap, nonces })
    await this.refreshMine()
    return r
  }
  /** total that live orders of `token` require (amount + fee), for the "Da autorizzare" line */
  liveNeed(token: Address): bigint {
    return this.my.filter((o) => (o.status === 'open' || o.status === 'unfunded') && getAddress(o.order.signerToken) === token)
      .reduce((s, o) => s + BigInt(o.order.signerAmount) + feeOf(BigInt(o.order.signerAmount), BigInt(o.order.protocolFee)), 0n)
  }
}
