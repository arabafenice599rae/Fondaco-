// Entry point: load config.json, apply the user's settings, start the live backend (or the simulated one in a DEMO=true
// build), the interface and the splash. Impostazioni: book URL and RPC per chain, the contract only behind an explicit warning.
import './fonts.css'
import './prototype.css'
import './app.css'
import { getAddress, isAddress } from 'viem'
import { parseAppConfig, effective, readSettings, writeSettings, clearSettings, validateSettings, type AppConfig, type Settings, type Effective } from './config.js'
import { esc } from './fmt.js'
import { startUI, splash, type UIHandle } from './ui.js'
import type { Backend } from './backend.js'
// static: no extra round trip before the book can be requested (the demo backend stays a separate, dead-code chunk)
import { LiveBackend } from './live.js'

const store = (() => { try { return localStorage } catch { return null } })()
const $ = (id: string) => document.getElementById(id) as HTMLElement

async function boot(): Promise<void> {
  splash()
  let cfg: AppConfig
  try {
    // same request as the <link rel=preload> in index.html (default cache mode: the host should send config.json with no-cache)
    const early = (window as unknown as { __fondacoConfig?: Promise<unknown> }).__fondacoConfig
    cfg = parseAppConfig(await (early ? early.catch(() => fetch('./config.json').then((r) => r.json())) : fetch('./config.json').then((r) => r.json())))
  } catch (e) {
    document.documentElement.classList.remove('booting')
    document.body.insertAdjacentHTML('afterbegin', `<div class="fatal" role="alert"><b>Configurazione non valida</b><pre>${esc((e as Error).message)}</pre></div>`)
    return
  }
  const settings = readSettings(store)
  const eff = effective(cfg, settings)
  let B: Backend
  if (__DEMO__) {
    const { DemoBackend } = await import('./demo.js')
    B = new DemoBackend(eff)
    const badge = $('demo-badge'); badge.hidden = false
    document.documentElement.dataset.demo = 'true'
  } else {
    const live = new LiveBackend(eff)
    B = live
    void live.start()
  }
  let ui: UIHandle | null = null
  ui = startUI(B, { openSettings: () => { renderSettings(cfg, eff, readSettings(store)); ui?.openSheet('ssheet', $('s-book')) } })
  wireSettings(cfg, () => ui?.closeSheet('ssheet'))
  ;(window as unknown as { __fondaco?: unknown }).__fondaco = { backend: B, config: eff }
}

// ------------------------------------------------------------------ Impostazioni

function renderSettings(cfg: AppConfig, eff: Effective, s: Settings): void {
  ;($('s-book') as HTMLInputElement).value = s.book ?? ''
  ;($('s-book') as HTMLInputElement).placeholder = cfg.book || 'https://…'
  $('s-error').hidden = true
  $('s-chains').innerHTML = Object.entries(cfg.chains).map(([id, c]) => {
    const o = s.chains?.[id] ?? {}
    const swapNow = eff.chains[id]?.swap
    return `<div class="box s-chain" data-chain="${id}">
      <div class="box-top"><label for="s-rpc-${id}">RPC di ${esc(c.name)}</label></div>
      <input id="s-rpc-${id}" class="field" data-k="rpc" type="url" inputmode="url" autocomplete="off" spellcheck="false" value="${esc(o.rpc ?? '')}" placeholder="${esc(c.rpc || 'vuoto: le letture passano dal wallet')}">
      <div class="s-contract">
        <span class="s-lbl">Contratto</span>
        <span class="mono s-addr" id="s-addr-${id}">${swapNow ? esc(swapNow) : 'non configurato'}${eff.overridden.swap[id] ? ' <b class="s-mod">modificato</b>' : ''}</span>
        <button type="button" class="link" data-edit="${id}">Modifica</button>
      </div>
      <div class="s-danger" id="s-swap-wrap-${id}" hidden>
        <p class="warn-t"><b>Attenzione.</b> L’app firma le offerte e invia gli scambi a questo indirizzo. Un contratto sbagliato o malevolo può prendere i fondi che autorizzi. Cambialo solo se sai esattamente cosa stai facendo.</p>
        <label class="chk"><input type="checkbox" id="s-ack-${id}"> Ho capito il rischio e voglio usare un altro contratto</label>
        <input id="s-swap-${id}" class="field mono" data-k="swap" type="text" autocomplete="off" spellcheck="false" value="${esc(o.swap ?? '')}" placeholder="${esc(c.swap ?? '0x…')}" disabled>
      </div>
    </div>`
  }).join('')
  const custom = eff.overridden.book || Object.values(eff.overridden.rpc).some(Boolean) || Object.values(eff.overridden.swap).some(Boolean)
  $('s-origin').textContent = __DEMO__ ? 'Versione demo: i dati sono simulati e queste impostazioni non vengono usate.' : custom ? 'Stai usando impostazioni personalizzate, salvate in questo browser.' : `Impostazioni predefinite dell’app${cfg.book ? ` (bacheca ${cfg.book})` : ''}.`
}

