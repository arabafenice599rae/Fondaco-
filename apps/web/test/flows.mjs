// Phase 6 flows of the app, end to end on the fork (SwapERC20 v4.3 from the fixture, two books, production build, injected
// EIP-6963 wallets). Every flow checks balances on-chain; every page's console must stay clean (errors and warnings).
//   F1 4-part ladder: publish, partial buy by a 2nd account, "Eseguite 1 su 4", "Annulla il resto", remaining nonces used on-chain
//   F2 signer funds moved away → "In pausa"; funds back → active again
//   F3 setProtocolFee by the owner (test Safe) → "Da rifirmare" → re-sign (same nonces) → active; fee back → revived without re-sign
//   F4 "Annulla ora": post → authorize → revoke → warning + button → protected cancel → cancelled, button gone
//   F5 race: the 2nd order of a 2-order swap is taken by a third account during execution → partial, costs summed correctly
//   F6 private offer (second book): not in the book, link opens it only for the counterparty, executable only by it
//   F7 signature rejected in the wallet, then confirmation timeout (automine off): the app stops, remaining orders not sent
//   F8 wallet switches chain 1 → 8453: network, MEV status and configuration follow
//   F9 book unreachable at start: explicit empty state, no unhandled error
import { formatUnits, parseAbi } from 'viem'
import * as H from './harness.mjs'

const { check, finish } = H.reporter()
const A = await H.accounts()
const [owner, feeWallet, M1, T1, X, M2, M3, T2, signatory, spare] = A
const { swap: SWAP, block } = await H.deploySwap(owner, feeWallet)
const [bookA, bookB] = await H.startBooks(2, SWAP, block)
const swapAbi = H.SwapArt.abi
for (const m of [M1, M2, M3]) await H.send(m, { address: H.WETH, abi: H.ERC20, functionName: 'deposit', value: 10n * H.E18 })
for (const t of [T1, X, T2]) await H.setUsdc(t, 100_000n * H.E6)
await H.send(X, { address: H.USDC, abi: H.ERC20, functionName: 'approve', args: [SWAP, 2n ** 255n] })

const dir = H.buildApp()
const appA = await H.serve(dir, H.appConfig({ book: bookA.url, swap: SWAP }))
const appB = await H.serve(dir, H.appConfig({ book: bookB.url, swap: SWAP }))
const appA8 = await H.serve(dir, H.appConfig({ book: bookA.url, swap: SWAP, txTimeoutSec: 8 }))
const { freePort } = await import('../../../tools/testkit/anvil.js')
const appDown = await H.serve(dir, H.appConfig({ book: `http://127.0.0.1:${await freePort()}`, swap: SWAP })) // nothing listens there
const sessions = []
const open = async (url, acct, label, opts = {}) => { const s = await H.session(url, acct, { label, ...opts }); sessions.push({ ...s, label, allowed: opts.allowed ?? [] }); return s }

const W = (n) => formatUnits(n, 18), U = (n) => formatUnits(n, 6)
const fee = (amt, bps = H.FEE) => (amt * bps) / 10_000n
const mine = (signer) => bookA.api(`/orders?chainId=1&signer=${signer}`).then((r) => r.body.orders)
const nonceUsed = (signer, n) => H.pub.readContract({ address: SWAP, abi: swapAbi, functionName: 'nonceUsed', args: [signer, BigInt(n)] })
const sync = async (b = bookA) => { await H.sleep(100); await b.sync().catch(() => {}) }
async function offerState(page, text) {
  // the article of "Le mie offerte" whose title contains `text`: its data-offer status ('' if none)
  await page.click('[data-tab="offers"]').catch(() => {})
  return page.evaluate((t) => [...document.querySelectorAll('#offers-d article.offer, #offers-m-list article.offer')].find((a) => a.textContent.includes(t))?.dataset.offer ?? '', text)
}
const waitOffer = (page, text, want, ms = 25_000) => H.until(async () => (await offerState(page, text)) === want, ms, `offer "${text}" → ${want}`).then(() => true).catch(() => false)
const phases = []
async function flow(name, f) { phases.push([name, Date.now()]); try { await f() } catch (e) { console.error(e); check(`${name}: unexpected error`, false, String(e?.message ?? e).split('\n')[0]) } }

