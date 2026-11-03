# FONDACO

Exchange **P2P non-custodial multi-moneta** su AirSwap **SwapERC20 v4.3** (contratto invariato).
Chi propone firma gratis e paga lo 0,30% solo se l'offerta viene eseguita; chi accetta paga prezzo e gas.

## Struttura (monorepo pnpm)

| Percorso | Contenuto |
|---|---|
| `packages/contracts` | fixture SwapERC20 (bytecode verificato), script di deploy, test fee e deploy |
| `packages/book-server` | book server (Node, viem, `node:sqlite` WAL) |
| `packages/client` | `taker`, `protect`, `wallet-protection` |
| `apps/web` | app web statica (Vite, TypeScript senza framework): `apps/web/README.md` |
| `tools/verify-source` | ricompila SwapERC20 dal tag e confronta il bytecode |
| `tools/testkit` | fork di mainnet con anvil a blocco fisso, wallet casuali, saldi di test, runner delle suite |
| `docs/reference` | materiale di partenza: prototipo `mini-exchange.html`, README originale |
| `docs/DECISIONS.md` | decisioni prese e punti aperti |

## Requisiti

- Node ≥ 22.13, pnpm 10 (`corepack enable`)
- Foundry (`anvil`) — testato con 1.5.1-stable; `ANVIL_BIN` per un percorso diverso
- git, tar
- un RPC mainnet **con stato archivio** solo per il fork locale (sola lettura): `MAINNET_RPC_URL` in `.env`

```bash
cp .env.example .env        # MAINNET_RPC_URL (il blocco del fork è in fork.config.json)
pnpm install --frozen-lockfile
pnpm verify-source          # bytecode del fixture = sorgente v4.3 ricompilato = codice deployato da AirSwap (Ethereum, Base)
pnpm test                   # build, ABI, unit, verify-source (positivo e negativo), tutte le suite su fork
pnpm test:fork e2e engine   # solo alcune suite
```

Il runner (`tools/testkit/run-suites.mjs`) esegue le suite unitarie senza chain e quelle su fork con un anvil nuovo per suite;
i conteggi finiscono in `reports/tests.json`, la verifica del sorgente in `reports/verify-source.json`.
Dopo il clone: `git submodule update --init` (forge-std, solo per i test Foundry).
Prova di carico (fuori da `pnpm test`, ~3 minuti): `node tools/load/load-test.mjs` → `reports/load.json`; risultati commentati in [`docs/LOAD.md`](docs/LOAD.md).

## Book server

TypeScript strict compilato in `packages/book-server/dist`; unica dipendenza di runtime di terzi: `viem`.

```bash
pnpm build
cp packages/book-server/config.example.json packages/book-server/config.json   # indirizzo del contratto, RPC, token
pnpm --filter @fondaco/book-server start
```

- **Configurazione**: validata all'avvio; chiavi sconosciute e valori errati sono elencati tutti insieme con il loro percorso.
  Riferimento completo con i default: [`docs/CONFIG.md`](docs/CONFIG.md) (generato dallo schema).
- **Database**: SQLite in WAL, migrazioni versionate (`PRAGMA user_version` + tabella `schema_migrations`) applicate all'avvio;
  un database del server JavaScript di riferimento viene riconosciuto e migrato; uno più nuovo del codice viene rifiutato.
- **Reorg**: il server riporta indietro gli ultimi `reorgDepth` blocchi (default 64 = finalità di Ethereum). Una reorg più profonda non viene
  corretta (comportamento documentato, test `reorg` R4): **su una chain con finalità più lenta `reorgDepth` va alzato** di conseguenza.
- **Fail-closed**: se nessun giro di indicizzazione riesce per `maxStalenessMs` (default 120 s), `/book` risponde `503 stale`.
- **Log**: JSON su stdout, un oggetto per riga (`log.level`).
- **Metriche**: `GET /metrics` in formato Prometheus, **spento di default** (`metrics.enabled`). Acceso, risponde solo alle reti in
  `metrics.allow` (indirizzo diretto del client, mai `X-Forwarded-For`) o con `Authorization: Bearer <metrics.token>`.
  Serie principali: `fondaco_tick_rpc_requests` e `fondaco_tick_duration_seconds` per tipo di giro (idle, incremental, full),
  `fondaco_orders` per stato, `fondaco_reorgs_total`, `fondaco_http_request_duration_seconds` per route, `fondaco_rpc_requests_total`.

## Riproducibilità del bytecode

Il contratto deployato è AirSwap **SwapERC20 v4.3, non modificato**. Le impostazioni ufficiali di compilazione sono
registrate in [`packages/contracts/compiler-settings.json`](packages/contracts/compiler-settings.json) e usate da
`tools/verify-source`, dallo script di deploy e dalla libreria (`COMPILER_SETTINGS`, `EVM_VERSION`):

| Parametro | Valore |
|---|---|
| Sorgente | `airswap-protocols`, tag `v4.3`, commit `6ad0137fa62ab2bd9eead257b77b8f77962d0bf3` |
| File | `source/swap-erc20/contracts/SwapERC20.sol`, SHA-256 `4103d213…3a36` |
| Dipendenze | solady 0.0.173 (integrità dallo `yarn.lock` del tag) |
| Compilatore | solc **0.8.23** (`commit.f704f362`, SHA-256 `28726a45…5732`) |
| Ottimizzatore | attivo, **999999** run |
| **evmVersion** | **`paris`** |
| Nomi delle unità | come Hardhat (`contracts/SwapERC20.sol`, `solady/src/…`): entrano nell'hash dei metadati |
| Risultato | bytecode di creazione di 12 123 byte, SHA-256 `45dffc57…6109`; runtime di 11 264 byte |

