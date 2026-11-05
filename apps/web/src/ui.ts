// The interface: a port of the prototype's script (docs/reference/mini-exchange.html) onto real data.
// Same DOM, same ids, same render functions and motion rules; data comes from a Backend (live or, in demo builds, simulated).
import { formatUnits, getAddress, type Address } from 'viem'
import { GUIDE_STEPS, type ExecuteResult, type TakerEvent, type VerifiedQuote } from '@fondaco/client'
import { fmt, fp, fq, fa, fusd, short$, esc, amtHTML, clean, ago, num, pdec, roundP, qdec, shortAddr, until } from './fmt.js'
import { coin, coins2, tokBtn, displayDecimals } from './tokens.js'
import { levels, midOf, quoteSwap, ladderTerms, feeOf, guard, groupOffers, series, stats, toUnits, quoteState, legStatus, type LegStatus, type Level, type Market, type SwapQuote, type OfferView, type HistoryItem } from './model.js'
import type { Backend, Notice } from './backend.js'

const $ = (id: string): HTMLElement => document.getElementById(id) as HTMLElement
const $i = (id: string): HTMLInputElement => document.getElementById(id) as HTMLInputElement
const RM = window.matchMedia('(prefers-reduced-motion: reduce)')
const MQ2 = window.matchMedia('(min-width: 860px)')
const MQ3 = window.matchMedia('(min-width: 1180px)')
type Tab = 'swap' | 'markets' | 'offers'