// ================================================================================== F1 ladder
await flow('F1', async () => {
  const m = await open(appA.url, M1, 'M1'), t = await open(appA.url, T1, 'T1')
  const w0 = { mW: await H.bal(H.WETH, M1), mU: await H.bal(H.USDC, M1), tW: await H.bal(H.WETH, T1), tU: await H.bal(H.USDC, T1) }
  const err = await H.publish(m.page, { amount: '0,4', price: '2500', parts4: true })
  const asks = (await bookA.api(`/book?chainId=1&base=${H.WETH}&quote=${H.USDC}`)).body.asks
  check('F1a: 4-part ladder published (4 orders of 0,1 WETH at 2500)', !err && asks.length === 4 && asks.every((a) => a.price === 2500 && a.baseAmount === String(H.E18 / 10n)), err ?? `${asks.length} asks`)
  await H.until(async () => (await t.page.locator('#asks .lvl').count()) > 0, 15_000, 'book visible')
  await H.review(t.page, '250')
  const done = await H.confirmAndWait(t.page)
  const w1 = { mW: await H.bal(H.WETH, M1), mU: await H.bal(H.USDC, M1), tW: await H.bal(H.WETH, T1), tU: await H.bal(H.USDC, T1) }
  const part = H.E18 / 10n
  check('F1b: partial buy of 1 part from a 2nd account — balances exact (taker +0,1 WETH −250 USDC; maker +250 USDC −(0,1 + fee) WETH)',
    done.title === 'Scambio completato' && w1.tW - w0.tW === part && w0.tU - w1.tU === 250n * H.E6 && w1.mU - w0.mU === 250n * H.E6 && w0.mW - w1.mW === part + fee(part),
    `${done.title}; taker +${W(w1.tW - w0.tW)} WETH −${U(w0.tU - w1.tU)} USDC; maker +${U(w1.mU - w0.mU)} USDC −${W(w0.mW - w1.mW)} WETH`)
  await t.page.click('#c-done-btn')
  await sync()
  const ok1 = await H.until(async () => (await H.offersText(m.page)).includes('Eseguite 1 su 4'), 25_000, 'Eseguite 1 su 4').then(() => true).catch(() => false)
  check('F1c: maker sees "Eseguite 1 su 4"', ok1, (await H.offersText(m.page)).slice(0, 120))
  const live = (await mine(M1)).filter((o) => o.status === 'open')
  await m.page.locator('#offers-d article.offer:has-text("Vendi 0,4 WETH") button[data-act="cancel"]').first().click()
  await H.until(async () => /annullat/i.test((await m.page.textContent('#toast-t')) ?? ''), 60_000, 'cancel toast')
  const used = await Promise.all(live.map((o) => nonceUsed(M1, o.order.nonce)))
  await sync()
  const st = await mine(M1)
  const gone = await H.until(async () => !(await H.offersText(m.page)).includes('Vendi 0,4 WETH'), 20_000, 'offer gone').then(() => true).catch(() => false)
  const w2 = { mW: await H.bal(H.WETH, M1) }
  check('F1d: "Annulla il resto" — the 3 remaining nonces are used on-chain, orders cancelled, offer gone, no WETH moved',
    live.length === 3 && used.every(Boolean) && st.filter((o) => o.status === 'cancelled').length === 3 && gone && w2.mW === w1.mW, `${used.filter(Boolean).length}/3 nonces used; statuses ${st.map((o) => o.status).join(',')}`)
})

