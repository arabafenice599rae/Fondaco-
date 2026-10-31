# Changelog

Formato: [Keep a Changelog](https://keepachangelog.com/it/1.1.0/). Le fasi seguono il piano di lavoro.

## [Fase 3] — Test avanzati del book server — 2026-10-31

### Fase 6b annullata
- La governance OpenZeppelin avviata è stata rimossa per intero prima di qualsiasi commit (contratti, test, script, submodule OZ,
  wizard): owner e `protocolFeeWallet` restano il Safe come nella specifica v1.1. Suite verdi dopo la rimozione (137/137).

### Corretto (bug del codice di riferimento)
| Bug | Correzione | Test |
|---|---|---|
| Una multicall fallita per intero (timeout, 5xx) veniva letta da viem come "tutte le chiamate fallite": `authorized()` risultava delegato e **tutti gli ordini vivi diventavano `invalid_signer`** (terminale) | il giro fallisce senza cambiare stati e riprende al successivo | `faults` F1 (timeout), F2 (429/503), F6 (blocco mancante), F8 (ciclo di polling) |
| Un `nonceUsed` illeggibile in una risposta parziale contava come "non usato": ordine `open` senza verifica | la coppia (firmatario, token) va `unfunded` per quel giro | `faults` F3 |
| Un `authorized()` illeggibile contava come "delegato": `invalid_signer` terminale | come sopra, mai stato terminale da una lettura fallita | `faults` F4 |
| In ingresso un ordine con stato illeggibile veniva accettato | rifiutato con `chain_unavailable` (riprovabile), nulla salvato | `faults` F5 |
| `taker.verify()` usava il numero di blocco in cache di viem (fino a 4 s) e poteva verificare prima di un fill appena avvenuto | `getBlockNumber({ cacheTime: 0 })` | `taker` T12 (era instabile) |
| Snapshot con più di 400 chiamate fissate a un numero di blocco in cache: il giro rileggeva gli ordini giusti su uno stato vecchio | `getBlockNumber({ cacheTime: 0 })` | `pinned-read` P1 (fallisce senza la correzione); trovato dalla tempesta |

### Aggiunto (integrazioni richieste dopo l'approvazione)
- **Tempesta** nella prova di carico: 500 firmatari ricevono un Transfer nello stesso blocco con 10 000 ordini nel book → ~1,0 s e 21–22 richieste
  RPC, 5 000/5 000 ordini rifinanziati nello stesso giro, sia filtrato sia non filtrato (limite 2 s). `docs/LOAD.md`.
- **`logSignerChunk` = 1000** (default confermato, era 200). Se il provider rifiuta il filtro, il giro ricade sulla query non filtrata nello stesso
  giro, registra `warn` + `fondaco_log_filter_fallback_total` e ritenta dopo 10 minuti; timeout, 408/429/5xx e reti irraggiungibili restano
  guasti (il giro fallisce). Test `faults` F10, F10b. `docs/CONFIG.md`: quando conviene 200.

### Aggiunto
- `maxStalenessMs` (default 120 s): oltre questo tempo senza un giro riuscito, `/book` risponde `503 stale` (fail-closed). Test F9.
- Allocazione dei fondi estratta in una funzione pura (comportamento identico) e **property-based test** con fast-check (2 000 casi per
  proprietà): mai oltre min(saldo, allowance), sempre dal più vecchio (uguale a un modello scritto dalla specifica), indipendente dall'ordine
  di arrivo, nessun ordine lasciato senza fondi per errore.
- **Ordine degli eventi nello stesso blocco**: 20 permutazioni dei log di un blocco con fill, cancel, transfer, approve e withdraw danno stati
  identici (fast-check + proxy RPC).
- **Test differenziale** su fork: 3 seed × 40 passi casuali (transfer, approve, deposit/withdraw, fill, cancel, cambio fee, scadenze, nuovi
  ordini); dopo ogni passo lo stato incrementale coincide con una verifica completa da zero. Un bug piantato (Approval ignorati) viene
  rilevato al passo 13.
- **Reorg** con snapshot/revert: profondità 1, 5, 63 (rollback e reindicizzazione corretti), 65 (limite documentato), reorg durante un
  recupero a più chunk (rilevata al giro dopo, stato corretto).
- **Fault injection** con un proxy RPC programmabile (`tools/testkit/rpc-proxy.js`): timeout, 429/503 transitori e persistenti, multicall
  parziali, blocchi mancanti, log fuori ordine, failover; il ciclo di polling sopravvive con log JSON e metrica degli errori.
- **Sicurezza HTTP**: corpo lento e header lenti (408), corpo > 256 KB anche in streaming, JSON malformato/profondo/prototype pollution,
  content type, 431, ETag/304, CORS, rate limit IPv4, IPv6 /64 e /48, `X-Forwarded-For` falsificato con e senza `trustProxy`, limite SSE.
- **Prova di carico** (`tools/load`, fuori da `pnpm test`): 10 000 ordini da 1 000 firmatari. Verifica completa 33–34 RPC in ~0,8 s; giro a
  vuoto 1 RPC; giro incrementale 4 RPC in ~27 ms; `/book` p50/p95/p99 5,0/9,4/13,0 ms a 5 500 req/s; RSS 323 MB. Dettagli e proposta per
  `logSignerChunk` in `docs/LOAD.md`.

### Risultati
| Suite | Esito |
|---|---|
| wallet | 5/5 |
| verify-source | 3/3 |
| config | 9/9 |
| allocation | 5/5 |
| migrations | 7/7 |
| observability | 5/5 |
| testkit | 4/4 |
| fee | 2/2 |
| foundry | 22/22 |
| addresses | 5/5 |
| deploy | 8/8 |
| e2e | 21/21 |
| engine | 13/13 |
| signers | 8/8 |
| metrics | 7/7 |
| faults | 12/12 |
| reorg | 5/5 |
| pinned-read | 1/1 |
| differential | 3/3 (120 passi) |
| event-order | 2/2 (20 permutazioni) |
| http-security | 11/11 |
| taker | 13/13 |
| protect | 5/5 |
| **Totale** | **176/176** |

## [Fase 2] — Book server in TypeScript — 2026-10-31

### Prima della fase 2 (richieste sulla fase 1)
- forge-std **v1.9.7** (`77041d2c…`) come submodule, solo per i test; **invariant test con handler** su fork: fee wallet = Σ floor(signerAmount·fee/10000)
  dei fill, contratto senza token, nonce usati mai liberati; azioni casuali fill pubblico/privato, cancel, setProtocolFee, authorize, revoke,
  transfer e approve (32 run × 64 chiamate per invariante). Un controllo di mutazione (fee arrotondata per eccesso) viene rilevato.
- API: campo **`executableOnChain`** in `/orders/:hash` e `/orders?signer` (true per `invalid_signer` dopo `revoke()` finché non arriva cancel o fill);
  evento SSE `order` quando cambia. Test `signers` S7, S8.
- Taker: firma **high-s** presa dal book → eseguita correttamente (il contratto la accetta); malleazione non valida → rifiutata in verify. Test `taker` T12, T13.
- README: avviso in evidenza che lo script di deploy non è mai stato eseguito su una rete reale.

### Aggiunto
- Server in **TypeScript strict** (`exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`), compilato in `dist/`; tipi per stati, ordini, righe DB, eventi.
- **Migrazioni versionate** (`PRAGMA user_version`, tabella `schema_migrations`, un passo per transazione): v1 schema di riferimento,
  v2 `status_block`/`contract_signer`/indici, v3 `signer_revoked`, v4 `onchain_live`. Database del server JS di riferimento (e quelli della fase 1)
  riconosciuti e migrati; database più nuovi rifiutati; passo fallito = rollback completo.
- **Schema di configurazione in casa** (validatore di 123 righe + definizione): default documentati, chiavi sconosciute rifiutate con
  "did you mean", tutti gli errori in un solo messaggio con percorso; `docs/CONFIG.md` generato dallo schema e controllato da `pnpm test` (`check:generated`).
- **Log JSON** (un oggetto per riga, livelli, bigint/Error sicuri) e **metriche Prometheus** in casa; `/metrics` spento di default, protetto da
  rete (indirizzo diretto) o token bearer.
- Suite unitarie `config` (9), `migrations` (7), `observability` (5); suite su fork `metrics` (7). Runner unico `tools/testkit/run-suites.mjs`.

### Modificato
- `confirmations` rimossa dalle configurazioni dei test: ora è una chiave sconosciuta (A-05).
- `GET /metrics` è una nuova route; con le metriche spente risponde 404 come qualsiasi percorso sconosciuto.

### Risultati
| Suite | Esito |
|---|---|
| wallet | 5/5 |
| verify-source | 3/3 |
| config | 9/9 |
| migrations | 7/7 |
| observability | 5/5 |
| testkit | 4/4 |
| fee | 2/2 |
| foundry | 22/22 (19 + 3 invarianti) |
| addresses | 5/5 |
| deploy | 8/8 |
| e2e | 21/21 |
| engine | 13/13 |
| signers | 8/8 |
| metrics | 7/7 |
| taker | 13/13 |
| protect | 5/5 |
| **Totale** | **137/137** |

## [Fase 1] — Libreria contratti e deploy — 2026-10-31

### Aggiunto
- `packages/contracts/compiler-settings.json`: impostazioni ufficiali di compilazione (solc 0.8.23, 999999 run, **evmVersion `paris`**)
  e SHA-256 del bytecode del fixture; unica fonte per `verify-source`, deploy e libreria. Sezione "Riproducibilità del bytecode" nel README.
- `verify-source --evm-version` e `tools/verify-source/verify-source.test.mjs`: con `paris` coincide, con `shanghai` e con un fixture alterato **fallisce**.
- `fork.config.json`: blocco fisso 23 700 000 (chain 1) letto da testkit e test; non più in `.env` né nei test.
- Libreria TypeScript `@fondaco/contracts` (build `tsc`, strict): ABI tipizzata generata dal fixture (`gen:abi`, `check:abi`),
  tipi `OrderERC20`/`SignedOrderERC20`, dominio e tipi EIP-712, `protocolFeeOf`, `requiredSignerFunds`, indirizzi per chain
  (Ethereum, Base: token e Multicall3 verificati on-chain; `swapERC20: null` finché non c'è un deploy), `predictSwapAddress`.
- Test Foundry su fork contro il bytecode del fixture (nessun Solidity di produzione; nessuna libreria di terzi: interfaccia dei cheatcode locale):
  fee e importi esatti con fuzz su importi, fee 0–9999 e 4 coppie (incl. USDT); fee nulla sotto soglia; nonce monouso e bitmap;
  cambio fee (invalid_fee) e ritorno al valore firmato (revive); authorize/revoke; firme high-s; wallet EIP-1271 che accetta e revoca.
- Suite `addresses` (libreria contro il contratto deployato) e `signers` (book server: `/config` senza Wrapper, dedup high-s, A-02).

### Modificato
- Deploy: niente Wrapper (`WETH` ignorato con avviso); controllo dello SHA-256 del fixture; modalità **dry-run** (sola lettura,
  basta `DEPLOYER`); **idempotente** (verifica soltanto se già fatto, riprende il passaggio di ownership se interrotto, altrimenti rifiuta);
  `CONFIRM_CHAIN_ID` obbligatorio per trasmettere dalla riga di comando; controllo anche di `ORDER_TYPEHASH`. D1–D4 invariati.
- Book server: `/config` non espone più `wrapper` (rimosso anche da `config.example.json`).
- Book server: `invalid_signer` resta terminale anche dopo un reorg (nuova colonna additiva `signer_revoked`); un fill o un cancel
  on-chain di un'offerta `invalid_signer` viene comunque registrato (`filled`/`cancelled`), così l'app smette di chiedere l'annullamento.

### Corretto (bug del codice di riferimento)
- `invalid_signer` tornava `open` dopo un reorg: il rollback riportava a `unfunded` il fill reorganizzato di un'offerta revocata e la
  verifica successiva la rimetteva nel book. Ora torna `invalid_signer`. Test: `packages/book-server/test/signers.test.js` **S6**.
- Un fill o un cancel on-chain di un'offerta `invalid_signer` non veniva mai registrato (restava `invalid_signer` per sempre). Ora diventa
  `filled`/`cancelled`. Test: `signers.test.js` **S4** (fill) e **S5** (cancel).

### Osservato e documentato
- SwapERC20 v5.0.0 **accetta firme high-s**: innocuo on-chain (l'hash dell'ordine esclude la firma e il nonce si usa una volta),
  il book deduplica per hash EIP-712.
- Con un delegato i nonce finiscono nella bitmap del **delegato**: il `cancel()` del wallet non li raggiunge. Dopo `revoke()` le
  vecchie firme del wallet tornano valide finché non si chiama `cancel()`.
- `cancel()` su un nonce già usato non fallisce e non emette `Cancel` (è così che si distingue `partly_taken`).

### Risultati
| Suite | Esito |
|---|---|
| wallet (unit) | 5/5 |
| verify-source | 3/3 |
| testkit | 4/4 |
| fee | 2/2 |
| foundry | 19/19 (6 fuzz × 256 run) |
| addresses | 5/5 |
| deploy | 8/8 (D1–D4 invariati + D5–D8) |
| e2e | 21/21 |
| engine | 13/13 |
| signers | 6/6 |
| taker | 11/11 |
| protect | 5/5 |
| **Totale** | **102/102** |

## [Fase 0] — Verifica delle fondamenta — 2026-10-31

### Aggiunto
- Monorepo pnpm (`packages/contracts`, `packages/book-server`, `packages/client`, `tools/*`); viem fissato a 2.57.13 come nel lockfile di riferimento.
- `tools/verify-source`: clona `airswap-protocols` al commit `28156e5…`, controlla che il tag `v5.0.0` punti lì,
  verifica lo SHA-256 di `SwapERC20.sol`, scarica solady 0.0.173 controllandone l'integrità con lo `yarn.lock` del tag,
  usa solc 0.8.23 con SHA-256 fissato (e confrontato con la lista ufficiale), compila con le impostazioni Hardhat del repository
  e richiede bytecode di creazione e ABI identici al fixture. Si ferma con exit 1 a qualunque differenza (provato con un fixture alterato).
- `tools/testkit`: anvil che forka mainnet a blocco fisso (blocco 23 700 000; RPC da `MAINNET_RPC_URL`),
  wallet casuali senza codice, saldi USDC/USDT/WETH/DAI via storage con rilettura, WETH via `deposit`, runner con un fork nuovo per suite.
- Suite `testkit` (4 controlli) che documenta che l'account di sviluppo #0 ha una delega EIP-7702 sul fork.

### Modificato
- Codice e test di riferimento spostati nella nuova struttura cambiando solo percorsi e import (nessuna modifica di logica).
- I test girano su anvil invece che su hardhat, senza modifiche: viem `testClient` in modalità `hardhat` funziona perché anvil accetta gli alias `hardhat_*`.

### Risultati
| Suite | Esito |
|---|---|
| wallet (unit) | 5/5 |
| testkit | 4/4 |
| fee | 2/2 |
| deploy | 4/4 |
| e2e | 21/21 |
| engine | 13/13 |
| taker | 11/11 |
| protect | 5/5 |
| **Totale** | **65/65** (61 portati dal riferimento + 4 nuovi) |

`verify-source`: bytecode di creazione identico (12 221 byte, sha256 `139ab5cb…3d77`), ABI identica.
