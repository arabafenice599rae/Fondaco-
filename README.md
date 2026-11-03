# FONDACO

Exchange **P2P non-custodial multi-moneta** su AirSwap **SwapERC20 v5.0.0** (contratto invariato).
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
pnpm verify-source          # Fase 0: bytecode del fixture = sorgente v5.0.0 ricompilato
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

Il contratto deployato è AirSwap **SwapERC20 v5.0.0, non modificato**. Le impostazioni ufficiali di compilazione sono
registrate in [`packages/contracts/compiler-settings.json`](packages/contracts/compiler-settings.json) e usate da
`tools/verify-source`, dallo script di deploy e dalla libreria (`COMPILER_SETTINGS`, `EVM_VERSION`):

| Parametro | Valore |
|---|---|
| Sorgente | `airswap-protocols`, tag `v5.0.0`, commit `28156e5115218a444d35f35162162f643e5ccb91` |
| File | `source/swap-erc20/contracts/SwapERC20.sol`, SHA-256 `5203e5a0…4e64` |
| Dipendenze | solady 0.0.173 (integrità dallo `yarn.lock` del tag) |
| Compilatore | solc **0.8.23** (`commit.f704f362`, SHA-256 `28726a45…5732`) |
| Ottimizzatore | attivo, **999999** run |
| **evmVersion** | **`paris`** |
| Nomi delle unità | come Hardhat (`contracts/SwapERC20.sol`, `solady/src/…`): entrano nell'hash dei metadati |
| Risultato | bytecode di creazione di 12 221 byte, SHA-256 `139ab5cb…3d77` |

`evmVersion: paris` è obbligatorio: è il default di Hardhat per solc 0.8.23 nel repository AirSwap al tag (che non lo imposta),
mentre il default di solc è `shanghai` e produce un bytecode diverso (12 024 byte, con `PUSH0`). La regola è fissata da un test:
`pnpm test:verify-source` controlla che con `paris` il bytecode coincida e che con `shanghai` la verifica **fallisca**.
Effetto pratico: senza `PUSH0`, lo stesso bytecode si può deployare anche su chain che non hanno Shanghai.

Lo script di deploy rifiuta un fixture il cui SHA-256 non coincide con quello registrato.

## Deploy (solo dopo conferma esplicita)

> [!WARNING]
> **Lo script di deploy non è mai stato eseguito su una rete reale.** È stato provato solo su fork locali (anvil).
> Il primo deploy su testnet (Sepolia o Base Sepolia) richiede la conferma esplicita del responsabile del progetto (Fase 7),
> con la checklist di verifica post-deploy. Nessun deploy su mainnet senza un audit di SwapERC20 v5.0.0.

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