// ================================================================================== F2 unfunded
await flow('F2', async () => {
  const m = await open(appA.url, M2, 'M2')
  const err = await H.publish(m.page, { amount: '0,3', price: '2600' })
  const h = (await mine(M2)).find((o) => o.status === 'open')?.hash
  const all = await H.bal(H.WETH, M2)
  await H.send(M2, { address: H.WETH, abi: H.ERC20, functionName: 'transfer', args: [spare, all] })
  await sync()
  const paused = await waitOffer(m.page, 'Vendi 0,3 WETH', 'paused')
  const stP = (await bookA.api(`/orders/${h}`)).body.status, balP = await H.bal(H.WETH, M2)
  await H.send(spare, { address: H.WETH, abi: H.ERC20, functionName: 'transfer', args: [M2, all] })
  await sync()
  const active = await waitOffer(m.page, 'Vendi 0,3 WETH', 'active')
  const stA = (await bookA.api(`/orders/${h}`)).body.status
  check('F2: funds moved away → "In pausa" (unfunded); funds back → "Attiva" (open); on-chain balance 0 then restored',
    !err && paused && stP === 'unfunded' && balP === 0n && active && stA === 'open' && (await H.bal(H.WETH, M2)) === all, `${stP} → ${stA}; balance 0 → ${W(all)}`)
})

// ================================================================================== F3 fee change
await flow('F3', async () => {
  const m1 = sessions.find((s) => s.label === 'M1'), m2 = sessions.find((s) => s.label === 'M2')
  await H.publish(m1.page, { amount: '0,2', price: '2700' })
  const before = (await mine(M1)).find((o) => o.status === 'open' && o.order.signerAmount === String(2n * H.E18 / 10n))
  await H.send(owner, { address: SWAP, abi: swapAbi, functionName: 'setProtocolFee', args: [40n] })
  await sync()
  const r1 = await waitOffer(m1.page, 'Vendi 0,2 WETH', 'resign'), r2 = await waitOffer(m2.page, 'Vendi 0,3 WETH', 'resign')
  check('F3a: setProtocolFee 40 by the owner (test Safe) → both offers "Da rifirmare"', r1 && r2)
  const mW0 = await H.bal(H.WETH, M1)
  await m1.page.locator('#offers-d article.offer:has-text("Vendi 0,2 WETH") button[data-act="resign"]').click()
  await H.until(async () => /rifirmata/i.test((await m1.page.textContent('#toast-t')) ?? ''), 60_000, 'resign toast')
  await sync()
  const after = (await mine(M1)).find((o) => o.order.signerAmount === String(2n * H.E18 / 10n) && o.order.protocolFee === '40')
  const allowance = await H.pub.readContract({ address: H.WETH, abi: H.ERC20, functionName: 'allowance', args: [M1, SWAP] })
  const a1 = await waitOffer(m1.page, 'Vendi 0,2 WETH', 'active')
  check('F3b: re-signed (same nonce, fee 40, allowance raised to amount + new fee) → "Attiva"; the old order replaced in the book',
    a1 && after?.status === 'open' && after.order.nonce === before.order.nonce && (await bookA.api(`/orders/${before.hash}`)).status === 404 && allowance >= 2n * H.E18 / 10n + fee(2n * H.E18 / 10n, 40n) && (await H.bal(H.WETH, M1)) === mW0,
    `nonce ${before?.order.nonce} → ${after?.order.nonce}, status ${after?.status}, allowance ${W(allowance)}`)
  await H.send(owner, { address: SWAP, abi: swapAbi, functionName: 'setProtocolFee', args: [H.FEE] })
  await sync()
  const back2 = await waitOffer(m2.page, 'Vendi 0,3 WETH', 'active'), back1 = await waitOffer(m1.page, 'Vendi 0,2 WETH', 'resign')
  check('F3c: fee back to 30 → the offer never re-signed is active again without re-signing; the re-signed one asks again (one nonce: never both)',
    back2 && back1 && (await H.pub.readContract({ address: SWAP, abi: swapAbi, functionName: 'protocolFee' })) === H.FEE)
  // clean the book for the next flows: cancel M2's 0,3 offer from the app
  await m2.page.locator('#offers-d article.offer:has-text("Vendi 0,3 WETH") button[data-act="cancel"]').click()
  await H.until(async () => /annullat/i.test((await m2.page.textContent('#toast-t')) ?? ''), 60_000, 'cancel toast')
})