`evmVersion: paris` è obbligatorio: è il default di Hardhat per solc 0.8.23 nel repository AirSwap al tag (che non lo imposta),
mentre il default di solc è `shanghai` e produce un bytecode diverso (11 930 byte, con `PUSH0`). La regola è fissata da un test:
`pnpm test:verify-source` controlla che con `paris` il bytecode coincida e che con `shanghai` la verifica **fallisca**.
Effetto pratico: senza `PUSH0`, lo stesso bytecode si può deployare anche su chain che non hanno Shanghai.

### È il contratto che AirSwap ha deployato

Questo sorgente è quello che AirSwap ha deployato come **"V5.0"** a `0xD82E10B9A4107939e55fCCa9B53A9ede6CF2fC46`.
`verify-source` (passo 7) confronta il runtime ricompilato con `eth_getCode` su **Ethereum** e su **Base**: è identico, e lo
è anche l'hash dei metadati (11 264 byte su entrambe). Le due immutabili lette on-chain sono `DOMAIN_CHAIN_ID` (1 e 8453) e
`DOMAIN_SEPARATOR`, ricalcolato da `SWAP_ERC20` / `4.3` / chain / indirizzo. Sourcify riporta *exact match* per creazione e
runtime su entrambe le chain. Il confronto è registrato in [`docs/DECISIONS.md`](docs/DECISIONS.md) (D-40).

### Audit

[PeckShield, report #2024-047 "AirSwap V4.3"](docs/audits/), 23 aprile 2024, linkato da AirSwap nella pagina dei deployment.
SHA-256 del PDF: `d1ccb9b3b56d88f6c96a744d5992ec023aeeb20b9b00b7246ffed36b000503e2` (`docs/audits/SHA256SUMS`).

| | |
|---|---|
| Commit esaminato | `bcd4c48` (SwapERC20, Swap, adapter, Staking, Registry) |
| Commit dopo le correzioni | `27b60da` |
| Differenza con il sorgente deployato (`6ad0137`) | **solo la stringa di versione del dominio EIP-712 `"4.2"` → `"4.3"`** (più commenti); interfaccia invariata; solady 0.0.172 → 0.0.173 con i sei file importati identici byte per byte. Diff in [`docs/audits/`](docs/audits/) |

| Rilievo | Gravità | Oggetto | Stato |
|---|---|---|---|
| PVE-001 Repeated `available()` calculation | Low | Staking (non lo usiamo) | Resolved (fix `d16d85c`) |
| PVE-002 Revisited staking duration update | Informational | Staking (non lo usiamo) | "Resolved" nella tabella, "confirmed" nel dettaglio |
| PVE-003 Improved order validation in `check()` | Informational | Swap, SwapERC20 | Resolved (fix `bcd4c48`) |

> [!IMPORTANT]
> **Riserva.** Il passaggio da OpenZeppelin a solady (#1293, `a145565`) sta **tra** il commit esaminato (`bcd4c48`) e quello
> post-correzioni (`27b60da`). Il report indica `27b60da` come commit finale ma **non dice se quel cambio è stato riesaminato**.
> Il diff completo `bcd4c48` → `6ad0137` è in `docs/audits/swap-erc20-bcd4c48-to-6ad0137.diff`.

Le differenze tra questa versione e la v5.0.0 (che il progetto usava in precedenza) sono in [`docs/AUDIT-DIFF.md`](docs/AUDIT-DIFF.md).

Lo script di deploy rifiuta un fixture il cui SHA-256 non coincide con quello registrato.

## Deploy (solo dopo conferma esplicita)

> [!WARNING]
> **Lo script di deploy non è mai stato eseguito su una rete reale.** È stato provato solo su fork locali (anvil).
> Il primo deploy su testnet (Sepolia o Base Sepolia) richiede la conferma esplicita del responsabile del progetto (Fase 7),
> con la checklist di verifica post-deploy. Nessun deploy su mainnet senza la conferma del responsabile, tenuto conto della riserva sull'audit (vedi sopra).

```bash
# prova a vuoto: legge soltanto, non firma e non invia nulla (basta l'indirizzo del deployer)
RPC_URL=… DEPLOYER=0x… FEE_BPS=30 FEE_WALLET=0xSafeFee OWNER=0xSafe pnpm --filter @fondaco/contracts run deploy --dry-run
# deploy vero: chiave dedicata al nonce 0, CONFIRM_CHAIN_ID deve coincidere con la chain dell'RPC
RPC_URL=… PRIVATE_KEY=… CONFIRM_CHAIN_ID=11155111 FEE_BPS=30 FEE_WALLET=… OWNER=… pnpm --filter @fondaco/contracts run deploy
```

Lo script è idempotente: con un deploy già fatto e coerente non invia nulla e verifica soltanto; se una esecuzione si è
interrotta dopo il deploy completa il passaggio di ownership; in ogni altro caso si rifiuta. Il Wrapper non viene mai deployato (escluso dalla v1).
Controlli dopo il deploy: owner = Safe, `protocolFee` = `protocolFeeLight` = 30, `protocolFeeWallet`, `stakingToken` = 0,
`bonusMax` = `bonusScale` = 0, `DOMAIN_SEPARATOR` atteso per chain e indirizzo, `ORDER_TYPEHASH`.