export interface UIHandle { render: () => void; toast: (t: string, s?: string) => void; openSheet: (id: string, focusEl?: HTMLElement) => void; closeSheet: (id: string) => void }
export function startUI(B: Backend, opts: { openSettings: () => void }): UIHandle {
  // ---------------------------------------------------------------- state (same shape as the prototype's S)
  const S = {
    tab: 'swap' as Tab, tabDir: 0, mode: 'swap' as 'swap' | 'make', mkt: '', detail: false, at: 'book' as 'book' | 'trades', tf: 288, filter: 'all', search: '', msearch: '', psearch: '',
    ofilter: 'attive' as 'attive' | 'storico', details: false, pay: '', recv: '', amount: '',
    mk: { give: '', get: '', amount: '', mode: 'market' as 'market' | 'fast' | 'custom', custom: '', exp: '1h' as '1h' | '24h' | '7d', partial: true, ack: false, priv: false, cp: '' },
    confirmAll: false, rot: 0, _rk: '', _ra: 0, _mm: '', _mp: 0,
  }
  const flash = new Map<string, number>(), mflash = new Map<string, { t: number; dir: number }>(), lastMid = new Map<string, number>()
  try {
    const p = JSON.parse(localStorage.getItem('mx-ui2') || '{}') as Record<string, string>
    if (p.tab === 'swap' || p.tab === 'markets' || p.tab === 'offers') S.tab = p.tab
    if (p.mode === 'swap' || p.mode === 'make') S.mode = p.mode
    if (p.at === 'book' || p.at === 'trades') S.at = p.at
    if (p.mkt) S.mkt = p.mkt
  } catch { /* storage unavailable */ }
  const save = () => { try { localStorage.setItem('mx-ui2', JSON.stringify({ tab: S.tab, mode: S.mode, at: S.at, mkt: S.mkt })) } catch { /* ignore */ } }

  // ---------------------------------------------------------------- data views
  const markets = () => B.markets()
  const byId = (id: string) => markets().find((m) => m.id === id) ?? null
  const tokens = () => { const out = new Map<string, Market['base']>(); for (const m of markets()) { out.set(m.base.symbol, m.base); out.set(m.quote.symbol, m.quote) } return out }
  const tok = (sym: string) => tokens().get(sym) ?? null
  const findMarket = (a: string, b: string) => (a === b ? null : markets().find((m) => (m.base.symbol === a && m.quote.symbol === b) || (m.base.symbol === b && m.quote.symbol === a)) ?? null)
  const me = () => B.account()
  const view = (m: Market) => {
    const bk = B.bookOf(m.id) ?? { asks: [], bids: [] }
    const asks = levels(bk.asks, m.base, me()), bids = levels(bk.bids, m.base, me())
    const c = B.candlesOf(m.id)
    return { m, bk, asks, bids, mid: midOf(asks, bids), hist: c ? series(c) : [], st: c ? stats(c) : null, trades: B.tradesOf(m.id) }
  }
  const mid = (m: Market) => view(m).mid
  /** USD value: stables at 1, others through a market against a stable (book mid); null if none (never invented). */
  const usdPrice = (sym: string): number | null => {
    const t = tok(sym); if (!t) return null
    if (t.stable) return 1
    for (const m of markets()) {
      if (m.base.symbol === sym && m.quote.stable) { const p = mid(m); if (p > 0) return p }
      if (m.quote.symbol === sym && m.base.stable) { const p = mid(m); if (p > 0) return 1 / p }
    }
    return null
  }
  const usd = (sym: string, a: number) => { const p = usdPrice(sym); return p == null ? null : a * p }
  const bal = (sym: string): number | null => { const f = B.funds(), t = tok(sym); if (!f || !t) return null; const x = f[t.address]; return x ? Number(formatUnits(x.balance, t.decimals)) : 0 }
  const allowance = (sym: string): bigint => { const f = B.funds(), t = tok(sym); return f && t ? (f[t.address]?.allowance ?? 0n) : 0n }
  const fbal = (sym: string) => { const b = bal(sym); return b == null ? '—' : fa(sym, b) }
  const blocking = (): Notice | null => B.notices().find((n) => n.blocksTrading) ?? null
  const preferredQuote = (t: string) => markets().map((m) => (m.base.symbol === t ? m.quote.symbol : m.quote.symbol === t ? m.base.symbol : null)).find(Boolean) ?? ''

  // ---------------------------------------------------------------- helpers (prototype)
  /** rewrite only on change: a re-render between mousedown and mouseup (blur of an amount field) must not eat the click */
  const lastHTML = new WeakMap<HTMLElement, string>()
  const setHTML = (el: HTMLElement, html: string) => { if (lastHTML.get(el) !== html) { el.innerHTML = html; lastHTML.set(el, html) } }
  const setSeg = (el: HTMLElement, i: number) => el.style.setProperty('--i', String(i))
  const pressed = (el: HTMLElement, attr: string, val: string) => el.querySelectorAll('button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset[attr] === val)))
  const fit = (el: HTMLElement, text: string) => {
    el.classList.remove('fit-m', 'fit-s')
    const W = el.clientWidth, L = Math.max(1, String(text).length)
    if (!W) return
    const base = innerWidth <= 400 ? 34 : 40, size = Math.max(18, Math.min(base, Math.floor(W / (L * 0.58))))
    el.style.fontSize = size === base ? '' : size + 'px'
  }
  const tw = new WeakMap<HTMLElement, { v: number; raf: number }>()
  function tween(el: HTMLElement, to: number, render: (v: number) => string) {
    const prev = tw.get(el)
    if (prev?.raf) cancelAnimationFrame(prev.raf)
    const from = prev ? prev.v : to, rec = { v: from, raf: 0 }
    tw.set(el, rec)
    if (RM.matches || !prev || Math.abs(to - from) < 1e-12 || document.hidden || !Number.isFinite(to) || !Number.isFinite(from)) { rec.v = to; el.innerHTML = render(to); return }
    const t0 = performance.now(), D = 340
    const step = (now: number) => {
      const k = Math.min(1, (now - t0) / D), e = 1 - Math.pow(1 - k, 3)
      rec.v = from + (to - from) * e; el.innerHTML = render(rec.v)
      if (k < 1) rec.raf = requestAnimationFrame(step); else { rec.v = to; rec.raf = 0 }
    }
    rec.raf = requestAnimationFrame(step)
  }
  const ENTER = ['enter', 'from-l', 'from-r']
  function reveal(el: HTMLElement, show: boolean, animate: boolean, cls = 'enter') {
    const was = !el.hidden; el.hidden = !show
    if (show && !was && animate && !RM.matches) { el.classList.remove(...ENTER); void el.offsetWidth; el.classList.add(cls) }
  }
  function cascade(el: Element | null) {
    if (RM.matches || !el) return
    el.classList.remove('stagger'); void (el as HTMLElement).offsetWidth; el.classList.add('stagger');
    [...el.children].forEach((c, i) => (c as HTMLElement).style.setProperty('--k', String(Math.min(i, 12))))
    const h = el as HTMLElement & { _st?: ReturnType<typeof setTimeout> }
    clearTimeout(h._st); h._st = setTimeout(() => el.classList.remove('stagger'), 900)
  }
  let tt: ReturnType<typeof setTimeout> | undefined
  function toast(t: string, s?: string) { $('toast-t').textContent = t; $('toast-s').textContent = s || ''; const el = $('toast'); el.classList.add('show'); clearTimeout(tt); tt = setTimeout(() => el.classList.remove('show'), 3200) }
  function ping() { const c = $('trade-card'); c.classList.remove('ping'); void c.offsetWidth; c.classList.add('ping') }

  /** Make sure the selection points at existing markets (markets come from /config and can change). */
  function ensureSelection() {
    const ms = markets()
    if (!ms.length) return
    if (!byId(S.mkt)) S.mkt = (ms[0] as Market).id
    const m = byId(S.mkt) as Market
    if (!findMarket(S.pay, S.recv)) { S.pay = m.quote.symbol; S.recv = m.base.symbol; S.amount = '' }
    if (!findMarket(S.mk.give, S.mk.get)) { S.mk.give = m.base.symbol; S.mk.get = m.quote.symbol; S.mk.amount = ''; S.mk.custom = '' }
    B.focus(S.mkt)
  }
  function quote(): SwapQuote & { m: Market | null } {
    const m = findMarket(S.pay, S.recv)
    if (!m) return { ok: false, buy: false, plan: null, legs: [], orders: 0, got: 0, spent: 0, left: 0, liq: 0, smallest: Infinity, avg: 0, amount: 0, m: null }
    const q = quoteSwap(m, B.bookOf(m.id) ?? { asks: [], bids: [] }, S.pay === m.quote.symbol, num(S.amount), me())
    return { ...q, m }
  }
  function mkInfo() {
    const k = S.mk, m = findMarket(k.give, k.get)
    if (!m) return null
    const v = view(m), sell = k.give === m.base.symbol, comp = (sell ? v.asks : v.bids).filter((l) => !l.own).map((l) => l.p)
    const market = comp.length ? (comp[0] as number) : v.mid, fast = roundP(sell ? market * 0.995 : market * 1.005)
    if (!k.custom && market > 0) k.custom = fp(roundP(sell ? market * 1.01 : market * 0.99))
    return { m, v, sell, comp, market, fast, price: k.mode === 'market' ? market : k.mode === 'fast' ? fast : num(k.custom) }
  }
  function syncMarket() { const m = S.mode === 'swap' ? findMarket(S.pay, S.recv) : findMarket(S.mk.give, S.mk.get); if (m) { S.mkt = m.id; B.focus(m.id) } }

  // ---------------------------------------------------------------- banners
  function renderBanners() {
    const ns = B.notices()
    $('banners').innerHTML = ns.map((n) => `<div class="banner ${n.level}" role="${n.level === 'danger' ? 'alert' : 'status'}" data-notice="${esc(n.id)}"><svg class="ic sm" aria-hidden="true"><use href="#i-alert"/></svg><span><b>${esc(n.title)}</b>${esc(n.text)}</span></div>`).join('')
  }

  // ---------------------------------------------------------------- render: ticket
  function renderSwap() {
    const pt = tok(S.pay), rt = tok(S.recv)
    $('pay-tok').innerHTML = pt ? tokBtn(S.pay, 'scegli la moneta da pagare') : '—'; $('recv-tok').innerHTML = rt ? tokBtn(S.recv, 'scegli la moneta da ricevere') : '—'
    $('pay-bal').textContent = fbal(S.pay); $('recv-bal').textContent = fbal(S.recv)
    $('recip-addr').textContent = shortAddr(me())
    const pin = $i('pay-in')
    if (document.activeElement !== pin) pin.value = S.amount
    fit(pin, pin.value || '0')
    const amount = num(S.amount), q = quote(), cta = $('review') as HTMLButtonElement, t = $('review-t')
    tween($('pay-usd'), usd(S.pay, amount) ?? NaN, (v) => fusd(Number.isFinite(v) ? v : null))
    const block = blocking()
    if (!q.ok || !q.m) {
      tween($('recv-out'), 0, () => '0'); $('recv-usd').textContent = '—'
      $('rate').textContent = markets().length ? 'Nessun mercato per questa coppia' : 'Nessun mercato disponibile'
      $('legs').innerHTML = ''; $('legs-text').textContent = 'Scegli una moneta che abbia un mercato con l’altra.'
      $('d-avg').textContent = '—'; $('d-exec').textContent = '—'
      $('over').hidden = true; cta.disabled = true; t.textContent = block ? block.title : 'Coppia non disponibile'
      return
    }
    const m = q.m, d = displayDecimals(S.recv)
    tween($('recv-out'), q.got, (v) => (v > 0 ? amtHTML(v, d) : '0'))
    fit($('recv-out'), q.got > 0 ? fmt(q.got, d) : '0')
    tween($('recv-usd'), usd(S.recv, q.got) ?? NaN, (v) => fusd(Number.isFinite(v) ? v : null))
    if (q.avg > 0) tween($('rate'), q.avg, (v) => `1 ${m.base.symbol} ≈ ${fp(v)} ${m.quote.symbol}`); else $('rate').textContent = 'Nessuna offerta nel libro'
    const rkey = m.id + (q.buy ? 'b' : 's'), rtop = $('rate').parentElement as HTMLElement & { _t?: ReturnType<typeof setTimeout> }
    if (S._rk === rkey && S._ra && Math.abs(q.avg - S._ra) > 1e-12 && !RM.matches) {
      rtop.classList.remove('tick-up', 'tick-down'); void rtop.offsetWidth; rtop.classList.add(q.avg > S._ra ? 'tick-up' : 'tick-down')
      clearTimeout(rtop._t); rtop._t = setTimeout(() => rtop.classList.remove('tick-up', 'tick-down'), 700)
    }
    S._rk = rkey; S._ra = q.avg
    const alphas = [1, 0.68, 0.45, 0.3, 0.2, 0.14]
    $('legs').innerHTML = q.legs.map((l, i) => `<span style="flex:${Math.max(l.take, 1e-12)} 1 0;background:rgba(74,103,247,${alphas[i] || 0.12})"></span>`).join('')
    const nOff = (n: number) => (n === 1 ? '1 offerta' : n + ' offerte')
    $('legs-text').textContent = q.legs.length === 0 ? 'Scrivi un importo per vedere da quali offerte arriva.'
      : `Da ${nOff(q.orders)} intere a ${q.legs.map((l) => fp(l.p)).join(' · ')} ${m.quote.symbol}. Stima dal libro: diventa definitiva dopo la verifica on-chain.`
    $('d-avg').textContent = q.avg > 0 ? fp(q.avg) + ' ' + m.quote.symbol : '—'
    $('d-exec').textContent = q.orders ? (q.orders === 1 ? '1 transazione' : q.orders + ' transazioni, una per offerta') : '—'
    const short = q.liq + 1e-9 < amount && amount > 0
    const unused = !short && amount > 0 && q.left > Math.max(1e-9, amount * 1e-6, 10 ** -displayDecimals(S.pay))
    $('fit-note').hidden = !unused
    $('fit-note').textContent = q.got <= 0 ? `Importo sotto l’offerta più piccola disponibile (${fa(S.pay, q.smallest)} ${S.pay}).`
      : `Le offerte si prendono intere: userai ${fa(S.pay, q.spent)} di ${fa(S.pay, amount)} ${S.pay}.`
    $('over').hidden = !short
    $('over-title').textContent = 'Disponibili ora solo ' + fa(S.pay, q.liq) + ' ' + S.pay
    const b = bal(S.pay), noWallet = b == null, noFunds = b != null && amount > b + 1e-12
    cta.disabled = !!block || amount <= 0 || noFunds || q.got <= 0 || noWallet
    if (block) { t.textContent = block.title; return }
    if (q.got <= 0 && amount > 0 && !noFunds) { t.textContent = short ? 'Nessuna offerta disponibile' : 'Importo troppo piccolo'; return }
    t.textContent = amount <= 0 ? 'Scrivi un importo' : noWallet ? 'Collega il wallet' : noFunds ? 'Saldo ' + S.pay + ' insufficiente' : short ? 'Rivedi lo scambio parziale' : 'Rivedi lo scambio'
    if (noWallet && amount > 0 && q.got > 0) cta.disabled = false // the click opens the wallet sheet
  }

  function renderMake() {
    const k = S.mk, I = mkInfo(), amount = num(k.amount)
    $('mk-give').innerHTML = tok(k.give) ? tokBtn(k.give, 'scegli la moneta che dai') : '—'; $('mk-get').innerHTML = tok(k.get) ? tokBtn(k.get, 'scegli la moneta che ricevi') : '—'
    $('mk-bal').textContent = fbal(k.give)
    const min = $i('mk-in')
    if (document.activeElement !== min) min.value = k.amount
    fit(min, min.value || '0')
    tween($('mk-usd'), usd(k.give, amount) ?? NaN, (v) => fusd(Number.isFinite(v) ? v : null))
    const pub = $('publish') as HTMLButtonElement
    if (!I) {
      $('mk-label').textContent = 'Dai'; $('mk-plabel').textContent = 'Prezzo'; $('mk-price').textContent = '—'
      setHTML($('modes'), ''); $('ticks').innerHTML = ''; $('you').hidden = true; $('custom-wrap').hidden = true
      $('pos-text').textContent = 'Nessun mercato per questa coppia'; $('pos-text').className = 'pos warn'
      $('mk-recv').textContent = '—'; $('mk-fee').textContent = '—'; $('mk-need').textContent = '—'
      $('mk-error').hidden = false; $('mk-error').textContent = markets().length ? 'Scegli due monete che abbiano un mercato.' : 'Nessun mercato disponibile.'; pub.disabled = true
      return
    }
    const { m, sell, price } = I
    $('mk-label').textContent = sell ? 'Vendi' : 'Spendi'
    if (document.activeElement !== $('custom-in')) $i('custom-in').value = k.custom
    $('custom-unit').textContent = m.quote.symbol
    $('mk-plabel').textContent = 'Prezzo per 1 ' + m.base.symbol
    tween($('mk-price'), price, (v) => (v > 0 ? fp(v) + ' ' + m.quote.symbol : '—'))
    const defs: [string, string, string][] = [['market', I.market > 0 ? fp(I.market) : '—', 'Al mercato'], ['fast', I.fast > 0 ? fp(I.fast) : '—', sell ? 'Vendi prima' : 'Compra prima'], ['custom', 'Altro', 'Scegli tu']]
    setHTML($('modes'), defs.map(([id, b, s]) => `<button type="button" class="choice" data-mode="${id}" aria-pressed="${k.mode === id}"${id !== 'custom' && !(I.market > 0) ? ' disabled' : ''}><b>${esc(b)}</b><small>${esc(s)}</small></button>`).join(''))
    $('custom-wrap').hidden = k.mode !== 'custom'
    const all = I.comp.concat(price > 0 ? [price] : [])
    let lo = all.length ? Math.min(...all) : 0, hi = all.length ? Math.max(...all) : 1
    const padv = (hi - lo) * 0.12 || hi * 0.01 || 1; lo -= padv; hi += padv
    const pos = (p: number) => Math.max(0, Math.min(100, ((sell ? p - lo : hi - p) / (hi - lo)) * 100))
    const ahead = (p: number) => (sell ? p < price : p > price)
    $('ticks').innerHTML = I.comp.map((p) => `<span class="tick${ahead(p) ? ' ahead' : ''}" style="left:${pos(p).toFixed(2)}%"></span>`).join('')
    $('you').hidden = !(price > 0)
    if (price > 0) $('you').style.left = pos(price).toFixed(2) + '%'
    const better = I.comp.filter(ahead).length, tie = I.comp.some((p) => Math.abs(p - price) < 1e-12), ptx = $('pos-text')
    if (price <= 0) { ptx.textContent = I.market > 0 ? 'Scrivi un prezzo' : 'Libro vuoto: scegli tu il prezzo'; ptx.className = 'pos' }
    else if (better === 0) { ptx.textContent = tie ? 'Alla pari con la migliore offerta' : 'Sarai la migliore offerta: prima in coda'; ptx.className = 'pos good' }
    else { ptx.textContent = better === 1 ? '1 offerta è più conveniente della tua' : better + ' offerte sono più convenienti della tua'; ptx.className = 'pos warn' }
    setSeg($('exp-seg'), ['1h', '24h', '7d'].indexOf(k.exp)); pressed($('exp-seg'), 'exp', k.exp)
    $i('partial').checked = k.partial
    $('partial-note').textContent = k.priv ? 'Un’offerta privata è in un’unica soluzione' : k.partial ? `In 4 parti da ${fa(k.give, amount / 4)} ${k.give}` : 'Solo in un’unica soluzione'
    $i('partial').disabled = k.priv
    $i('mk-private').checked = k.priv; $('cp-wrap').hidden = !k.priv
    if (document.activeElement !== $('mk-cp')) $i('mk-cp').value = k.cp
    $('parts').innerHTML = '<span></span>'.repeat(k.partial && !k.priv ? 4 : 1)
    const recv = price > 0 ? (sell ? amount * price : amount / price) : 0
    tween($('mk-recv'), recv, (v) => fa(k.get, v) + ' ' + k.get)
    const feeBps = Number(B.protocolFee()) / 10_000
    $('mk-fee').textContent = fa(k.give, amount * feeBps) + ' ' + k.give
    $('mk-fee-l').textContent = `Commissione ${fmt(feeBps * 100, 2, 2)}% (se accettata)`
    $('mk-need').textContent = fa(k.give, amount * (1 + feeBps)) + ' ' + k.give
    // price guard: client priceCheck (warn from 2 %, danger from 10 %, inclusive)
    const mm = I.v.mid, g = guard(sell, price, mm), dev = g.deviationBps / 10_000
    const ge = $('mk-guard')
    ge.hidden = g.level === 'ok'; ge.classList.toggle('danger', g.level === 'danger')
    if (g.level !== 'ok') ge.innerHTML = `<svg class="ic sm" aria-hidden="true"><use href="#i-alert"/></svg><span>Il tuo prezzo è ${fmt(dev * 100, 1, 1)}% ${sell ? 'sotto' : 'sopra'} il mercato (${fp(mm)} ${m.quote.symbol}). I bot prendono subito le offerte così: ${g.level === 'danger' ? 'controlla bene la cifra.' : 'è voluto?'}</span>`
    $('mk-guard-ok-wrap').hidden = g.level !== 'danger'
    if (g.level !== 'ok') $('pos-text').className = 'pos'
    if (g.level !== 'danger') k.ack = false
    $i('mk-guard-ok').checked = k.ack
    $('exp-note').hidden = k.exp !== '7d'
    const b = bal(k.give), block = blocking()
    const err = block ? `${block.title}: ${block.text}` : amount <= 0 ? 'Scrivi quanto vuoi ' + (sell ? 'vendere.' : 'spendere.') : price <= 0 ? 'Scrivi un prezzo valido.'
      : k.priv && !cpAddress() ? (k.cp.trim() ? 'Indirizzo della controparte non valido.' : 'Scrivi l’indirizzo di chi può accettare l’offerta.')
      : k.priv && me() && cpAddress() === me() ? 'La controparte non può essere il tuo stesso indirizzo.'
      : b == null ? 'Collega il wallet per pubblicare.' : amount * (1 + feeBps) > b + 1e-12 ? `Saldo insufficiente: servono ${fa(k.give, amount * (1 + feeBps))} ${k.give}, commissione inclusa.` : ''
    $('mk-error').hidden = !err; $('mk-error').textContent = err
    pub.disabled = (!!err && !(b == null && !block && amount > 0 && price > 0)) || (g.level === 'danger' && !k.ack) || busyPublish
  }

  // ---------------------------------------------------------------- render: markets
  const isStablePair = (m: Market) => m.base.stable && m.quote.stable
  function marketsFiltered(term: string, useFilter: boolean) {
    const q = term.trim().toLowerCase()
    return markets().filter((m) => {
      if (useFilter) {
        if (S.filter === 'USDC' && m.quote.symbol !== 'USDC') return false
        if (S.filter === 'WETH' && m.base.symbol !== 'WETH' && m.quote.symbol !== 'WETH') return false
        if (S.filter === 'stable' && !isStablePair(m)) return false
      }
      if (!q) return true
      return [m.base.symbol, m.quote.symbol, m.base.name, m.quote.name].some((s) => s.toLowerCase().includes(q))
    })
  }
  function mrow(m: Market) {
    const v = view(m), p = v.mid, ch = v.st?.change ?? null, sel = m.id === S.mkt, now = Date.now(), f = mflash.get(m.id)
    const tick = f && now - f.t < 700 ? (f.dir > 0 ? ' tick-up' : ' tick-down') : ''
    const vol = v.st ? usd(m.quote.symbol, v.st.volQuote) : null
    return `<button type="button" class="mrow${sel ? ' sel' : ''}${tick}" data-mkt="${esc(m.id)}"${sel ? ' aria-current="true"' : ''}>${coins2(m.base.symbol, m.quote.symbol, 28)}` +
      `<span class="mr-name"><b>${esc(m.base.symbol)}<span> / ${esc(m.quote.symbol)}</span></b><small>Vol. ${short$(vol)}</small></span>` +
      `<span class="mr-p"><b>${p > 0 ? fp(p) : '—'}</b><small class="${ch == null ? '' : ch >= 0 ? 'up' : 'down'}">${ch == null ? '—' : (ch >= 0 ? '+' : '') + fmt(ch * 100, 2, 2) + '%'}</small></span></button>`
  }
  const emptyMarkets = () => (B.ready() ? '<p class="empty">Nessun mercato disponibile su questa rete.</p>' : '<p class="empty">Bacheca non raggiungibile.</p>')
  function renderRail() {
    const list = marketsFiltered(S.search, true)
    $('m-list').innerHTML = list.length ? list.map(mrow).join('') : markets().length ? '<p class="empty">Nessun mercato trovato</p>' : emptyMarkets()
    $('m-count').textContent = list.length + (list.length === 1 ? ' coppia' : ' coppie')
    pressed($('m-chips'), 'filter', S.filter)
  }
  function renderMPicker() {
    const list = marketsFiltered(S.msearch, false)
    $('mp-list').innerHTML = list.length ? list.map(mrow).join('') : markets().length ? '<p class="empty">Nessun mercato trovato</p>' : emptyMarkets()
  }

  // ---------------------------------------------------------------- render: pair
  function renderPair() {
    const m = byId(S.mkt)
    const center = $('center')
    center.classList.toggle('no-market', !m)
    if (!m) {
      $('ph-name').textContent = '—'; $('ph-desc').textContent = 'Nessun mercato'; $('ph-coins').innerHTML = ''; $('ph-mid').textContent = '—'; $('ph-unit').textContent = ''
      for (const id of ['st-hi', 'st-lo', 'st-vol', 'st-spr', 'st-liq', 'ph-chg']) $(id).textContent = '—'
      $('asks').innerHTML = `<p class="empty">${B.ready() ? 'Nessun mercato su questa rete' : 'Bacheca non raggiungibile'}</p>`; $('bids').innerHTML = ''; $('trades').innerHTML = ''
      $('ob-midp').textContent = ''; $('ob-spr').textContent = ''; renderChart(); return
    }
    const v = view(m), p = v.mid, st = v.st, now = Date.now(), Q = m.quote.symbol, Bs = m.base.symbol
    $('ph-coins').innerHTML = coins2(Bs, Q, 32)
    $('ph-name').textContent = `${Bs} / ${Q}`
    $('ph-desc').textContent = m.base.name
    if (p > 0) tween($('ph-mid'), p, (x) => fp(x)); else $('ph-mid').textContent = '—'
    $('ph-unit').textContent = Q
    const c = $('ph-chg'), ch = st?.change ?? null
    c.className = 'chg ' + (ch == null ? '' : ch >= 0 ? 'up' : 'down'); c.textContent = ch == null ? '—' : (ch >= 0 ? '+' : '') + fmt(ch * 100, 2, 2) + '%'
    $('st-hi').textContent = st?.hi != null ? fp(st.hi) : '—'; $('st-lo').textContent = st?.lo != null ? fp(st.lo) : '—'
    $('st-vol').textContent = st && st.trades ? short$(usd(Q, st.volQuote)) : '—'
    const a = v.asks.find((l) => !l.own)?.p, b = v.bids.find((l) => !l.own)?.p
    $('st-spr').textContent = a && b ? fmt(((a - b) / p) * 100, 2, 2) + '%' : '—'
    const liqQ = v.asks.concat(v.bids).reduce((s, l) => s + l.q * l.p, 0)
    $('st-liq').textContent = liqQ > 0 ? short$(usd(Q, liqQ)) : '—'
    const qa = v.asks.reduce((s, l) => s + l.q, 0), qb = v.bids.reduce((s, l) => s + l.q, 0)
    $('depth-a').style.flexGrow = String(Math.max(qa, 1e-9)); $('depth-b').style.flexGrow = String(Math.max(qb, 1e-9))
    $('liq-a').textContent = fq(Bs, qa) + ' ' + Bs; $('liq-b').textContent = fq(Bs, qb) + ' ' + Bs
    $('ph-buy').textContent = 'Compra ' + Bs; $('ph-sell').textContent = 'Vendi ' + Bs
    document.querySelectorAll('.bh-base').forEach((e) => { e.textContent = Bs })
    document.querySelectorAll('.bh-quote').forEach((e) => { e.textContent = Q })
    // cumulative depth from the best price outward; bars share one scale across both sides
    const cum = (list: Level[]) => { let t = 0; return list.map((l) => (t += l.q)) }
    const ca = cum(v.asks), cb = cum(v.bids), max = Math.max(1e-12, ca[ca.length - 1] || 0, cb[cb.length - 1] || 0), tdec = m.quote.stable ? 0 : qdec(Q)
    const key = (side: string, l: Level) => `${m.id}|${side}|${l.p}`
    const row = (l: Level, side: 'ask' | 'bid', depth: number, i: number) => {
      const fk = flash.get(key(side, l)), fl = fk && now - fk < 1200 ? ' flash' : ''
      // name = the visible cells, then the action for screen readers (WCAG 2.5.3: the name contains the visible text)
      return `<button type="button" class="lvl ${side}${fl}" data-side="${side}" data-i="${i}">` +
        `<span class="lvl-bar" style="width:${Math.round((depth / max) * 100)}%"></span><span class="p">${fp(l.p)}${l.own ? '<span class="you-tag">TU</span>' : ''}</span>` +
        `<span class="r">${fq(Bs, l.q)}</span><span class="r t">${fmt(l.p * l.q, tdec)}</span><span class="sr-only"> · ${side === 'ask' ? 'compra' : 'vendi'} fino a ${fq(Bs, l.q)} ${Bs} a ${fp(l.p)} ${Q}</span></button>`
    }
    $('asks').innerHTML = v.asks.length ? v.asks.map((l, i) => row(l, 'ask', ca[i] as number, i)).reverse().join('') : '<p class="empty">Nessuna offerta di vendita</p>'
    $('bids').innerHTML = v.bids.length ? v.bids.map((l, i) => row(l, 'bid', cb[i] as number, i)).join('') : '<p class="empty">Nessuna offerta di acquisto</p>'
    const mp = $('ob-midp') as HTMLElement & { _t?: ReturnType<typeof setTimeout> }
    if (S._mm === m.id && S._mp && Math.abs(p - S._mp) > 1e-12 && !RM.matches && p > 0) {
      mp.classList.remove('up', 'down'); void mp.offsetWidth; mp.classList.add(p > S._mp ? 'up' : 'down')
      clearTimeout(mp._t); mp._t = setTimeout(() => mp.classList.remove('up', 'down'), 700)
    }
    S._mm = m.id; S._mp = p
    if (p > 0) tween(mp, p, (x) => fp(x)); else mp.textContent = '—'
    $('ob-spr').textContent = a && b ? `Differenza ${fp(a - b)} · ${fmt(((a - b) / p) * 100, 2, 2)}%` : ''
    $('trades').innerHTML = v.trades.length ? v.trades.slice(0, 14).map((t) =>
      `<div class="tr${now - t.ts * 1000 < 1500 ? ' flash' : ''}"><span class="p ${t.side === 'buy' ? 'ask-t' : 'bid-t'}">${fp(t.price)}</span><span class="r">${fq(Bs, t.base)}</span><span class="when">${ago(t.ts * 1000, B.nowSec() * 1000)}</span></div>`).join('')
      : '<p class="empty">Ancora nessuno scambio su questa coppia</p>'
    setSeg($('bt-seg'), S.at === 'book' ? 0 : 1); pressed($('bt-seg'), 'at', S.at); $('bt').dataset.show = S.at
    pressed($('tf'), 'tf', String(S.tf))
    renderChart()
  }

  // ---------------------------------------------------------------- chart: line, right price axis, last-price tag, crosshair
  function chartGeom() {
    const m = byId(S.mkt), all = m ? view(m).hist : [], pts = all.slice(-S.tf - 1), el = $('chart')
    const W = el.clientWidth, H = el.clientHeight, padR = 72, padB = 18, padT = 8
    const ps = pts.map((x) => x.p), lo = Math.min(...ps), hi = Math.max(...ps), span = hi - lo || hi * 0.001 || 1
    const x = (i: number) => (i / Math.max(1, pts.length - 1)) * (W - padR)
    const y = (v: number) => padT + (1 - (v - lo + span * 0.08) / (span * 1.16)) * (H - padT - padB)
    return { m, pts, W, H, padR, padB, lo, hi, span, x, y }
  }
  function renderChart() {
    const el = $('chart')
    if (!el.clientWidth || el.offsetParent === null) return
    const g = chartGeom(), { pts, W, H, padR, padB, x, y, lo, span, m } = g
    const svg = $('ch-svg')
    if (pts.length < 2 || !m) {
      svg.innerHTML = ''; $('ch-labels').innerHTML = `<span class="ch-empty">${m ? 'Ancora nessuno scambio nelle ultime 24 h' : 'Nessun mercato'}</span>`
      el.setAttribute('aria-label', 'Nessuno scambio da mostrare'); return
    }
    const first = pts[0] as { t: number; p: number }, lastPt = pts[pts.length - 1] as { t: number; p: number }
    const up = lastPt.p >= first.p, col = up ? 'var(--up)' : 'var(--down)'
    let d = ''
    pts.forEach((pt, i) => { d += (i ? 'L' : 'M') + x(i).toFixed(1) + ' ' + y(pt.p).toFixed(1) })
    const ticks = [0, 1, 2, 3].map((k) => lo - span * 0.08 + (span * 1.16 * (k + 0.5)) / 4)
    const last = lastPt.p
    svg.setAttribute('viewBox', `0 0 ${W} ${H}`)
    svg.innerHTML = ticks.map((v) => `<line x1="0" x2="${W - padR}" y1="${y(v).toFixed(1)}" y2="${y(v).toFixed(1)}" stroke="rgba(255,255,255,.07)" stroke-width="1"/>`).join('') +
      `<line x1="0" x2="${W - padR}" y1="${y(last).toFixed(1)}" y2="${y(last).toFixed(1)}" stroke="${col}" stroke-width="1" stroke-dasharray="2 4" opacity=".6"/>` +
      `<path d="${d}" fill="none" stroke="var(--fg)" stroke-width="1.5" stroke-linejoin="round" stroke-linecap="round"/>` +
      `<circle cx="${x(pts.length - 1).toFixed(1)}" cy="${y(last).toFixed(1)}" r="3" fill="${col}"/>` +
      `<g id="ch-cross" visibility="hidden"><line id="ch-vx" y1="0" y2="${H - padB}" stroke="rgba(255,255,255,.35)" stroke-width="1"/><circle id="ch-dot" r="3.5" fill="var(--fg)"/></g>`
    const labelsX = [0, 0.5, 1].map((f) => { const i = Math.round(f * (pts.length - 1)); const dt = new Date((pts[i] as { t: number }).t); return { left: x(i), text: dt.toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' }) } })
    $('ch-labels').innerHTML = ticks.filter((v) => Math.abs(y(v) - y(last)) > 16).map((v) => `<span class="ch-y" style="top:${y(v).toFixed(1)}px">${fp(v)}</span>`).join('') +
      labelsX.map((l, i) => `<span class="ch-x" style="left:${Math.min(W - padR - 20, Math.max(20, l.left)).toFixed(0)}px">${i === 2 ? 'ora' : esc(l.text)}</span>`).join('') +
      `<span class="ch-last" style="top:${y(last).toFixed(1)}px;background:${col}">${fp(last)}</span>`
    el.setAttribute('aria-label', `Andamento ${m.base.symbol}/${m.quote.symbol}: da ${fp(first.p)} a ${fp(last)} ${m.quote.symbol}`)
  }
  function chartHover(e: PointerEvent) {
    const el = $('chart'), r = el.getBoundingClientRect(), g = chartGeom()
    if (g.pts.length < 2) return
    const px = Math.max(0, Math.min(g.W - g.padR, e.clientX - r.left)), i = Math.round((px / (g.W - g.padR)) * (g.pts.length - 1)), pt = g.pts[i] as { t: number; p: number }
    const cx = g.x(i), cy = g.y(pt.p), cross = document.getElementById('ch-cross')
    if (!cross) return
    cross.setAttribute('visibility', 'visible')
    $('ch-vx').setAttribute('x1', String(cx)); $('ch-vx').setAttribute('x2', String(cx))
    $('ch-dot').setAttribute('cx', String(cx)); $('ch-dot').setAttribute('cy', String(cy))
    const tip = $('ch-tip'); tip.hidden = false
    tip.textContent = `${fp(pt.p)} ${g.m?.quote.symbol ?? ''} · ${new Date(pt.t).toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' })}`
    tip.style.left = Math.min(g.W - g.padR - tip.offsetWidth, Math.max(0, cx - tip.offsetWidth / 2)) + 'px'
  }
  function chartLeave() { document.getElementById('ch-cross')?.setAttribute('visibility', 'hidden'); $('ch-tip').hidden = true }

  // ---------------------------------------------------------------- render: offers
  const mids = () => Object.fromEntries(markets().map((m) => [m.id, mid(m)]))
  function offerData(): { live: OfferView[]; history: HistoryItem[] } { return groupOffers(B.myOrders(), markets(), mids(), B.nowSec()) }
  function segbar(o: OfferView) {
    let h = ''
    for (let i = 0; i < o.parts; i++) h += `<span class="${i < o.filled ? 'done' : o.status === 'paused' ? (i < o.filled + o.funded ? 'wait' : 'pause') : ''}"></span>`
    return `<div class="segbar" style="grid-template-columns:repeat(${o.parts},minmax(0,1fr))" aria-hidden="true">${h}</div>`
  }
  function offersHTML() {
    const { live, history } = offerData()
    let h = `<div class="chips" role="group" aria-label="Filtro offerte" style="padding: var(--s1) var(--s2) var(--s2)"><button type="button" class="chip" data-of="attive" aria-pressed="${S.ofilter === 'attive'}">Attive · ${live.length}</button><button type="button" class="chip" data-of="storico" aria-pressed="${S.ofilter === 'storico'}">Storico</button></div>`
    if (!me()) return h + '<div class="empty">Collega il wallet per vedere le tue offerte.<br><button type="button" class="btn" data-go="wallet" style="margin-top: var(--s3)">Collega il wallet</button></div>'
    if (S.ofilter === 'storico') {
      return h + (history.length ? `<div class="hist">${history.map((x) => `<div class="hist-row"><span>${esc(x.t)}</span><span>${esc(x.s)} · ${esc(ago(x.at))}</span></div>`).join('')}</div>` : '<p class="empty">Ancora nessuno scambio concluso.</p>')
    }
    if (!live.length) return h + '<div class="empty">Nessuna offerta attiva.<br><button type="button" class="btn" data-go="make" style="margin-top: var(--s3)">Proponi un prezzo</button></div>'
    h += '<div class="offers">' + live.map((o) => {
      const m = o.market, Bs = m.base.symbol, Q = m.quote.symbol, quoteAmt = o.baseAmt * o.price
      const title = o.side === 'sell' ? `Vendi ${fq(Bs, o.baseAmt)} ${Bs}` : `Compra ${fq(Bs, o.baseAmt)} ${Bs}`
      const sub = `${o.side === 'sell' ? 'per' : 'con'} ${fa(Q, quoteAmt)} ${Q} · ${fp(o.price)} l’uno`
      const status = o.status === 'active' ? '<span class="status ok">Attiva</span>' : o.status === 'paused' ? '<span class="status warn">In pausa</span>'
        : o.status === 'resign' ? '<span class="status warn">Da rifirmare</span>' : '<span class="status warn">Ancora eseguibile</span>'
      const mm = mids()[m.id] ?? 0
      const staleNote = o.stale ? `<p class="o-stale">Il mercato si è spostato: ora ${fp(mm)} ${Q}. Chi accetta guadagna ${fmt((Math.abs(mm - o.price) / mm) * 100, 1, 1)}% su di te. Valuta di annullarla e rifarla.</p>` : ''
      const info = staleNote + (o.status === 'active' ? `<div class="o-meta"><span>${o.parts > 1 ? `Eseguite ${o.filled} su ${o.parts}` : 'In attesa di chi accetta'}</span><span>Scade ${esc(until(o.expiry, B.nowSec()))}</span></div>`
        : o.status === 'paused' ? `<p class="o-note">Il saldo copre ${o.funded} parti su ${o.parts - o.filled}: le altre restano nascoste finché non aggiungi fondi.</p>`
        : o.status === 'resign' ? '<p class="o-note">La commissione della piattaforma è cambiata. Rifirma per rimetterla in vendita, senza costi.</p>'
        : '<p class="o-stale">Questa offerta può ancora essere eseguita: annullala. La bacheca non la mostra più, ma la firma è di nuovo valida sulla blockchain e chiunque ne abbia una copia può usarla.</p>')
      const act = o.status === 'active' ? `<button type="button" class="btn block" data-act="cancel" data-key="${esc(o.key)}"><svg class="ic sm" aria-hidden="true"><use href="#i-shield"/></svg>${o.filled > 0 ? 'Annulla il resto' : 'Annulla'}</button>`
        : o.status === 'paused' ? `<button type="button" class="btn accent block" data-act="fund" data-key="${esc(o.key)}">Aggiungi fondi</button>`
        : o.status === 'resign' ? `<button type="button" class="btn accent block" data-act="resign" data-key="${esc(o.key)}">Rifirma · gratis</button>`
        : `<button type="button" class="btn accent block" data-act="cancel" data-key="${esc(o.key)}"><svg class="ic sm" aria-hidden="true"><use href="#i-shield"/></svg>Annulla ora</button>`
      const priv = o.privateFor ? `<div class="o-meta o-priv"><span>Privata per <span class="mono">${esc(shortAddr(o.privateFor))}</span></span><button type="button" class="linkbtn" data-act="link" data-hash="${esc(o.orders[0]?.hash ?? '')}">Copia link</button></div>` : ''
      return `<article class="offer${o.status !== 'active' ? ' attn' : ''}" data-offer="${esc(o.status)}"${o.privateFor ? ' data-private="1"' : ''}><div class="o-top"><div><div class="o-mkt">${coins2(Bs, Q, 18)}${esc(Bs)} / ${esc(Q)}</div><div class="o-title">${esc(title)}</div><div class="o-sub">${esc(sub)}</div></div>${status}</div>${o.parts > 1 ? segbar(o) : ''}${info}${priv}${act}</article>`
    }).join('') + '</div>'
    h += S.confirmAll
      ? `<div class="confirm-all"><b>Annullare tutte le ${live.length} offerte?</b><span class="o-note">Una sola transazione le invalida sulla blockchain. ${esc(protNote())}</span><div class="two"><button type="button" class="btn" data-ca="no">Tieni</button><button type="button" class="btn accent" data-ca="yes">Annulla tutte</button></div></div>`
      : '<button type="button" class="btn ghost block" data-ca="ask"><svg class="ic sm" aria-hidden="true"><use href="#i-shield"/></svg>Annulla tutte · 1 transazione</button>'
    return h
  }
  const protNote = () => { const p = B.protection(); return p.protected ? (p.level === 'l2' ? 'Su questa rete non c’è una mempool pubblica.' : `Invio protetto: ${p.title}.`) : 'Attenzione: il tuo wallet invia dalla mempool pubblica.' }
  function renderOffers() {
    const html = offersHTML()
    $('offers-d').innerHTML = html; $('offers-m-list').innerHTML = html
    const attn = me() ? offerData().live.filter((o) => o.status !== 'active').length : 0
    for (const id of ['badge', 'act-badge']) { $(id).hidden = attn === 0; $(id).textContent = String(attn) }
  }

  // ---------------------------------------------------------------- nav
  function renderNav(animate: boolean) {
    const w2 = MQ2.matches, w3 = MQ3.matches
    const tabCls = S.tabDir > 0 ? 'from-r' : S.tabDir < 0 ? 'from-l' : 'enter'
    reveal($('rail'), w3 || (!w2 && S.tab === 'markets' && !S.detail), animate && !w2, S.detail === false && S.tab === 'markets' && S.tabDir === 0 ? 'from-l' : tabCls)
    reveal($('center'), w2 || (S.tab === 'markets' && S.detail), animate && !w2, 'from-r')
    reveal($('ticket'), w2 || S.tab === 'swap', animate && !w2, tabCls)
    reveal($('offers-m'), !w2 && S.tab === 'offers', animate && !w2, tabCls)
    $('back').hidden = w2
    $('act-card').hidden = !w2
    const dock = $('dock')
    setSeg(dock, ['swap', 'markets', 'offers'].indexOf(S.tab))
    dock.querySelectorAll('button').forEach((b) => (b.dataset.tab === S.tab ? b.setAttribute('aria-current', 'page') : b.removeAttribute('aria-current')))
    setSeg($('mode-seg'), S.mode === 'swap' ? 0 : 1); pressed($('mode-seg'), 'm', S.mode)
    reveal($('m-swap'), S.mode === 'swap', animate, 'from-l')
    reveal($('m-make'), S.mode === 'make', animate, 'from-r')
  }
  function renderHeader() {
    const p = B.protection(), a = me()
    $('wal-addr').textContent = a ? shortAddr(a) : 'Collega'
    $('wal-dot').classList.toggle('off', !p.protected)
    $('wal-dot').hidden = !a
    $('net-lbl').textContent = B.chains().find((c) => c.id === B.chainId())?.name ?? String(B.chainId())
  }
  function render(animate = true) { ensureSelection(); renderHeader(); renderBanners(); renderNav(animate); renderSwap(); renderMake(); renderRail(); renderPair(); renderOffers() }

  const top = () => window.scrollTo({ top: 0, behavior: RM.matches ? 'auto' : 'smooth' })
  const TABS: Tab[] = ['swap', 'markets', 'offers']
  function goTab(tab: Tab) {
    S.tabDir = Math.sign(TABS.indexOf(tab) - TABS.indexOf(S.tab))
    if (tab === 'markets' && S.tab === 'markets') S.detail = false
    S.tab = tab; save(); render(); top()
    if (tab === 'markets' && !S.detail) cascade($('m-list'))
    if (tab === 'offers') cascade($('offers-m-list').querySelector('.offers'))
    S.tabDir = 0
  }
  function setMode(mode: 'swap' | 'make') { S.mode = mode; syncMarket(); save(); render() }
  function selectMarket(id: string, openDetail: boolean) {
    const m = byId(id); if (!m) return
    S.mkt = id; B.focus(id)
    if (findMarket(S.pay, S.recv) !== m) { S.pay = m.quote.symbol; S.recv = m.base.symbol; S.amount = '' }
    if (findMarket(S.mk.give, S.mk.get) !== m) { S.mk.give = m.base.symbol; S.mk.get = m.quote.symbol; S.mk.amount = ''; S.mk.custom = ''; S.mk.mode = 'market' }
    if (!MQ2.matches && openDetail) { S.detail = true; S.tab = 'markets' }
    save(); render()
    if (!MQ2.matches && openDetail) top()
  }

  // ---------------------------------------------------------------- sheets (focus trap, Esc, return focus)
  const openSheets = new Set<string>()
  let lastFocus: HTMLElement | null = null
  function openSheet(id: string, focusEl?: HTMLElement) {
    const s = $(id); lastFocus = document.activeElement as HTMLElement | null; s.hidden = false; openSheets.add(id)
    // focus once the sheet is shown: focusing inside a still-invisible sheet fails silently (focus stayed on the page)
    requestAnimationFrame(() => requestAnimationFrame(() => {
      s.classList.add('open')
      if (openSheets.has(id)) (focusEl || (s.querySelector('button') as HTMLElement)).focus({ preventScroll: true })
    }))
  }
  function closeSheet(id: string) {
    if (!openSheets.has(id)) return
    const s = $(id); openSheets.delete(id); s.classList.remove('open')
    setTimeout(() => { if (!openSheets.has(id)) s.hidden = true }, RM.matches ? 0 : 340)
    lastFocus?.focus?.({ preventScroll: true })
  }
  /** Tab stops of a sheet: visible, enabled, and one per radio group (the checked one, else the first) — as the browser tabs. */
  const tabStops = (root: HTMLElement): HTMLElement[] => {
    const all = [...root.querySelectorAll<HTMLElement>('button:not([disabled]),input:not([disabled]),a[href],select,textarea,[tabindex]:not([tabindex="-1"])')].filter((x) => x.checkVisibility({ visibilityProperty: true }))
    const groups = new Set<string>()
    return all.filter((x) => {
      if (!(x instanceof HTMLInputElement) || x.type !== 'radio' || !x.name) return true
      if (groups.has(x.name)) return false
      const pick = all.find((y) => y instanceof HTMLInputElement && y.type === 'radio' && y.name === x.name && y.checked) ?? x
      if (pick !== x) return false
      groups.add(x.name); return true
    })
  }
  let tabBack = false
  // safety net: whatever moves focus out of the open sheet (a tab stop we did not foresee), bring it back in
  document.addEventListener('focusin', (e) => {
    const open = [...openSheets].pop(); if (!open) return
    const s = $(open); if (s.contains(e.target as Node)) return
    const f = tabStops(s); (tabBack ? f[f.length - 1] : f[0])?.focus({ preventScroll: true })
  })
  document.addEventListener('keydown', (e) => {
    const open = [...openSheets].pop()
    if (e.key === 'Tab') tabBack = e.shiftKey
    if (e.key === 'Tab' && open) {
      // keep keyboard focus inside the open sheet
      const f = tabStops($(open))
      if (!f.length) return
      const first = f[0] as HTMLElement, last = f[f.length - 1] as HTMLElement
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus() } else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus() }
      return
    }
    if (e.key !== 'Escape') return
    if (openSheets.has('ssheet')) closeSheet('ssheet')
    else if (openSheets.has('wsheet')) closeSheet('wsheet')
    else if (openSheets.has('picker')) closeSheet('picker')
    else if (openSheets.has('mpicker')) closeSheet('mpicker')
    else if (openSheets.has('confirm') && !busy) { pending = null; closeSheet('confirm') }
  })

  // ---------------------------------------------------------------- events: navigation & markets
  $('dock').addEventListener('click', (e) => { const b = (e.target as Element).closest<HTMLElement>('[data-tab]'); if (b) goTab(b.dataset.tab as Tab) })
  $('back').addEventListener('click', () => { S.detail = false; S.tabDir = -1; render(); top(); S.tabDir = 0; cascade($('m-list')) })
  $('mode-seg').addEventListener('click', (e) => { const b = (e.target as Element).closest<HTMLElement>('[data-m]'); if (b) setMode(b.dataset.m as 'swap' | 'make') })
  $('bt-seg').addEventListener('click', (e) => {
    const b = (e.target as Element).closest<HTMLElement>('[data-at]'); if (!b) return
    S.at = b.dataset.at as 'book' | 'trades'; save(); renderPair()
    const pane = $('bt').querySelector(S.at === 'book' ? '.ob' : '.tw') as HTMLElement
    pane.classList.remove('from-l', 'from-r'); void pane.offsetWidth; pane.classList.add(S.at === 'book' ? 'from-l' : 'from-r')
  })
  $('tf').addEventListener('click', (e) => { const b = (e.target as Element).closest<HTMLElement>('[data-tf]'); if (b) { S.tf = Number(b.dataset.tf); renderPair() } })
  $('chart').addEventListener('pointermove', chartHover)
  $('chart').addEventListener('pointerdown', chartHover)
  $('chart').addEventListener('pointerleave', chartLeave)
  if (window.ResizeObserver) new ResizeObserver(() => renderChart()).observe($('chart'))
  $('m-search').addEventListener('input', (e) => { S.search = (e.target as HTMLInputElement).value; renderRail() })
  $('m-chips').addEventListener('click', (e) => { const b = (e.target as Element).closest<HTMLElement>('[data-filter]'); if (b) { S.filter = b.dataset.filter as string; renderRail() } })
  $('m-list').addEventListener('click', (e) => { const b = (e.target as Element).closest<HTMLElement>('[data-mkt]'); if (b) selectMarket(b.dataset.mkt as string, true) })
  $('pair-btn').addEventListener('click', () => { S.msearch = ''; $i('mp-search').value = ''; renderMPicker(); openSheet('mpicker', $('mp-search')) })
  $('mp-search').addEventListener('input', (e) => { S.msearch = (e.target as HTMLInputElement).value; renderMPicker() })
  $('mp-list').addEventListener('click', (e) => { const b = (e.target as Element).closest<HTMLElement>('[data-mkt]'); if (b) { closeSheet('mpicker'); selectMarket(b.dataset.mkt as string, false) } })
  $('mp-close').addEventListener('click', () => closeSheet('mpicker'))
  $('mpicker').addEventListener('click', (e) => { if (e.target === $('mpicker')) closeSheet('mpicker') })
  MQ2.addEventListener('change', () => renderNav(false))
  MQ3.addEventListener('change', () => renderNav(false))

  function trade(side: 'buy' | 'sell') {
    const m = byId(S.mkt); if (!m) return
    if (side === 'buy') { S.pay = m.quote.symbol; S.recv = m.base.symbol } else { S.pay = m.base.symbol; S.recv = m.quote.symbol }
    S.amount = ''; S.mode = 'swap'
    if (!MQ2.matches) S.tab = 'swap'
    save(); render(); if (!MQ2.matches) top(); ping()
    if (MQ2.matches) $('pay-in').focus({ preventScroll: true })
  }
  $('ph-buy').addEventListener('click', () => trade('buy'))
  $('ph-sell').addEventListener('click', () => trade('sell'))
  $('center').addEventListener('click', (e) => {
    const r = (e.target as Element).closest<HTMLElement>('.lvl'); if (!r) return
    const m = byId(S.mkt); if (!m) return
    const v = view(m), side = r.dataset.side as 'ask' | 'bid', list = side === 'ask' ? v.asks : v.bids, l = list[Number(r.dataset.i)]
    if (!l) return
    if (l.own) { toast('È una tua offerta', 'La trovi in Le mie offerte'); return }
    let total = 0
    for (const x of list) { if (x.own) continue; if (side === 'ask' ? x.p > l.p : x.p < l.p) break; total += side === 'ask' ? x.q * x.p : x.q }
    if (side === 'ask') { S.pay = m.quote.symbol; S.recv = m.base.symbol } else { S.pay = m.base.symbol; S.recv = m.quote.symbol }
    S.amount = fa(S.pay, total); S.mode = 'swap'
    if (!MQ2.matches) S.tab = 'swap'
    save(); $i('pay-in').value = S.amount; render(); if (!MQ2.matches) top(); ping()
  })

  // ---------------------------------------------------------------- events: swap
  for (const [id, get, set, tk] of [['pay-in', () => S.amount, (v: string) => { S.amount = v }, () => S.pay], ['mk-in', () => S.mk.amount, (v: string) => { S.mk.amount = v }, () => S.mk.give]] as const) {
    $(id).addEventListener('blur', () => { const n = num(get()); if (n > 0) { set(fa(tk(), n)); $i(id).value = get(); render(false) } })
  }
  $('pay-in').addEventListener('input', (e) => { const t = e.target as HTMLInputElement, v = clean(t.value); if (v !== t.value) t.value = v; S.amount = v; renderSwap() })
  document.querySelectorAll<HTMLElement>('.qb').forEach((b) => b.addEventListener('click', () => {
    const x = bal(S.pay); if (x == null) { openW(); return }
    S.amount = fa(S.pay, x * parseFloat(b.dataset.q as string)); $i('pay-in').value = S.amount; renderSwap()
  }))
  $('flip').addEventListener('click', () => {
    const q = quote()
    ;[S.pay, S.recv] = [S.recv, S.pay]
    S.amount = q.ok && q.got > 0 ? fa(S.pay, q.got) : ''
    S.rot += 180; $('flip').style.setProperty('--rot', S.rot + 'deg')
    $i('pay-in').value = S.amount; render()
  })
  $('sum-btn').addEventListener('click', () => { S.details = !S.details; $('details').classList.toggle('open', S.details); $('sum-btn').setAttribute('aria-expanded', String(S.details)) })
  $('over').addEventListener('click', () => {
    const q = quote(); S.mk.give = S.pay; S.mk.get = S.recv; S.mk.amount = fa(S.pay, q.left); S.mk.mode = 'market'; S.mk.custom = ''
    setMode('make')
  })

  // token picker: only coins that have a market
  let pickTarget: 'pay' | 'recv' | 'give' | 'get' = 'pay'
  const curOf = (t: string) => ({ pay: S.pay, recv: S.recv, give: S.mk.give, get: S.mk.get } as Record<string, string>)[t] as string
  const otherOf = (t: string) => ({ pay: S.recv, recv: S.pay, give: S.mk.get, get: S.mk.give } as Record<string, string>)[t] as string
  function renderPicker() {
    const cur = curOf(pickTarget), other = otherOf(pickTarget), needMkt = pickTarget === 'recv' || pickTarget === 'get', q = S.psearch.trim().toLowerCase()
    const list = [...tokens().values()].filter((t) => !q || t.symbol.toLowerCase().includes(q) || t.name.toLowerCase().includes(q))
    $('p-list').innerHTML = list.length ? list.map((t) => {
      const has = t.symbol === other || !!findMarket(t.symbol, other), dis = needMkt && (!has || t.symbol === other)
      const sub = dis ? (t.symbol === other ? 'È già l’altra moneta' : 'Nessun mercato con ' + other) : t.name
      const b = bal(t.symbol), u = b == null ? null : usd(t.symbol, b)
      return `<button type="button" class="coin-item" data-t="${esc(t.symbol)}" aria-pressed="${t.symbol === cur}"${dis ? ' disabled' : ''}>${coin(t.symbol)}<span class="grow"><b>${esc(t.symbol)}</b><small>${esc(sub)}</small></span><span class="bal">${b == null ? '—' : fa(t.symbol, b)}<small>${fusd(u)}</small></span></button>`
    }).join('') : '<p class="empty">Nessuna moneta trovata</p>'
  }
  function openPicker(target: typeof pickTarget) {
    pickTarget = target; S.psearch = ''; $i('p-search').value = ''
    $('p-title').textContent = { pay: 'Moneta da pagare', recv: 'Moneta da ricevere', give: 'Moneta che dai', get: 'Moneta che ricevi' }[target]
    renderPicker(); openSheet('picker', $('p-search'))
  }
  $('pay-tok').addEventListener('click', () => openPicker('pay'))
  $('recv-tok').addEventListener('click', () => openPicker('recv'))
  $('mk-give').addEventListener('click', () => openPicker('give'))
  $('mk-get').addEventListener('click', () => openPicker('get'))
  $('p-search').addEventListener('input', (e) => { S.psearch = (e.target as HTMLInputElement).value; renderPicker() })
  $('p-close').addEventListener('click', () => closeSheet('picker'))
  $('picker').addEventListener('click', (e) => { if (e.target === $('picker')) closeSheet('picker') })
  $('p-list').addEventListener('click', (e) => {
    const b = (e.target as Element).closest<HTMLButtonElement>('[data-t]'); if (!b || b.disabled) return
    const t = b.dataset.t as string, k = S.mk
    if (pickTarget === 'pay') { if (t === S.recv) S.recv = S.pay; S.pay = t; if (!findMarket(S.pay, S.recv)) S.recv = preferredQuote(S.pay); S.amount = '' }
    else if (pickTarget === 'recv') S.recv = t
    else if (pickTarget === 'give') { if (t === k.get) k.get = k.give; k.give = t; if (!findMarket(k.give, k.get)) k.get = preferredQuote(k.give); k.amount = ''; k.custom = ''; k.mode = 'market' }
    else { k.get = t; k.custom = ''; k.mode = 'market' }
    syncMarket(); closeSheet('picker'); save(); render()
  })

  // ---------------------------------------------------------------- confirm: verify → approve → one transaction per order (real taker)
  type OSt = LegStatus
  const OS: Record<OSt, [string, string]> = { wait: ['In coda', ''], verify: ['Verifica…', 'run'], sign: ['Firma nel wallet…', 'run'], pending: ['In conferma…', 'run'],
    done: ['Eseguita', 'ok'], skipped: ['Già presa · nessun costo', 'bad'], dropped: ['Presa prima di te · non inclusa, nessun costo', 'bad'], failed: ['Presa prima di te · gas pagato', 'bad'] }
  interface Pend { m: Market; buy: boolean; pay: string; recv: string; orders: { hash: string; p: number; base: number; pay: number; out: number; st: OSt }[]; verified: VerifiedQuote | null; plan: NonNullable<SwapQuote['plan']> }
  let busy = false, busyPublish = false
  let pending: Pend | null = null
  const wait = (ms: number) => new Promise((r) => setTimeout(r, RM.matches ? 0 : ms))
  function setStep(id: string, s: string, txt: string) { const el = $(id); el.dataset.s = s; (el.querySelector('small') as HTMLElement).textContent = txt }
  const active = (P: Pend) => P.orders.filter((o) => o.st !== 'skipped')
  function renderOrders(P: Pend) {
    const Bs = P.m.base.symbol
    $('c-olist').innerHTML = P.orders.map((o, i) => {
      const [t, cls] = OS[o.st], spin = cls === 'run' ? '<span class="spin" aria-hidden="true"></span>' : ''
      return `<div class="orow${o.st === 'skipped' ? ' gone' : ''}" data-st="${o.st}"><span>${i + 1}. ${fq(Bs, o.base)} ${Bs} a ${fp(o.p)}</span><span class="os ${cls}">${spin}${t}</span></div>`
    }).join('')
  }
  function renderTotals(P: Pend) {
    const a = active(P), spent = a.reduce((s, o) => s + o.pay, 0), got = a.reduce((s, o) => s + o.out, 0)
    $('c-pay').innerHTML = amtHTML(spent, displayDecimals(P.pay)); $('c-recv').innerHTML = amtHTML(got, displayDecimals(P.recv))
    $('c-avg').textContent = got > 0 ? `${fp(P.buy ? spent / got : got / spent)} ${P.m.quote.symbol} per ${P.m.base.symbol}` : '—'
    $('c-legs').textContent = a.length === 1 ? '1 · una transazione' : a.length + ' · una transazione ciascuna'
    return { spent, got }
  }
  function renderMev() {
    const st = B.protection()
    $('c-mev').innerHTML = `<span class="mev-row"><span class="mev${st.protected ? '' : ' off'}"><svg class="ic sm" aria-hidden="true"><use href="#${st.protected ? 'i-shield' : 'i-alert'}"/></svg>${esc(st.protected ? (st.level === 'l2' ? 'Non serve (L2)' : st.title) : 'Mempool pubblica')}</span><button type="button" class="linkbtn" data-wsheet>${st.protected ? 'Dettagli' : 'Attivala'}</button></span>`
  }
  const units = (v: bigint, d: number) => Number(formatUnits(v, d))

  $('review').addEventListener('click', async () => {
    const q = quote(); if (!q.ok || !q.m || q.got <= 0 || ($('review') as HTMLButtonElement).disabled || !q.plan) return
    if (!me()) { openW(); return }
    const m = q.m, buy = q.buy, payT = buy ? m.quote : m.base, recvT = buy ? m.base : m.quote
    const book = B.bookOf(m.id) ?? { asks: [], bids: [] }, side = buy ? book.asks : book.bids
    const P: Pend = { m, buy, pay: S.pay, recv: S.recv, verified: null, plan: q.plan,
      orders: q.plan.legs.map((l) => { const e = side.find((x) => x.hash === l.hash); return { hash: l.hash, p: e?.price ?? 0, base: units(buy ? l.order.signerAmount : l.order.senderAmount, m.base.decimals),
        pay: units(l.order.senderAmount, payT.decimals), out: units(l.order.signerAmount, recvT.decimals), st: 'wait' as OSt } }) }
    await runConfirm(P)
  })

  /** Confirmation sheet for a plan (from the book, or a private offer): verify → authorize → one transaction per order. */
  async function runConfirm(P: Pend) {
    pending = P
    if (!P.plan.legs.some((l) => l.order.senderWallet !== '0x0000000000000000000000000000000000000000')) $('c-title').textContent = 'Conferma lo scambio'
    $('c-pay-tok').innerHTML = coin(P.pay, 26) + esc(P.pay); $('c-recv-tok').innerHTML = coin(P.recv, 26) + esc(P.recv)
    { const q0 = quoteState(null, P.orders.length); $('c-qs').className = 'qs ' + q0.cls; $('c-qs').textContent = q0.label; $('c-qs-t').textContent = q0.text }
    $('c-recip').textContent = shortAddr(me()); $('c-contract').textContent = 'SwapERC20 ' + shortAddr(B.swapAddress()); $('c-contract').title = B.swapAddress() ?? ''
    $('c-gas').textContent = '—'
    ;($('st1').querySelector('b') as HTMLElement).textContent = 'Autorizza ' + P.pay
    setStep('st0', 'busy', 'Firme, scadenze e fondi delle offerte…'); setStep('st1', 'idle', 'Una firma nel wallet'); setStep('st2', 'idle', 'In attesa')
    $('c-appr').hidden = false
    $('c-main').hidden = false; $('c-done').hidden = true; ($('c-go') as HTMLButtonElement).disabled = true; $('c-go-t').textContent = 'Verifica in corso…'
    $('c-race-wrap').hidden = !B.demo
    renderTotals(P); renderOrders(P); renderMev()
    openSheet('confirm', $('c-close'))
    // verify: one batched read (SwapERC20.check per order + own balance/allowance) at the current block
    let v: VerifiedQuote
    try { v = await B.taker(() => {}).verify(P.plan) } catch (e) {
      if (pending !== P) return
      setStep('st0', 'idle', `Verifica non riuscita: ${(e as Error).message}`); $('c-go-t').textContent = 'Riprova'; ($('c-go') as HTMLButtonElement).disabled = true; return
    }
    if (pending !== P) return
    P.verified = v
    const dropped = new Set(v.dropped.map((d) => d.hash))
    for (const o of P.orders) if (dropped.has(o.hash)) o.st = 'skipped'
    const { spent } = renderTotals(P); renderOrders(P)
    const qs = quoteState(v, P.orders.length, (b) => fmt(Number(b), 0))
    $('c-qs').className = 'qs ' + qs.cls; $('c-qs').textContent = qs.label; $('c-qs-t').textContent = qs.text
    setStep('st0', qs.verifyStep.done ? 'done' : 'idle', qs.verifyStep.text)
    $('c-appr').hidden = !qs.needsApproval
    if (!qs.needsApproval) setStep('st1', 'done', 'Già autorizzato')
    ;($('c-go') as HTMLButtonElement).disabled = qs.go.disabled; $('c-go-t').textContent = qs.go.label
    if (spent > 0) void B.estimateGasWei(v).then((w) => { if (pending === P) $('c-gas').textContent = w == null ? '—' : `≈ ${fmt(Number(formatUnits(w, 18)), 6)} ETH per offerta` })
    $('c-go').focus({ preventScroll: true })
  }

  $('c-go').addEventListener('click', async () => {
    const P = pending
    if (busy || !P || !P.verified) return
    busy = true; ($('c-go') as HTMLButtonElement).disabled = true; ($('c-close') as HTMLButtonElement).disabled = true
    const exact = (document.querySelector('input[name="appr"]:checked') as HTMLInputElement | null)?.value !== 'max'
    const byHash = new Map(P.orders.map((o) => [o.hash, o]))
    let stopMsg = ''
    const onUpdate = (e: TakerEvent) => {
      const legOf = (x: { orderHash?: string }) => (x.orderHash ? byHash.get(x.orderHash) : undefined)
      switch (e.type) {
        case 'approval_reset': setStep('st1', 'busy', 'Azzero la vecchia autorizzazione (richiesto dal token)…'); break
        case 'approving': setStep('st1', 'busy', 'Conferma nel wallet…'); $('c-go-t').textContent = 'Autorizzazione…'; break
        case 'simulating': {
          if ($('st1').dataset.s !== 'done') setStep('st1', 'done', exact ? 'Autorizzato solo questo importo' : 'Autorizzazione illimitata')
          $('c-appr').hidden = true; setStep('st2', 'busy', `Offerta ${e.leg + 1} di ${e.of} · ultima verifica prima dell’invio`); $('c-go-t').textContent = 'Scambio in corso…'
          break
        }
        case 'awaiting_signature': setStep('st2', 'busy', `Offerta ${e.leg + 1} di ${e.of} · firma nel wallet`); break
        case 'pending': if (e.orderHash) setStep('st2', 'busy', `Offerta ${(e.leg ?? 0) + 1} di ${e.of} · in attesa di conferma on-chain`); break
        case 'rejected': stopMsg = 'Firma rifiutata nel wallet: le offerte restanti non sono state inviate.'; break
        case 'cancelled': stopMsg = 'Transazione annullata dal wallet: le offerte restanti non sono state inviate.'; break
        case 'replaced': stopMsg = 'Transazione sostituita nel wallet: le offerte restanti non sono state inviate.'; break
        case 'timeout': stopMsg = 'Nessuna conferma entro il tempo limite: controlla il wallet prima di riprovare.'; break
        case 'blocked': stopMsg = `Invio bloccato per sicurezza: ${e.message}`; break
        case 'private_unavailable': stopMsg = 'Invio protetto non disponibile: nessuna transazione inviata.'; break
        default: break
      }
      const st = legStatus(e), o = st && 'orderHash' in e ? legOf(e as { orderHash?: string }) : undefined
      if (o && st) o.st = st
      renderOrders(P)
    }
    let r: ExecuteResult | null = null
    try { r = await B.taker(onUpdate).execute(P.verified, { approval: exact ? 'exact' : 'max' }) } catch (e) { stopMsg = `Errore: ${(e as Error).message}` }
    const filled = P.orders.filter((o) => o.st === 'done'), skipped = P.orders.filter((o) => o.st === 'skipped'), failed = P.orders.filter((o) => o.st === 'failed'), dropped = P.orders.filter((o) => o.st === 'dropped')
    const gotU = r ? units(r.received, (P.buy ? P.m.base : P.m.quote).decimals) : 0, spentU = r ? units(r.paid, (P.buy ? P.m.quote : P.m.base).decimals) : 0
    setStep('st2', filled.length ? 'done' : 'idle', filled.length === P.orders.length ? 'Completato' : `${filled.length} offerte su ${P.orders.length} eseguite`)
    pending = null
    const all = filled.length === P.orders.length, none = filled.length === 0
    $('c-done').classList.toggle('none', none)
    $('c-done-h').textContent = all ? 'Scambio completato' : none ? 'Nessuno scambio eseguito' : 'Scambio parziale completato'
    $('c-done-amt').textContent = none ? '' : '+' + fa(P.recv, gotU) + ' ' + P.recv
    const gas = r && r.gasCostWei > 0n ? ` · costo di rete ${fmt(Number(formatUnits(r.gasCostWei, 18)), 6)} ETH` : ''
    $('c-done-sub').textContent = none ? 'I tuoi fondi non sono stati toccati.' + (r && r.gasCostWei > 0n ? ` Hai pagato solo il costo di rete (${fmt(Number(formatUnits(r.gasCostWei, 18)), 6)} ETH).` : '') : `Pagati ${fa(P.pay, spentU)} ${P.pay} · ricevuti sul tuo wallet${gas}`
    const lines: string[] = []
    if (skipped.length) lines.push(skipped.length === 1 ? '1 offerta era già stata presa prima dell’invio: saltata, nessun costo.' : `${skipped.length} offerte erano già state prese prima dell’invio: saltate, nessun costo.`)
    if (dropped.length) lines.push(`${dropped.length === 1 ? '1 offerta è stata presa' : dropped.length + ' offerte sono state prese'} da un altro prima di te: grazie all’invio protetto la tua transazione non è stata inclusa, nessun costo.`)
    if (failed.length) lines.push(`${failed.length === 1 ? '1 offerta è stata presa' : failed.length + ' offerte sono state prese'} da un altro nello stesso blocco: transazione fallita, hai pagato il costo di rete. Con l’invio protetto non succede.`)
    if (stopMsg) lines.push(stopMsg)
    if (!all) lines.push('Per il resto puoi rifare la quotazione o proporre tu un prezzo.')
    $('c-done-list').innerHTML = lines.map((t) => `<p><svg class="ic sm" aria-hidden="true"><use href="#i-alert"/></svg><span>${esc(t)}</span></p>`).join('')
    $('c-main').hidden = true; reveal($('c-done'), true, true); ($('confirm').querySelector('.sheet') as HTMLElement).scrollTop = 0
    busy = false; ($('c-close') as HTMLButtonElement).disabled = false; $('c-done-btn').focus({ preventScroll: true })
    S.amount = ''; render(false)
  })
  $('c-close').addEventListener('click', () => { if (!busy) { pending = null; closeSheet('confirm') } })
  $('c-done-btn').addEventListener('click', () => closeSheet('confirm'))
  $('confirm').addEventListener('click', (e) => { if (e.target === $('confirm') && !busy) { pending = null; closeSheet('confirm') } })
  $('c-mev').addEventListener('click', (e) => { if ((e.target as Element).closest('[data-wsheet]')) openW() })

  // ---------------------------------------------------------------- propose: sign a ladder, post it
  $('mk-in').addEventListener('input', (e) => { const t = e.target as HTMLInputElement, v = clean(t.value); if (v !== t.value) t.value = v; S.mk.amount = v; renderMake() })
  $('custom-in').addEventListener('input', (e) => { const t = e.target as HTMLInputElement, v = clean(t.value); if (v !== t.value) t.value = v; S.mk.custom = v; renderMake() })
  $('modes').addEventListener('click', (e) => { const b = (e.target as Element).closest<HTMLElement>('[data-mode]'); if (!b) return; S.mk.mode = b.dataset.mode as typeof S.mk.mode; renderMake(); if (S.mk.mode === 'custom') $('custom-in').focus() })
  $('mk-guard-ok').addEventListener('change', (e) => { S.mk.ack = (e.target as HTMLInputElement).checked; renderMake() })
  $('exp-seg').addEventListener('click', (e) => { const b = (e.target as Element).closest<HTMLElement>('[data-exp]'); if (b) { S.mk.exp = b.dataset.exp as typeof S.mk.exp; renderMake() } })
  $('mk-private').addEventListener('change', (e) => { S.mk.priv = (e.target as HTMLInputElement).checked; renderMake(); if (S.mk.priv) $('mk-cp').focus() })
  $('mk-cp').addEventListener('input', (e) => { S.mk.cp = (e.target as HTMLInputElement).value.trim(); renderMake() })
  $('partial').addEventListener('change', (e) => { S.mk.partial = (e.target as HTMLInputElement).checked; renderMake() })
  $('publish').addEventListener('click', async () => {
    const I = mkInfo(), k = S.mk, amount = num(k.amount)
    if (!I || !amount || !I.price || ($('publish') as HTMLButtonElement).disabled) return
    if (!me()) { openW(); return }
    const { m, sell, price } = I, parts = k.partial && !k.priv ? 4 : 1
    const cp = k.priv ? cpAddress() : null
    if (k.priv && !cp) return
    const terms = ladderTerms(m, sell, amount, price, parts)
    const give = sell ? m.base : m.quote
    const fee = B.protocolFee()
    const need = terms.reduce((s, t) => s + t.signerAmount + feeOf(t.signerAmount, fee), 0n) + B.liveNeed(give.address)
    busyPublish = true; renderMake()
    const pubBtn = $('publish')
    try {
      if (allowance(give.symbol) < need) {
        pubBtn.querySelector('span')!.textContent = 'Autorizzazione nel wallet…'
        await B.approveFor(give.address, need)
      }
      pubBtn.querySelector('span')!.textContent = parts > 1 ? `Firma ${parts} parti nel wallet…` : 'Firma nel wallet…'
      const dur = { '1h': 3600, '24h': 86_400, '7d': 7 * 86_400 }[k.exp]
      const res = await B.publish(terms, B.nowSec() + dur, cp)
      if (res.ok === 0) throw new Error(res.errors.join(' · ') || 'offerta rifiutata dalla bacheca')
      S.ofilter = 'attive'; if (!MQ2.matches) S.tab = 'offers'
      k.amount = ''
      save(); render(); if (!MQ2.matches) top()
      toast(res.ok === terms.length ? (cp ? 'Offerta privata pubblicata' : 'Offerta pubblicata') : `Pubblicate ${res.ok} parti su ${terms.length}`, res.errors.length ? res.errors.join(' · ') : cp ? 'Copia il link da Le mie offerte e mandalo alla controparte' : 'Nessun costo finché qualcuno non accetta')
      if (cp) { k.priv = false; k.cp = '' }
    } catch (e) {
      $('mk-error').hidden = false; $('mk-error').textContent = humanError(e)
    } finally {
      busyPublish = false; pubBtn.querySelector('span')!.textContent = 'Pubblica l’offerta'; renderMake()
    }
  })
  function cpAddress(): Address | null { const v = S.mk.cp.trim(); return /^0x[0-9a-fA-F]{40}$/.test(v) ? getAddress(v) : null }
  const humanError = (e: unknown) => {
    const m = (e as { shortMessage?: string; message?: string }).shortMessage ?? (e as Error).message ?? String(e)
    return /reject|denied|4001/i.test(m) ? 'Firma rifiutata nel wallet: nessuna offerta pubblicata.' : m
  }

  // ---------------------------------------------------------------- offers: protected cancel, cancel all, funds, re-sign
  async function doCancel(nonces: string[], what: string) {
    if (!nonces.length) return
    toast('Annullamento', 'Conferma nel wallet: una transazione')
    try {
      const r = await B.cancel(nonces)
      if (r.status === 'cancelled') toast(what === 'all' ? 'Offerte annullate' : 'Offerta annullata', protNote())
      else if (r.status === 'partly_taken') toast('Annullate, tranne le parti già eseguite', `${r.taken.length} ${r.taken.length === 1 ? 'parte era già stata presa' : 'parti erano già state prese'}`)
      else if (r.status === 'rejected') toast('Annullamento rifiutato nel wallet', 'Le offerte restano attive')
      else toast('Annullamento non confermato', 'Controlla il wallet: le offerte potrebbero essere ancora attive')
    } catch (e) { toast('Annullamento non riuscito', humanError(e)) }
    render()
  }
  async function onOffers(e: Event) {
    const t = e.target as Element
    const of = t.closest<HTMLElement>('[data-of]'); if (of) { S.ofilter = of.dataset.of as 'attive'; S.confirmAll = false; renderOffers(); return }
    const g = t.closest<HTMLElement>('[data-go]'); if (g) { if (g.dataset.go === 'wallet') { openW(); return } S.mode = 'make'; if (!MQ2.matches) S.tab = 'swap'; save(); render(); top(); return }
    const ca = t.closest<HTMLElement>('[data-ca]')
    if (ca) {
      if (ca.dataset.ca === 'ask') { S.confirmAll = true; renderOffers(); return }
      if (ca.dataset.ca === 'no') { S.confirmAll = false; renderOffers(); return }
      S.confirmAll = false
      return doCancel([...new Set(offerData().live.flatMap((o) => o.cancelNonces))], 'all')
    }
    const b = t.closest<HTMLElement>('[data-act]'); if (!b) return
    if (b.dataset.act === 'link') {
      const url = privateLink(b.dataset.hash ?? '')
      const ok = await copyText(url)
      toast(ok ? 'Link copiato' : 'Copia non riuscita', ok ? 'Mandalo alla controparte: solo quell’indirizzo può accettare' : url)
      return
    }
    const o = offerData().live.find((x) => x.key === b.dataset.key); if (!o) return
    if (b.dataset.act === 'cancel') return doCancel(o.cancelNonces, 'one')
    const give = o.side === 'sell' ? o.market.base : o.market.quote
    if (b.dataset.act === 'fund') {
      const need = B.liveNeed(give.address)
      const f = B.funds()?.[give.address]
      if (f && f.balance < need) { toast('Saldo insufficiente', `Servono ${fa(give.symbol, Number(formatUnits(need, give.decimals)))} ${give.symbol} sul wallet, commissione inclusa`); return }
      try { await B.approveFor(give.address, need); toast('Fondi autorizzati', 'Tutte le parti tornano visibili al prossimo controllo') } catch (err) { toast('Autorizzazione non riuscita', humanError(err)) }
      render(); return
    }
    // resign: same terms and SAME nonces at the current fee. The old orders become valid again on-chain if the fee ever returns;
    // sharing the nonce, at most one of each pair can be filled (the book replaces the invalid_fee order).
    const terms = o.orders.filter((x) => x.status === 'invalid_fee').map((x) => ({ signerToken: getAddress(x.order.signerToken) as Address, signerAmount: BigInt(x.order.signerAmount), senderToken: getAddress(x.order.senderToken) as Address, senderAmount: BigInt(x.order.senderAmount), nonce: BigInt(x.order.nonce) }))
    try {
      // a higher fee needs a larger allowance: authorize first (one transaction), otherwise the book would pause the offer
      const fee = B.protocolFee()
      const need = terms.reduce((s, t) => s + t.signerAmount + feeOf(t.signerAmount, fee), 0n) + B.liveNeed(give.address)
      if (allowance(give.symbol) < need) { toast('Autorizzazione', 'La nuova commissione richiede un’autorizzazione più alta: conferma nel wallet'); await B.approveFor(give.address, need) }
      const res = await B.publish(terms, Math.max(o.expiry, B.nowSec() + 3600), o.privateFor ? (getAddress(o.privateFor) as Address) : null)
      toast(res.ok ? 'Offerta rifirmata' : 'Rifirma non riuscita', res.ok ? 'Di nuovo in vendita, senza costi' : res.errors.join(' · '))
    } catch (err) { toast('Rifirma non riuscita', humanError(err)) }
    render()
  }
  const privateLink = (hash: string) => `${location.href.split('#')[0]}#offerta=${hash}`
  async function copyText(text: string): Promise<boolean> {
    try { await navigator.clipboard.writeText(text); return true } catch {
      try { const t = document.createElement('textarea'); t.value = text; t.setAttribute('readonly', ''); t.style.position = 'fixed'; t.style.opacity = '0'; document.body.appendChild(t); t.select(); const ok = document.execCommand('copy'); t.remove(); return ok } catch { return false }
    }
  }

  // ---------------------------------------------------------------- private offer opened from a link (#offerta=<hash>)
  let privHash: string | null = null, privPrompted = false, connecting = false
  function privateFromLocation() { const m = /#offerta=(0x[0-9a-fA-F]{64})$/.exec(location.hash); privHash = m ? (m[1] as string).toLowerCase() : null }
  async function openPrivate() {
    if (!privHash || busy || openSheets.has('confirm')) return
    if (!B.ready() || !markets().length) return // retried on the next data update
    if (!me()) { if (!privPrompted) { privPrompted = true; toast('Offerta privata', 'Collega il wallet dell’indirizzo a cui è destinata'); openW() } return }
    const hash = privHash
    const r = await B.privateOrder(hash)
    if (privHash !== hash) return
    privHash = null
    history.replaceState(null, '', location.href.split('#')[0])
    if (!r) { toast('Offerta privata non trovata', 'Il link non corrisponde a un’offerta privata su questa bacheca'); return }
    const o = r.order, for_ = getAddress(String(o.senderWallet))
    if (for_ !== me()) { toast('Questa offerta non è per te', `È destinata a ${shortAddr(for_)}: collega quell’account`); return }
    if (r.status !== 'open') { toast('Offerta non più disponibile', r.status === 'filled' ? 'È già stata eseguita' : r.status === 'cancelled' ? 'Il firmatario l’ha annullata' : `Stato: ${r.status}`); return }
    const sT = getAddress(String(o.signerToken)), qT = getAddress(String(o.senderToken))
    const m = markets().find((x) => (x.base.address === sT && x.quote.address === qT) || (x.base.address === qT && x.quote.address === sT))
    if (!m) { toast('Mercato non disponibile', 'Le monete di questa offerta non sono configurate nell’app'); return }
    const buy = sT === m.base.address, payT = buy ? m.quote : m.base, recvT = buy ? m.base : m.quote
    const order = { nonce: BigInt(o.nonce as string), expiry: BigInt(o.expiry as string), signerWallet: getAddress(String(o.signerWallet)), signerToken: sT, signerAmount: BigInt(o.signerAmount as string),
      protocolFee: BigInt(o.protocolFee as string), senderWallet: for_, senderToken: qT, senderAmount: BigInt(o.senderAmount as string), v: Number(o.v), r: o.r as `0x${string}`, s: o.s as `0x${string}` }
    const base = units(buy ? order.signerAmount : order.senderAmount, m.base.decimals), quoteU = units(buy ? order.senderAmount : order.signerAmount, m.quote.decimals)
    const P: Pend = { m, buy, pay: payT.symbol, recv: recvT.symbol, verified: null,
      plan: { kind: 'indicative', legs: [{ hash, order }], pay: order.senderAmount, receive: order.signerAmount, left: 0n, at: Date.now() },
      orders: [{ hash, p: quoteU / base, base, pay: units(order.senderAmount, payT.decimals), out: units(order.signerAmount, recvT.decimals), st: 'wait' }] }
    $('c-title').textContent = 'Offerta privata per te'
    await runConfirm(P)
  }
  privateFromLocation()
  window.addEventListener('hashchange', () => { privateFromLocation(); void openPrivate() })
  B.onChange(() => { if (privHash && !connecting) void openPrivate() })

  $('offers-d').addEventListener('click', (e) => void onOffers(e))
  $('offers-m-list').addEventListener('click', (e) => void onOffers(e))

  // ---------------------------------------------------------------- wallet & protection sheet
  function renderWallet() {
    const st = B.protection(), ws = B.wallets(), sel = B.selectedWallet()
    $('w-list-l').textContent = ws.length ? 'Wallet trovati nel browser' : 'Nessun wallet trovato nel browser'
    $('w-list').innerHTML = ws.length ? ws.map((w) => `<label><input type="radio" name="wsel" value="${esc(w.info.uuid)}"${sel?.info.uuid === w.info.uuid ? ' checked' : ''}><span><b>${esc(w.info.name)}</b><small>${sel?.info.uuid === w.info.uuid && me() ? esc(shortAddr(me())) : esc(w.info.rdns)}</small></span></label>`).join('')
      : '<p class="o-note">Installa un wallet compatibile (EIP-6963), poi ricarica la pagina.</p>'
    $('w-net').innerHTML = B.chains().map((c) => `<label><input type="radio" name="wnet" value="${c.id}"${c.id === B.chainId() ? ' checked' : ''}><span><b>${esc(c.name)}</b><small>${[8453, 10, 42161, 84532].includes(c.id) ? 'sequencer L2' : 'mempool pubblica'}</small></span></label>`).join('')
    const ic = st.protected ? 'i-shield' : 'i-alert'
    let h = `<div class="wstat-h"><svg class="ic sm" aria-hidden="true"><use href="#${ic}"/></svg>${esc(st.title)}</div><p>${esc(st.detail)}</p>`
    if (st.level === 'guide') h += `<ol class="wsteps">${GUIDE_STEPS.map((s) => `<li>${esc(s)}</li>`).join('')}</ol>`
    if (st.rpc.length) h += '<div>' + st.rpc.map((r) => `<div class="rpc-row"><div><b>${esc(r.name)}</b><code>${esc(r.url)}</code></div><button type="button" class="btn" data-copy="${esc(r.url)}" data-name="${esc(r.name)}">Copia</button></div>`).join('') + '</div>' +
      (sel ? `<label class="guard-ok"><input type="checkbox" id="w-rpcset"${B.rpcConfirmed() ? ' checked' : ''}>Ho impostato l’RPC protetto in questo wallet</label>` : '')
    const box = $('w-stat'); box.innerHTML = h; box.classList.toggle('off', !st.protected)
    $('w-connect').hidden = !!me() || !ws.length
    renderMev()
  }
  const openW = () => { renderWallet(); openSheet('wsheet', $('w-close')) }
  $('wal-chip').addEventListener('click', openW)
  $('net-chip').addEventListener('click', openW)
  $('w-close').addEventListener('click', () => closeSheet('wsheet'))
  $('wsheet').addEventListener('click', (e) => { if (e.target === $('wsheet')) closeSheet('wsheet') })
  const connectSel = async (uuid?: string) => {
    const w = B.wallets().find((x) => x.info.uuid === uuid) ?? B.wallets()[0]
    if (!w) return
    connecting = true
    try { await B.connect(w); toast('Wallet collegato', shortAddr(me())) } catch (e) { toast('Collegamento non riuscito', humanError(e)) } finally { connecting = false }
    if (privHash) { closeSheet('wsheet'); void openPrivate() } // a private-offer link waiting for the wallet: its message must not be overwritten
    renderWallet(); render()
  }
  $('w-list').addEventListener('change', (e) => { const t = e.target as HTMLInputElement; if (t.name === 'wsel') void connectSel(t.value) })
  $('w-connect').addEventListener('click', () => void connectSel((document.querySelector('input[name="wsel"]:checked') as HTMLInputElement | null)?.value))
  $('w-net').addEventListener('change', async (e) => { const t = e.target as HTMLInputElement; if (t.name === 'wnet') { await B.switchChain(Number(t.value)); S.mkt = ''; renderWallet(); render() } })
  $('w-stat').addEventListener('change', (e) => { const t = e.target as HTMLInputElement; if (t.id === 'w-rpcset') { B.setRpcConfirmed(t.checked); renderWallet(); renderHeader() } })
  $('w-stat').addEventListener('click', async (e) => {
    const b = (e.target as Element).closest<HTMLElement>('[data-copy]'); if (!b) return
    const url = b.dataset.copy as string
    let ok = false
    try { await navigator.clipboard.writeText(url); ok = true } catch {
      try { const t = document.createElement('textarea'); t.value = url; t.setAttribute('readonly', ''); t.style.position = 'fixed'; t.style.opacity = '0'; document.body.appendChild(t); t.select(); ok = document.execCommand('copy'); t.remove() } catch { ok = false }
    }
    b.textContent = ok ? 'Copiato' : 'Seleziona'
    setTimeout(() => { b.textContent = 'Copia' }, 1600)
    if (ok) toast('Indirizzo copiato', b.dataset.name); else toast('Copia non riuscita', 'Tieni premuto sull’indirizzo per copiarlo')
  })
  $('set-chip').addEventListener('click', () => opts.openSettings())
  $('w-settings').addEventListener('click', () => { closeSheet('wsheet'); opts.openSettings() })

  // ---------------------------------------------------------------- live updates
  B.onChange((what) => {
    if (what === 'book' || what === 'all') {
      const now = Date.now()
      for (const m of markets()) {
        const p = mid(m), before = lastMid.get(m.id)
        if (before && p && Math.abs(p - before) > 1e-12) mflash.set(m.id, { t: now, dir: p > before ? 1 : -1 })
        lastMid.set(m.id, p)
        const v = view(m)
        for (const [side, list] of [['ask', v.asks], ['bid', v.bids]] as const) for (const l of list) {
          const k = `${m.id}|${side}|${l.p}`, sig = `${l.q}`
          if (prevQ.get(k) !== undefined && prevQ.get(k) !== sig) flash.set(k, now)
          prevQ.set(k, sig)
        }
      }
    }
    if (openSheets.has('confirm')) { renderBanners(); renderHeader(); return } // never re-render under an open confirmation
    render(false)
    if (openSheets.has('wsheet') && what === 'wallet') renderWallet()
  })
  const prevQ = new Map<string, string>()
  setInterval(() => { if (!document.hidden && !openSheets.size) { renderPair(); renderOffers() } }, 5000) // "ago" labels, expiries

  render(false)
  document.documentElement.classList.remove('booting') // the shell is painted only once it has its final layout (no layout shift)
  return { render: () => render(false), toast, openSheet, closeSheet }
}

/** Splash, variant C: the sell and buy bars close the gap, then the wordmark; once per session, skippable, ~2.8 s. */
export function splash(): void {
  const el = document.getElementById('splash') as HTMLElement
  let seen = false
  try { seen = sessionStorage.getItem('fondaco-splash') === '1'; sessionStorage.setItem('fondaco-splash', '1') } catch { /* storage unavailable */ }
  if (seen) { el.remove(); return }
  const L = [58, 86, 44, 98, 70, 52], R = [72, 50, 92, 62, 100, 56]
  const rowsEl = document.getElementById('sp-rows') as HTMLElement
  rowsEl.innerHTML = L.map(() => '<div class="sp-row"><span><i></i></span><span><i></i></span></div>').join('')
  const rows = [...rowsEl.children] as HTMLElement[], word = document.getElementById('sp-word') as HTMLElement
  const steps: [number, string][] = [[35, 'RACCOLGO LE OFFERTE'], [82, 'CHIUDO LA DIFFERENZA'], [99.9, 'VERIFICO IL CONTRATTO'], [101, 'PRONTO']]
  const D = RM.matches ? 1 : 2800, t0 = performance.now()
  let raf = 0, done = false
  const finish = () => { if (done) return; done = true; cancelAnimationFrame(raf); el.classList.add('gone'); setTimeout(() => el.remove(), 500) }
  const frame = (now: number) => {
    const p = Math.min(100, ((now - t0) / D) * 100)
    const seg = (a: number, b: number) => { const k = Math.max(0, Math.min(1, (p - a) / (b - a))); return 1 - Math.pow(1 - k, 3) }
    const gap = 2 + 46 * (1 - seg(40, 82))
    rows.forEach((r, i) => {
      const k = seg(i * 6, 40 + i * 6)
      r.style.gap = gap + 'px'
      ;((r.children[0] as HTMLElement).firstChild as HTMLElement).style.width = (L[i] as number) * k + 'px'
      ;((r.children[1] as HTMLElement).firstChild as HTMLElement).style.width = (R[i] as number) * k + 'px'
    })
    const w = seg(72, 96)
    word.style.opacity = String(w); word.style.transform = `translateY(${(1 - w) * 12}px)`
    ;(document.getElementById('sp-l') as HTMLElement).style.width = (document.getElementById('sp-r') as HTMLElement).style.width = p / 2 + '%'
    ;(document.getElementById('sp-step') as HTMLElement).textContent = (steps.find((s) => p < s[0]) as [number, string])[1]
    ;(document.getElementById('sp-pct') as HTMLElement).textContent = String(Math.round(p)).padStart(3, '0') + '%'
    if (p < 100) raf = requestAnimationFrame(frame); else setTimeout(finish, RM.matches ? 300 : 450)
  }
  ;(document.getElementById('sp-skip') as HTMLElement).addEventListener('click', finish)
  raf = requestAnimationFrame(frame)
}