// ================================================================================== F4 Annulla ora
await flow('F4', async () => {
  const m = await open(appA.url, M3, 'M3')
  await H.publish(m.page, { amount: '0,1', price: '2900' })
  const o = (await mine(M3)).find((x) => x.status === 'open')
  await H.send(M3, { address: SWAP, abi: swapAbi, functionName: 'authorize', args: [signatory] })
  await sync()
  const s1 = (await bookA.api(`/orders/${o.hash}`)).body
  await H.send(M3, { address: SWAP, abi: swapAbi, functionName: 'revoke', args: [] })
  await sync()
  const ex = await waitOffer(m.page, 'Vendi 0,1 WETH', 'exec')
  const s2 = (await bookA.api(`/orders/${o.hash}`)).body
  const txt = await H.offersText(m.page)
  check('F4a: authorize → invalid_signer; revoke → still executable on-chain → warning and "Annulla ora" in the app',
    s1.status === 'invalid_signer' && s2.executableOnChain === true && ex && /può ancora essere eseguita/.test(txt) && /Annulla ora/.test(txt), `${s1.status}/${s1.executableOnChain} → ${s2.status}/${s2.executableOnChain}`)
  const w0 = await H.bal(H.WETH, M3)
  await m.page.locator('#offers-d article.offer:has-text("Vendi 0,1 WETH") button[data-act="cancel"]').click()
  await H.until(async () => /annullat/i.test((await m.page.textContent('#toast-t')) ?? ''), 60_000, 'cancel toast')
  await sync()
  const gone = await H.until(async () => !(await H.offersText(m.page)).includes('Annulla ora'), 20_000, 'button gone').then(() => true).catch(() => false)
  const s3 = (await bookA.api(`/orders/${o.hash}`)).body
  check('F4b: protected cancel → nonce used on-chain, order cancelled, button gone, no WETH moved',
    (await nonceUsed(M3, o.order.nonce)) && s3.status === 'cancelled' && s3.executableOnChain === false && gone && (await H.bal(H.WETH, M3)) === w0, `${s3.status}`)
})

// ================================================================================== F5 race
await flow('F5', async () => {
  const m1 = sessions.find((s) => s.label === 'M1'), m2 = sessions.find((s) => s.label === 'M2')
  await H.publish(m1.page, { amount: '0,1', price: '2400' })
  await H.publish(m2.page, { amount: '0,1', price: '2410' })
  const o2 = (await mine(M2)).find((x) => x.status === 'open' && x.order.senderAmount === String(241n * H.E6))
  const full2 = (await bookA.api(`/orders/${o2.hash}`)).body.order
  let swaps = 0, raced = false
  const t = await open(appA.url, T1, 'T1-race', {
    beforeSend: async (tx) => {
      if (tx.to?.toLowerCase() !== SWAP.toLowerCase()) return
      if (++swaps === 2 && !raced) { // a third account takes the 2nd order first (after the app simulated it)
        raced = true
        await H.send(X, { address: SWAP, abi: swapAbi, functionName: 'swapAnySender', args: [X, BigInt(full2.nonce), BigInt(full2.expiry), full2.signerWallet, full2.signerToken, BigInt(full2.signerAmount), full2.senderToken, BigInt(full2.senderAmount), Number(full2.v), full2.r, full2.s] })
      }
    },
  })
  // a realistic base fee (20 gwei) so the cost shown with 6 decimals is not 0 and the comparison means something
  await H.test.setNextBlockBaseFeePerGas({ baseFeePerGas: 20_000_000_000n }); await H.test.mine({ blocks: 1 })
  const tW0 = await H.bal(H.WETH, T1), tU0 = await H.bal(H.USDC, T1), xW0 = await H.bal(H.WETH, X), eth0 = await H.pub.getBalance({ address: T1 })
  await H.until(async () => (await t.page.locator('#asks .lvl').count()) >= 2, 15_000, 'two asks')
  await H.review(t.page, '491')
  const done = await H.confirmAndWait(t.page)
  const rcs = await Promise.all(t.wallet.state.hashes.map((h) => H.pub.waitForTransactionReceipt({ hash: h })))
  const gas = rcs.reduce((s, r) => s + r.gasUsed * r.effectiveGasPrice, 0n)
  const tW1 = await H.bal(H.WETH, T1), tU1 = await H.bal(H.USDC, T1), xW1 = await H.bal(H.WETH, X), eth1 = await H.pub.getBalance({ address: T1 })
  const shown = /costo di rete ([\d.,]+) ETH/.exec(done.sub)?.[1]?.replace(/\./g, '').replace(',', '.')
  check('F5a: race → "Scambio parziale completato"; the lost order is reported as failed with gas paid',
    raced && done.title === 'Scambio parziale completato' && /transazione fallita, hai pagato il costo di rete/.test(done.lines) && rcs.filter((r) => r.status === 'reverted').length === 1, `${done.title} | ${done.lines.slice(0, 120)}`)
  check('F5b: balances and costs exact — taker +0,1 WETH −240 USDC; third account +0,1 WETH; gas shown = Σ receipts = ETH spent',
    tW1 - tW0 === H.E18 / 10n && tU0 - tU1 === 240n * H.E6 && xW1 - xW0 === H.E18 / 10n && eth0 - eth1 === gas && gas > 10n ** 14n && Number(shown) === Number(Number(formatUnits(gas, 18)).toFixed(6)),
    `taker +${W(tW1 - tW0)} WETH −${U(tU0 - tU1)} USDC; X +${W(xW1 - xW0)}; gas ${W(gas)} ETH (${rcs.length} tx), shown ${shown}`)
  await t.page.click('#c-done-btn')
})