function collect(cfg: AppConfig): Settings {
  const s: Settings = {}
  const book = ($('s-book') as HTMLInputElement).value.trim()
  if (book) s.book = book
  for (const id of Object.keys(cfg.chains)) {
    const rpc = (document.getElementById(`s-rpc-${id}`) as HTMLInputElement | null)?.value.trim() ?? ''
    const ack = (document.getElementById(`s-ack-${id}`) as HTMLInputElement | null)?.checked ?? false
    const swap = (document.getElementById(`s-swap-${id}`) as HTMLInputElement | null)?.value.trim() ?? ''
    const c: { rpc?: string; swap?: string } = {}
    if (rpc) c.rpc = rpc
    const prev = readSettings(store).chains?.[id]?.swap
    if (ack) { if (swap) c.swap = isAddress(swap, { strict: false }) ? getAddress(swap) : swap } // acknowledged: the field wins (empty = back to default)
    else if (prev) c.swap = prev // not acknowledged: the stored override stays as it was
    if (c.rpc || c.swap) (s.chains ??= {})[id] = c
  }
  return s
}

function wireSettings(cfg: AppConfig, close: () => void): void {
  $('s-close').addEventListener('click', close)
  $('ssheet').addEventListener('click', (e) => { if (e.target === $('ssheet')) close() })
  $('s-chains').addEventListener('click', (e) => {
    const b = (e.target as Element).closest<HTMLElement>('[data-edit]'); if (!b) return
    const id = b.dataset.edit as string
    const w = $(`s-swap-wrap-${id}`); w.hidden = !w.hidden
  })
  $('s-chains').addEventListener('change', (e) => {
    const t = e.target as HTMLInputElement
    const m = /^s-ack-(\d+)$/.exec(t.id); if (!m) return
    const inp = $(`s-swap-${m[1]}`) as HTMLInputElement
    inp.disabled = !t.checked
    if (t.checked) inp.focus()
  })
  $('s-form').addEventListener('submit', (e) => {
    e.preventDefault()
    const s = collect(cfg)
    // a contract typed without the acknowledgement is refused, never silently dropped
    const unacked = Object.keys(cfg.chains).filter((id) => {
      const v = (document.getElementById(`s-swap-${id}`) as HTMLInputElement | null)?.value.trim()
      return v && v !== readSettings(store).chains?.[id]?.swap && !(document.getElementById(`s-ack-${id}`) as HTMLInputElement).checked
    })
    const errs = [...validateSettings(s, cfg), ...unacked.map((id) => `Contratto di ${cfg.chains[id]?.name}: conferma l’avviso per cambiarlo.`)]
    if (errs.length) { const el = $('s-error'); el.textContent = errs.join(' '); el.hidden = false; return }
    writeSettings(store, s)
    location.reload()
  })
  $('s-reset').addEventListener('click', () => { clearSettings(store); location.reload() })
}

void boot()
