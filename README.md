<div align="center">

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/assets/fondaco-logo-dark.svg">
  <source media="(prefers-color-scheme: light)" srcset="docs/assets/fondaco-logo-light.svg">
  <img alt="FONDACO" src="docs/assets/fondaco-logo-light.svg" width="440">
</picture>

### Exchange P2P non-custodial multi-moneta. Il prezzo lo fate voi.

[![verify](https://github.com/arabafenice599rae/Fondaco-/actions/workflows/verify.yml/badge.svg)](https://github.com/arabafenice599rae/Fondaco-/actions/workflows/verify.yml)
![contratto](https://img.shields.io/badge/contratto-AirSwap%20SwapERC20%20v4.3-7C93FF)
![fee](https://img.shields.io/badge/fee-0%2C30%25%20solo%20se%20eseguita-F4AE52)
![node](https://img.shields.io/badge/node-22.23.4-3c873a)
![pnpm](https://img.shields.io/badge/pnpm-10-f69220)

[Come funziona](#come-funziona) · [Avvio rapido](#avvio-rapido) · [Verifica](#verifica-e-ci) · [Contratto e audit](#contratto-e-audit) · [Rilascio](#rilascio) · [Documentazione](#documentazione)

</div>

---

## Cos'è

FONDACO è un exchange **peer-to-peer** in cui nessuno custodisce i fondi di nessuno.

- **Chi propone** firma un'offerta gratis, fuori catena (EIP-712), e paga lo **0,30%** solo se l'offerta viene eseguita.
- **Chi accetta** paga il prezzo e il gas: lo scambio avviene in una sola transazione, direttamente tra i due wallet.
- **Il contratto** è AirSwap **SwapERC20 v4.3**, **non modificato**: lo stesso bytecode deployato da AirSwap su Ethereum e Base.
- **La bacheca** raccoglie e verifica le offerte, ma non custodisce nulla e non firma nulla. Chiunque può farne girare una.

## Come funziona

```
 browser ──────────────── app statica (apps/web: TypeScript + DOM, Vite) ── IPFS / hosting classico, stesso build
   │  EIP-6963 wallet           │ boot.js: /config + /books in un round trip
   │  (firma EIP-712, tx)       ▼
   │                      bacheca (packages/book-server)  ── Caddy (TLS) ── backup orario S3 (SigV4)
   │                        node:sqlite (WAL, migrazioni), indicizzazione,
   │                        fail-closed, SSE, /trades /candles, Prometheus
   ▼                              │ RPC con riserva
 SwapERC20 v4.3 (AirSwap, invariato) ◄──────────┘
   owner = Safe, fee 30/30, staking 0, bonus 0
 client (packages/client): plan / verify / execute, invio protetto, guardie di prezzo e destinatario, MEV per wallet
```

| Principio | In pratica |
|---|---|
| **Nessun Solidity di produzione nostro** | Il fixture è ricompilato dal tag v4.3 e confrontato byte per byte con il deploy AirSwap. |
| **La bacheca non è fidata** | Può nascondere o ritardare offerte, non cambiarle: l'app verifica ogni offerta on-chain prima di eseguirla. |
| **L'app si fida solo della propria configurazione** | Contratto e monete vengono da `config.json`, mai dalla bacheca. |
| **Build riproducibile** | Lo stesso commit dà lo stesso hash dell'albero e lo stesso CID IPFS, verificato da due job separati del CI. |

## Avvio rapido

**Requisiti**
- Node 22.23.4 (`.nvmrc`) e pnpm 10 (`corepack enable`);
- Foundry (`anvil`), testato con 1.5.1-stable; `ANVIL_BIN` per un percorso diverso;
- un RPC mainnet **con stato archivio**, in sola lettura e solo per il fork locale: `MAINNET_RPC_URL` in `.env`.

```bash
git clone https://github.com/arabafenice599rae/Fondaco-.git && cd Fondaco-
git submodule update --init           # forge-std, solo per i test Foundry
cp .env.example .env                  # MAINNET_RPC_URL (il blocco del fork è in fork.config.json)
pnpm install --frozen-lockfile

pnpm verify-source                    # fixture = sorgente v4.3 ricompilato = codice deployato da AirSwap (Ethereum, Base)
pnpm test                             # build, ABI, unit, verify-source, tutte le suite su fork
pnpm test:fork e2e engine             # solo alcune suite
```

**Bacheca in locale**

```bash
pnpm build
cp packages/book-server/config.example.json packages/book-server/config.json   # contratto, RPC, token
pnpm --filter @fondaco/book-server start
```

Per l'app web vedi [`apps/web/README.md`](apps/web/README.md); per far girare una bacheca in produzione (Docker, Caddy,
backup) vedi [`docs/OPERATIONS.md`](docs/OPERATIONS.md).

## Struttura del repository

| Percorso | Contenuto |
|---|---|
| [`apps/web`](apps/web) | app web statica: Vite, TypeScript senza framework, wallet EIP-6963 |
| [`packages/book-server`](packages/book-server) | bacheca: Node, `viem`, `node:sqlite` in WAL |
| [`packages/client`](packages/client) | libreria del taker: `plan`, `verify`, `execute`, invio protetto, guardie |
| [`packages/contracts`](packages/contracts) | fixture SwapERC20 verificato, script di deploy e di rilascio, test Foundry |
| [`deploy`](deploy) | immagine Docker della bacheca, compose con Caddy e backup, MinIO per lo smoke test |
| [`tools`](tools) | `verify-source`, testkit (fork anvil, runner delle suite), build riproducibile, IPFS, CI |
| [`docs`](docs) | decisioni, modello delle minacce, operazioni, rilascio, audit |

## Verifica e CI

Il CI è il workflow [`verify`](.github/workflows/verify.yml), autosufficiente: la composite action
[`setup-toolchain`](.github/actions/setup-toolchain) installa versioni bloccate (in [`tools/ci/toolchain.json`](tools/ci/toolchain.json))
e fallisce se una non corrisponde.

| Quando | Cosa gira |
|---|---|
| **Pull request** | profilo rapido: suite lente saltate nei job unit e fork, Foundry `ci-quick`, RPC pubblico con 3 tentativi per suite |
| **Notte**, 02:17 UTC (`cron: "17 2 * * *"`) | tutto, Foundry completo, RPC d'archivio dal secret `FORK_RPC_URL` |
| **A mano** | Actions → verify → Run workflow, oppure `gh workflow run verify.yml -f suite=full [-f fork_block=23700000] [-f ref=<branch o commit>]`; `suite`: `quick`, `full`, `contracts`, `book-server`, `client`, `web` |
| **Tag `v*`** | tutto, poi `docker-publish` pubblica l'immagine della bacheca su GHCR |

<details>
<summary><b>Job del workflow</b></summary>

| Job | Cosa fa |
|---|---|
| `toolchain` | piano della run, cache riscaldate |
| `lint` | build, typecheck, file generati, lint, checksum |
| `unit` | bacheca, client e contratti, compresa la verifica del sorgente contro il deploy AirSwap |
| `fork` | anvil al blocco fisso, un fork nuovo per suite |
| `foundry` | test e invarianti del contratto |
| `web-e2e` | Playwright, Lighthouse, axe, layout (con webfont e con woff2 bloccati), regressione visiva, flussi; nell'immagine `mcr.microsoft.com/playwright:v1.63.0-noble` bloccata per digest |
| `supply-chain` | `pnpm audit`, lockfile bloccato, gitleaks sull'intera storia, SHA256SUMS |
| `reproducible-build-a/b`, `reproducible-compare` | due build separati: stesso hash dell'albero, stesso CID IPFS |
| `docker` | immagine della bacheca e smoke test del compose; backup verso lo stub SigV4 e verso MinIO compilato dal tag (binario in cache) |
| `docker-publish` | solo su `main` o tag `v*`: pubblica su GHCR e riporta il digest |

</details>

- **Concorrenza:** le run di PR e di push di uno stesso ref si sostituiscono con il commit più nuovo; le run manuali e quella
  notturna non si cancellano mai a vicenda (D-60).
- **Segreti:** `FORK_RPC_URL` (RPC mainnet d'archivio; senza, RPC pubblico con tentativi ripetuti) e `BASE_RPC_URL`
  (facoltativo, per il confronto con il deploy su Base).
- **Riepilogo:** ogni job scrive nella pagina della run suite, controlli, tempi, versioni degli strumenti e hash del build;
  gli artefatti `reports-*` contengono Lighthouse, layout, accessibilità, differenze visive, screenshot e log di anvil.

**In locale**

```bash
node tools/testkit/run-suites.mjs [--group …] [--profile quick] [--retries N] [suite …]
node tools/testkit/in-playwright.mjs <comando>      # qualunque comando nell'immagine Playwright del CI
pnpm --filter @fondaco/web test:visual:update       # rigenera le baseline visive, nello stesso container
```

La regressione visiva gira solo nell'immagine Playwright del CI, così le baseline sono una sola serie per tutte le
macchine; lanciata fuori, `web-visual` si rilancia da sola nel container (serve Docker). La prova di carico (circa 3 minuti)
è fuori da `pnpm test`: `node tools/load/load-test.mjs`, risultati in [`docs/LOAD.md`](docs/LOAD.md).

## La bacheca

TypeScript strict compilato in `packages/book-server/dist`; unica dipendenza di runtime di terzi: `viem`.

| Aspetto | Comportamento |
|---|---|
| **Configurazione** | validata all'avvio; chiavi sconosciute e valori errati elencati tutti insieme, con il percorso. Riferimento: [`docs/CONFIG.md`](docs/CONFIG.md) |
| **Database** | SQLite in WAL, migrazioni versionate applicate all'avvio; un database più nuovo del codice viene rifiutato |
| **Reorg** | rollback degli ultimi `reorgDepth` blocchi (default 64); su chain con finalità più lenta va alzato. Una reorg più profonda si ripara da backup |
| **Fail-closed** | se l'indicizzazione non riesce per `maxStalenessMs` (default 120 s), `/book` e `/books` rispondono `503 stale` |
| **`GET /books`** | fino a 10 coppie in una richiesta, per la prima schermata dell'app |
| **Cambio di fee** | un ordine rifirmato con lo stesso nonce sostituisce quello `invalid_fee`: al massimo un'esecuzione per nonce |
| **Log e metriche** | JSON su stdout; `GET /metrics` Prometheus **spento di default**, accessibile solo da allow-list o con token |

## Contratto e audit

Il contratto deployato è AirSwap **SwapERC20 v4.3, non modificato**. Le impostazioni di compilazione sono in
[`packages/contracts/compiler-settings.json`](packages/contracts/compiler-settings.json).

| Parametro | Valore |
|---|---|
| Sorgente | `airswap-protocols`, tag `v4.3`, commit `6ad0137fa62ab2bd9eead257b77b8f77962d0bf3` |
| File | `source/swap-erc20/contracts/SwapERC20.sol`, SHA-256 `4103d213…3a36` |
| Dipendenze | solady 0.0.173 (integrità dallo `yarn.lock` del tag) |
| Compilatore | solc **0.8.23** (`commit.f704f362`, SHA-256 `28726a45…5732`), ottimizzatore attivo, **999999** run |
| **evmVersion** | **`paris`**: con il default `shanghai` il bytecode è diverso (11 930 byte, con `PUSH0`); un test lo verifica |
| Risultato | creazione 12 123 byte (SHA-256 `45dffc57…6109`), runtime 11 264 byte |

**È il contratto che AirSwap ha deployato** come "V5.0" a `0xD82E10B9A4107939e55fCCa9B53A9ede6CF2fC46`. `verify-source`
confronta il runtime ricompilato con `eth_getCode` su Ethereum e su Base: identico, metadati compresi. Sourcify riporta
*exact match* su entrambe le chain (D-40).

**Audit:** [PeckShield, report #2024-047 "AirSwap V4.3"](docs/audits/), 23 aprile 2024 (SHA-256 del PDF in
`docs/audits/SHA256SUMS`).

| Rilievo | Gravità | Oggetto | Stato |
|---|---|---|---|
| PVE-001 Repeated `available()` calculation | Low | Staking (non usato) | Resolved |
| PVE-002 Revisited staking duration update | Informational | Staking (non usato) | Resolved / confirmed |
| PVE-003 Improved order validation in `check()` | Informational | Swap, SwapERC20 | Resolved |

Dal commit esaminato dopo le correzioni (`27b60da`) al sorgente deployato (`6ad0137`) cambia **solo la stringa di versione
del dominio EIP-712**, `"4.2"` → `"4.3"`.

> [!IMPORTANT]
> **Riserva sull'audit.** Il passaggio da OpenZeppelin a solady (#1293, `a145565`) sta tra il commit esaminato (`bcd4c48`)
> e quello post-correzioni (`27b60da`); il report non dice se quel cambio è stato riesaminato. Il diff completo è in
> [`docs/audits/`](docs/audits/), le differenze con la v5.0.0 in [`docs/AUDIT-DIFF.md`](docs/AUDIT-DIFF.md).

Il modello delle minacce, con ogni mitigazione collegata al test che la copre, è in [`docs/THREAT_MODEL.md`](docs/THREAT_MODEL.md).

## Rilascio

> [!WARNING]
> **Nessun deploy è mai stato eseguito su una rete reale.** Lo script è stato provato solo su fork locali di Sepolia e Base
> Sepolia. Deploy su testnet, pubblicazione su IPFS e record ENS richiedono la conferma esplicita del responsabile, con la
> procedura di [`docs/RELEASE.md`](docs/RELEASE.md).

```bash
# prova a vuoto: legge soltanto, non firma e non invia nulla
RPC_URL=… DEPLOYER=0x… FEE_BPS=30 FEE_WALLET=0xSafeFee OWNER=0xSafe pnpm --filter @fondaco/contracts run deploy --dry-run
# deploy vero: chiave dedicata al nonce 0; CONFIRM_CHAIN_ID deve coincidere con la chain dell'RPC
RPC_URL=… PRIVATE_KEY=… CONFIRM_CHAIN_ID=11155111 FEE_BPS=30 FEE_WALLET=… OWNER=… pnpm --filter @fondaco/contracts run deploy
```

Lo script è idempotente: con un deploy coerente già fatto verifica soltanto; se un'esecuzione si è interrotta dopo il deploy
completa il passaggio di ownership; in ogni altro caso si rifiuta. Dopo il deploy, `post-deploy-check.mjs` controlla
indirizzo al nonce 0, runtime, owner = Safe, fee 30/30, staking e bonus a 0, `DOMAIN_SEPARATOR` (C1–C6).

## Documentazione

| Documento | Contenuto |
|---|---|
| [`REPORT.md`](REPORT.md) | report finale: architettura, risultati per fase, deviazioni, rischi residui |
| [`CHANGELOG.md`](CHANGELOG.md) | cosa è cambiato, fase per fase |
| [`docs/DECISIONS.md`](docs/DECISIONS.md) | decisioni prese (D-01 … D-60) e punti aperti |
| [`docs/THREAT_MODEL.md`](docs/THREAT_MODEL.md) | asset, attori, rischi e mitigazioni con i test |
| [`docs/OPERATIONS.md`](docs/OPERATIONS.md) | far girare una bacheca: configurazione, backup, aggiornamenti, reorg |
| [`docs/RELEASE.md`](docs/RELEASE.md) | testnet, IPFS, ENS, dominio: procedure e checklist |
| [`docs/CONFIG.md`](docs/CONFIG.md) | riferimento completo della configurazione della bacheca |
| [`docs/AUDIT-DIFF.md`](docs/AUDIT-DIFF.md) | differenze tra la v4.3 deployata e la v5.0.0 |
| [`docs/PHASE6-RESULTS.md`](docs/PHASE6-RESULTS.md) | numeri dei test avanzati dell'app (prestazioni, accessibilità, layout) |

## Stato del progetto

- **Fasi 0–7 completate:** contratto verificato, bacheca, client, app, test avanzati, sicurezza e rilascio.
- **In attesa:** deploy su Sepolia e Base Sepolia, pubblicazione su IPFS, contenthash ENS di `fondaco.eth`.
- **Prossimi passi:**
  - EIP-5792 per approvare e scambiare con una sola conferma;
  - un wallet integrato opzionale;
  - il Wrapper per l'ETH nativo;
  - un parere legale prima della mainnet.