// ================================================================================== F6 private offer (second book)
await flow('F6', async () => {
  const m = await open(appB.url, M2, 'M2-B')
  const err = await H.publish(m.page, { amount: '0,1', price: '2300', counterparty: T2 })
  const pv = (await bookB.api(`/orders?chainId=1&signer=${M2}`)).body.orders.find((o) => o.order.senderWallet.toLowerCase() === T2.toLowerCase())
  const inBook = (await bookB.api(`/book?chainId=1&base=${H.WETH}&quote=${H.USDC}`)).body
  await m.page.locator('#offers-d article.offer[data-private] button[data-act="link"]').click()
  const link = await m.page.evaluate(() => navigator.clipboard.readText())
  check('F6a: private offer published on the second book: not in its book, link to it copied from "Le mie offerte"',
    !err && pv?.status === 'open' && !inBook.asks.some((a) => a.hash === pv.hash) && link === `${appB.url}#offerta=${pv.hash}`, err ?? link)
  const wrong = await open(link, T1, 'T1-B')
  const wrongToast = await H.until(async () => { const t = await wrong.page.textContent('#toast-t'); return /non è per te/.test(t ?? '') ? t : null }, 20_000, 'not for you').catch(() => '')
  let onchainRefused = false
  try { await H.pub.simulateContract({ account: T1, address: SWAP, abi: swapAbi, functionName: 'swap', args: [T1, BigInt(pv.order.nonce), BigInt(pv.order.expiry), M2, H.WETH, BigInt(pv.order.signerAmount), H.USDC, BigInt(pv.order.senderAmount), 27, '0x' + '0'.repeat(64), '0x' + '0'.repeat(64)] }) } catch { onchainRefused = true }
  const full = (await bookB.api(`/orders/${pv.hash}`)).body.order
  try { await H.pub.simulateContract({ account: T1, address: SWAP, abi: swapAbi, functionName: 'swap', args: [T1, BigInt(full.nonce), BigInt(full.expiry), full.signerWallet, full.signerToken, BigInt(full.signerAmount), full.senderToken, BigInt(full.senderAmount), Number(full.v), full.r, full.s] }); onchainRefused = false } catch { onchainRefused = onchainRefused && true }
  const t2 = await open(link, T2, 'T2-B')
  await H.until(async () => (await t2.page.textContent('#c-title'))?.includes('Offerta privata') && (await t2.page.textContent('#c-qs'))?.trim() === 'Verificato', 30_000, 'private confirm')
  const w0 = { t: await H.bal(H.WETH, T2), tu: await H.bal(H.USDC, T2), m: await H.bal(H.USDC, M2) }
  const done = await H.confirmAndWait(t2.page)
  const w1 = { t: await H.bal(H.WETH, T2), tu: await H.bal(H.USDC, T2), m: await H.bal(H.USDC, M2) }
  check('F6b: the link opens it only for the counterparty (another account: refused in the app and on-chain); the counterparty executes it — balances exact',
    /non è per te/.test(wrongToast) && onchainRefused && done.title === 'Scambio completato' && w1.t - w0.t === H.E18 / 10n && w0.tu - w1.tu === 230n * H.E6 && w1.m - w0.m === 230n * H.E6,
    `other: "${wrongToast}"; T2 +${W(w1.t - w0.t)} WETH −${U(w0.tu - w1.tu)} USDC; M2 +${U(w1.m - w0.m)} USDC`)
  await t2.page.click('#c-done-btn')
})

