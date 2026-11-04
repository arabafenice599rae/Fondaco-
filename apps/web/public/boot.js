// First script of the page, served as is (no bundling, no imports): while the main bundle downloads it asks the book for
// /config and, in one request (/books), for the book of every pair between the configured tokens. The main bundle takes these responses by exact
// URL (src/prefetch.ts takePrefetched); a miss only means a normal request. Pair rule = src/prefetch.ts guessPairs
// (equivalence checked by test/model.test.mjs).
(() => {
  const store = new Map()
  window.__fondacoPrefetch = store
  const QUOTE_RANK = ['USDC', 'USDT', 'DAI', 'WETH']
  const rank = (s) => { const i = QUOTE_RANK.indexOf(s); return i < 0 ? 99 : i }
  const guessPairs = (tokens) => {
    const t = Object.entries(tokens || {}).map(([address, v]) => ({ address, symbol: String((v && v.symbol) || '') }))
    const out = []
    for (let i = 0; i < t.length; i++) for (let j = i + 1; j < t.length; j++) {
      const [base, quote] = rank(t[i].symbol) <= rank(t[j].symbol) ? [t[j], t[i]] : [t[i], t[j]]
      out.push({ base: base.address, quote: quote.address })
    }
    return out
  }
  window.__fondacoGuessPairs = guessPairs
  const userBook = () => { try { const v = JSON.parse(localStorage.getItem('fondaco-settings') || '{}'); return typeof v.book === 'string' && /^https?:\/\//.test(v.book) ? v.book : null } catch { return null } }
  // the main bundle reads config.json through this promise (the preloaded response can be consumed only once)
  const config = fetch('./config.json').then((r) => r.json())
  window.__fondacoConfig = config
  config.then((cfg) => {
    const book = (userBook() || cfg.book || '').replace(/\/+$/, '')
    if (!/^https?:\/\//.test(book)) return
    const chain = Number(cfg.defaultChain || 1)
    const get = (path) => { const p = fetch(book + path, { cache: 'no-store' }); p.catch(() => {}); store.set(book + path, p) }
    get('/config')
    const pairs = guessPairs(((cfg.chains || {})[String(chain)] || {}).tokens).slice(0, 10)
    if (pairs.length) get(`/books?chainId=${chain}&pairs=${pairs.map((m) => `${m.base}:${m.quote}`.toLowerCase()).join(',')}&limit=100&signed=1`)
  }).catch(() => {})
})()
