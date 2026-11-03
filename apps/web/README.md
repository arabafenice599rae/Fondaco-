# @fondaco/web

The FONDACO web app is a **static build**: one folder of files, no server process, no API keys. It reproduces the prototype
`docs/reference/mini-exchange.html` (same markup, same CSS, same motion) on real data: the book server for offers, the user's wallet for
everything on-chain, and `@fondaco/client` for execution and protection.

**Framework: none (TypeScript + DOM, built with Vite).** The prototype is already DOM + CSS, so keeping its markup and stylesheet unchanged gives
exact fidelity and a small bundle (≈ 45 kB gzip of our own code, plus viem).

## Build and run

```sh
pnpm --filter @fondaco/web build        # typecheck + dist/
pnpm --filter @fondaco/web build:demo   # DEMO=true → dist-demo/, simulated data, "Demo" label always visible
pnpm --filter @fondaco/web dev          # local development
```

Serve `dist/` with any static host. URLs are relative, so the app also works under a sub-path.

## Configuration

`public/config.json` (copied to `dist/config.json`, editable at deploy time without rebuilding):

| Key | Meaning |
|---|---|
| `book` | URL of the official book server |
| `defaultChain` | initial chain |
| `chains.<id>.rpc` | public RPC for reads (empty: reads go through the wallet). **Never an RPC with a key**: the build is public |
| `chains.<id>.swap` | SwapERC20 address; `null` = not deployed there → trading disabled with an explicit notice |
| `chains.<id>.tokens` | tokens the app shows. A pair appears only if the book lists it **and** both tokens are here: a book cannot add tokens |

**Impostazioni** (gear in the header; on phones, inside the Wallet sheet) lets the user change the book URL and the RPC of each chain. Changes are
stored in this browser (`localStorage` key `fondaco-settings`), and **Ripristina** clears them. The contract address is shown, and can be edited
only after opening an explicit warning and ticking its acknowledgement.

## Trust model

- The app trusts **its own** configuration for the contract and the tokens. If the book declares a different contract, trading is blocked
  ("La bacheca usa un altro contratto").
- Offers are signed with the EIP-712 domain built from the app's contract and chain, never the one the book sends.
- The book can be any server (official or not). It decides which offers exist, never where the funds go.

## What the app tells the user

| Condition | Banner | Trading |
|---|---|---|
| book unreachable / not configured | Bacheca non disponibile | blocked |
| `GET /book` → 503 `stale` | **Dati non aggiornati** | blocked |
| SSE down (reconnecting, 1 s → 30 s) | Connessione alla bacheca interrotta | allowed (prices re-verified at confirmation) |
| contract mismatch app ↔ book | La bacheca usa un altro contratto | blocked |
| `protocolFeeLight ≠ protocolFee` in `/config`, or an SSE `governance` event | Parametri del contratto modificati | allowed, with warning |
| no market between configured tokens | Nessun mercato (empty state) | blocked |

My offers that the book considers dead (`invalid_signer`) but that are still `executableOnChain` show
"Questa offerta può ancora essere eseguita" with **Annulla ora**, a protected on-chain `cancel`.

## Tests

| Command | What it does |
|---|---|
| `pnpm --filter @fondaco/web typecheck` | strict TypeScript |
| `pnpm --filter @fondaco/web test:unit` | state logic: indicative/verified quote, order and offer states, exact ladder terms, chart series, banners, settings, API client (stale, ETag, SSE backoff) |
| `pnpm --filter @fondaco/web test:keys` | builds production and demo, fails on `alchemy`, `infura`, `sk_`, `apiKey=` or key-bearing RPC URLs; self-tests the scanner; checks the demo code is absent from production |
| `node tools/testkit/run-suites.mjs web-e2e` | Playwright on anvil + **two** book servers + the static build + an injected EIP-6963 wallet (see below) |

The e2e test (`test/e2e.mjs`) covers:
- publishing an offer from the app (exact approve, EIP-712, POST);
- buying it from a second account, with exact balances and the fee paid by the signer;
- the fill indexed in `/trades` and `/candles` (ETag 304);
- switching to a second book in Impostazioni, publishing and buying there, then Ripristina;
- a governance change on-chain → banner;
- a stale book → banner with trading blocked.

The injected wallet forwards to anvil's unlocked dev accounts, so no key is used.

Screenshots: `node scripts/screenshots.mjs` → `docs/screenshots/` (demo build, 390 and 1440 px).