// ================================================================================== F7 rejection, then timeout
await flow('F7', async () => {
  const m1 = sessions.find((s) => s.label === 'M1'), m2 = sessions.find((s) => s.label === 'M2')
  await H.publish(m1.page, { amount: '0,1', price: '2200' })
  await H.publish(m2.page, { amount: '0,1', price: '2210' })
  let swaps = 0
  const t = await open(appA.url, T2, 'T2-reject', { beforeSend: async (tx) => (tx.to?.toLowerCase() === SWAP.toLowerCase() && ++swaps === 1 ? 'reject' : undefined) })
  const w0 = { W: await H.bal(H.WETH, T2), U: await H.bal(H.USDC, T2) }
  await H.until(async () => (await t.page.locator('#asks .lvl').count()) >= 2, 15_000, 'two asks')
  await H.review(t.page, '441')
  const d1 = await H.confirmAndWait(t.page)
  const swapsSent1 = t.wallet.state.sent.filter((x) => x.to?.toLowerCase() === SWAP.toLowerCase()).length
  check('F7a: signature of the 1st swap rejected in the wallet → the app stops, the 2nd order is never sent, balances untouched',
    d1.title === 'Nessuno scambio eseguito' && /Firma rifiutata nel wallet/.test(d1.lines) && swapsSent1 === 0 && swaps === 1 && (await H.bal(H.WETH, T2)) === w0.W && (await H.bal(H.USDC, T2)) === w0.U,
    `${d1.title} | ${d1.lines.slice(0, 90)} | swaps sent ${swapsSent1}`)
  await t.page.click('#c-done-btn')
  // timeout: a new page on the instance with txTimeoutSec 8, automine off while the 1st swap is pending
  const t8 = await open(appA8.url, T2, 'T2-timeout')
  await H.until(async () => (await t8.page.locator('#asks .lvl').count()) >= 2, 15_000, 'two asks')
  await H.review(t8.page, '441')
  await H.test.setAutomine(false)
  const t0 = Date.now()
  const d2 = await H.confirmAndWait(t8.page, 60_000)
  const waited = Date.now() - t0
  const swapsSent2 = t8.wallet.state.sent.filter((x) => x.to?.toLowerCase() === SWAP.toLowerCase()).length
  const pendingBefore = (await H.pub.request({ method: 'txpool_status' }).catch(() => ({ pending: '?' }))).pending
  await H.test.setAutomine(true); await H.test.mine({ blocks: 1 })
  await H.sleep(500)
  check('F7b: no confirmation within txTimeoutSec (8 s, automine off) → the app stops after the 1st swap, the 2nd is never sent',
    /Nessuna conferma entro il tempo limite/.test(d2.lines) && swapsSent2 === 1 && waited >= 8000 && waited < 40_000, `${d2.title} | ${d2.lines.slice(0, 100)} | swaps sent ${swapsSent2}, ${Math.round(waited / 1000)} s, txpool ${pendingBefore}`)
  const w2 = { W: await H.bal(H.WETH, T2) }
  check('F7c: once blocks resume the pending swap is mined (exactly one order filled): +0,1 WETH', w2.W - w0.W === H.E18 / 10n, `+${W(w2.W - w0.W)} WETH`)
  await t8.page.click('#c-done-btn').catch(() => {})
})

// ================================================================================== F8 chain switch
await flow('F8', async () => {
  const t = sessions.find((s) => s.label === 'T1')
  const before = await t.page.evaluate(() => ({ chain: window.__fondaco.backend.chainId(), mev: window.__fondaco.backend.protection().level, mk: window.__fondaco.backend.markets().length }))
  await t.wallet.setChain(8453)
  await H.until(async () => (await t.page.textContent('#net-lbl'))?.includes('Base'), 15_000, 'Base label')
  await H.until(async () => /Contratto non configurato su Base/.test((await t.page.textContent('#banners')) ?? ''), 15_000, 'not deployed banner')
  const after = await t.page.evaluate(() => ({ chain: window.__fondaco.backend.chainId(), mev: window.__fondaco.backend.protection().level, mk: window.__fondaco.backend.markets().length, swap: window.__fondaco.backend.swapAddress() }))
  await t.page.click('#wal-chip')
  const sheet = (await t.page.textContent('#w-stat')).replace(/\s+/g, ' ')
  const netChecked = await t.page.evaluate(() => document.querySelector('#w-net input[name="wnet"]:checked')?.value)
  await t.page.click('#w-close')
  await t.page.click('[data-tab="swap"]').catch(() => {})
  const cta = await t.page.isDisabled('#review')
  check('F8a: wallet 1 → 8453: network label, MEV status (L2, sequencer), configuration (no contract on Base → banner, no markets, trading off) follow',
    before.chain === 1 && before.mev !== 'l2' && after.chain === 8453 && after.mev === 'l2' && after.mk === 0 && after.swap === null && netChecked === '8453' && cta,
    `MEV ${before.mev} → ${after.mev}; markets ${before.mk} → ${after.mk}; sheet "${sheet.slice(0, 80)}"`)
  await t.wallet.setChain(1)
  const back = await H.until(async () => (await t.page.evaluate(() => window.__fondaco.backend.markets().length)) > 0, 15_000, 'back on 1').then(() => true).catch(() => false)
  check('F8b: back to chain 1 → markets and contract again', back && (await t.page.textContent('#net-lbl'))?.includes('Ethereum'))
})

// ================================================================================== F9 book unreachable at start
await flow('F9', async () => {
  const d = await open(appDown.url, T1, 'T1-down', { connect: false, allowed: [/ERR_CONNECTION_REFUSED/] })
  await H.until(async () => /Bacheca non disponibile/.test((await d.page.textContent('#banners')) ?? ''), 15_000, 'banner')
  await H.sleep(1500)
  const asks = await d.page.textContent('#asks'), mk = await d.page.textContent('#m-list')
  await d.page.fill('#pay-in', '10').catch(() => {})
  const errors = d.logs.filter((l) => l.type === 'pageerror' || !/ERR_CONNECTION_REFUSED/.test(l.text))
  check('F9: book unreachable at start → "Bacheca non disponibile" banner, explicit empty state, swap disabled, no unhandled error',
    /Bacheca non raggiungibile/.test(asks) && (await d.page.isDisabled('#review')) && errors.length === 0, `asks "${asks.trim()}"; markets "${mk.trim().slice(0, 40)}"; ${d.logs.length - errors.length} refused connections, other: ${errors.slice(0, 3).map((l) => l.type + ' ' + l.text.slice(0, 80) + ' ' + l.url).join(' | ')}`)
})

// ================================================================================== console
const phaseAt = (t) => [...phases].reverse().find(([, at]) => at <= t)?.[0] ?? '?'
const dirty = sessions.flatMap((s) => H.unexpectedLogs(s.logs, s.allowed).map((l) => `${s.label}@${phaseAt(l.at)}: ${l.type} ${l.text.slice(0, 90)} ${l.url.replace(/^https?:\/\/[^/]+/, '').slice(0, 60)}`))
check(`F10: clean console in all ${sessions.length} pages (no error, no warning; only the refused connections of F9)`, dirty.length === 0, dirty.slice(0, 4).join(' | '))

await H.closeBrowser()
for (const s of [appA, appB, appA8, appDown]) await s.close()
await bookA.stop(); await bookB.stop()
process.exit(finish() ? 0 : 1)
