# Changelog

Formato: [Keep a Changelog](https://keepachangelog.com/it/1.1.0/). Le fasi seguono il piano di lavoro.

## [Fase 6] — Test avanzati dell'app — 2026-11-04

### Aggiunto
- Suite `web-flows` (F1–F9 con saldi on-chain, console pulita), `web-perf`, `web-layout`, `web-a11y` e `web-visual`, nel runner.
  Harness comune `apps/web/test/harness.mjs`: fork, contratto, bacheche, build servita con gzip, wallet EIP-6963 pilotabile
  (rifiuto, cambio chain, gara).
- Rilevatore di sovrapposizioni a campionamento di punti (D-44), axe-core 4.14, contrasto misurato, tastiera nei fogli,
  regressione visiva con pixelmatch e baseline aggiornabili solo con `test:visual:update`. Ogni rilevatore ha il suo autotest.
- App: offerta privata con link (D-47) e `txTimeoutSec` (D-50).
- Book server: `GET /books` (D-45); sostituzione di un ordine `invalid_fee` rifirmato con lo stesso nonce (D-48).
- `docs/PHASE6-RESULTS.md` con tutti i numeri.

### Modificato
- Avvio:
  - `boot.js` precarica `config.json`, `/config` e `/books`;
  - runtime del wallet caricato all'uso;
  - client diviso in `plan.ts`, `guards.ts` ed `errors.ts` (API pubblica invariata);
  - una sola copia di viem (`resolve.dedupe`);
  - font in sottoinsiemi latini (D-46).
- Risultato: bundle iniziale da 81 a 49 kB gzip, libro su Fast 3G da 4,85 a 1,8 s, Lighthouse Performance da 0,45 a 0,96.

### Corretto (con il test che lo copre)
- Rifirma con nonce nuovi: doppia esposizione se la fee tornava (E11b, F3b). La rifirma non alzava l'autorizzazione (F3b).
- Client: offerta privata scartata in verifica per `SenderAllowanceLow` (F6b); rifiuto nel wallet non riconosciuto con due copie
  di viem (F7a).
- Layout shift all'avvio, CLS da 0,877 a 0,013 (P4); 400 in console per coppie fuori whitelist (T10, W16).
- Etichetta Demo e tag "TU" sopra il contenuto (L1).
- Focus trap: `[href]` contava le `<use>`, i gruppi di radio, il focus dato a un foglio ancora invisibile (A3).
- Label in Name (A1); contrasto delle etichette del grafico e dell'hover (A2).
- Messaggio dell'offerta privata coperto dal toast di connessione (F6b); "Eseguite 1 parti su 4" (F1c).

### Risultati
Vedi `docs/PHASE6-RESULTS.md`: **35 suite, 320 controlli, tutti verdi.** Foundry al primo giro ha avuto un timeout dell'RPC
gratuito di fork; rilanciato, 29/29.

## [Riferimento v4.3] — Cambio del contratto di riferimento — 2026-11-04

### Modificato
- Contratto di riferimento: da tag `v5.0.0` (`28156e5`) a tag **`v4.3`** (`6ad0137`, SwapERC20.sol SHA-256 `4103d213…3a36`), il
  sorgente deployato da AirSwap come "V5.0" a `0xD82E10B9A4107939e55fCCa9B53A9ede6CF2fC46`. Stesse impostazioni (0.8.23, 999999, paris).
- Fixture ricompilato: 12 123 byte, sha256 `45dffc57…6109`; `abi.ts` rigenerato. Fixture v5.0.0 e `Wrapper.json` (v5.0.0) rimossi.
- Riferimenti a v5.0.0 come versione di riferimento rimossi da codice, commenti e documentazione (restano nella storia e in
  `docs/AUDIT-DIFF.md`).

### Aggiunto
- `verify-source` passo 7: runtime ricompilato contro `eth_getCode` su Ethereum e Base (metadata esclusa, immutabili mascherate e
  poi controllate): **identico, metadata compresa** (D-40). Opzione `--write-fixture`; `BASE_RPC_URL` in `.env.example`; test V4.
- `docs/audits/`: report PeckShield #2024-047 "AirSwap V4.3" (23 aprile 2024) con SHA-256, diff `27b60da→6ad0137` e `bcd4c48→6ad0137`.
  Sintesi e riserva sul passaggio a solady nel README (D-41).
- Foundry: `ChainId.t.sol` (swap su un'altra chain → `ChainIdChanged`; `check()` lo riporta; caso peggiore 7 errori su 8 slot;
  `swapLight` non controlla la chain, D-43) ed `Errors.t.sol` (`InvalidFee`, `InvalidFeeLight`, `InvalidFeeWallet`,
  `InvalidStaking` da costruttore e setter).
- `docs/AUDIT-DIFF.md`: differenze e diff completo v4.3 ↔ v5.0.0.

### Risultati
`node tools/testkit/run-suites.mjs`: **30 suite, 313 controlli, tutti verdi**, nessuna modifica di logica nel codice del progetto.

| Suite | Esito | Note |
|---|---|---|
| verify-source | 4/4 | V1 fixture v4.3; V2 shanghai fallisce; V3 fixture alterato fallisce; **V4 runtime = deploy AirSwap su Ethereum e Base** |
| foundry | 29/29 | +7: `ChainId.t.sol` (5), `Errors.t.sol` (2); invarianti 1–3 invariate |
| fee, addresses, deploy | 2/2, 5/5, 8/8 | sul fixture v4.3 |
| book server (13 suite) | tutte ok | e2e 21, engine 13, signers 8, metrics 7, trades 10, faults 12, reorg 5, pinned-read 1, differential 3, event-order 2, http-security 11, config 9, migrations 7 |
| client (6 suite) | tutte ok | taker 13, protect 5, taker-advanced 12, wallet 5, client-guards 9, client-smoke 4 |
| web | 35/35, 5/5, 18/18 | web-model, web-keys, web-e2e |

## [Fase 5] — App web — 2026-11-03

### Aggiunto
- `apps/web`: app **statica** (Vite 8, TypeScript strict, nessun framework: D-33), senza processo server e senza chiavi. Markup e CSS sono quelli
  del prototipo, con breakpoint < 860, 860–1179 e ≥ 1180, splash C e `prefers-reduced-motion`. Font Geist self-hosted, CSP in `<meta>`.
- Configurazione iniziale in `config.json` (contratto per chain, bacheca, monete). **Impostazioni**: URL della bacheca e RPC per chain, salvati nel
  browser, con **Ripristina**; contratto mostrato e modificabile solo dietro un avviso esplicito con conferma.
- Dati reali:
  - bacheca via API + SSE con riconnessione (1 s → 30 s); 503 `stale` → banner **"Dati non aggiornati"** e scambio bloccato;
  - contratto diverso tra app e bacheca → scambio bloccato;
  - banner di governance quando `protocolFeeLight ≠ protocolFee` o arriva un evento SSE `governance`;
  - coppie da `/config` intersecate con le monete dell'app, con stato vuoto esplicito.
- Grafico 1 h / 4 h / 24 h con crosshair, dai fill indicizzati (`/candles` con ETag); ultimi scambi da `/trades`.
- Wallet via EIP-6963 + EIP-1193 (viem). Esecuzione e protezione con `@fondaco/client` (verify → autorizza → una tx per offerta) e stato MEV reale
  nella riga di conferma.
- "Le mie offerte" con stati attiva / in pausa / da rifirmare / **ancora eseguibile → Annulla ora** (cancel protetto).
- Modalità demo solo con `DEMO=true`: dati simulati, etichetta "Demo" sempre visibile anche su telefono, codice assente dal bundle di produzione.
- Book server (commit `9300523`): tabella `fills` (migrazione v5), `GET /trades`, `GET /candles` con ETag/304, `protocolFeeLight` e `markets` in
  `/config`, eventi SSE `trade` e `governance`.
- Test: `web-model` (35), `web-keys` (5), `web-e2e` (18) nel runner; `scripts/screenshots.mjs`; screenshot in `docs/screenshots/`.
- Specifica (D-31 approvato): soglie "dal 2% in su", "dal 10% in su", "dall'1% in su".

### Corretto
- Importi convertiti in unità base con `toFixed(18)`: 0,2 WETH diventava 0,200000000000000011. Ora si usa la rappresentazione decimale più corta
  (U15–U17, e2e W12). Stessa correzione per il prezzo nel calcolo della scala.
- Il primo clic su "Altro" dopo aver scritto un importo andava perso: il ridisegno al blur sostituiva il pulsante tra mousedown e mouseup. Ora il
  pulsante si ridisegna solo se cambia (trovato dall'e2e; c'era anche nel prototipo).
- Percentuale di commissione nel riquadro "Proponi": ora viene da `/config`, non è più fissa allo 0,30%.

### Risultati
`node tools/testkit/run-suites.mjs`: **30 suite, 305 controlli, tutti verdi**. Ogni suite su fork usa un anvil nuovo, sempre allo stesso blocco.

| Suite | Esito | Cosa copre in questa fase |
|---|---|---|
| typecheck `apps/web` | ok | TypeScript strict (`exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`) |
| web-model | 35/35 | quotazione indicativa/verificata, stati di ordini e offerte, termini esatti, serie del grafico, banner, impostazioni, client API |
| web-keys | 5/5 | nessuna chiave nelle build di produzione e demo, autotest dello scanner, codice demo assente dalla produzione |
| web-e2e | 18/18 | pubblica → compra da un secondo account → saldi esatti; seconda bacheca; governance; stale |
| trades | 10/10 | fill, `/trades`, `/candles` con ETag, rollback sul reorg |
| altre 25 suite | tutte ok | regressione delle fasi 0–4, invariate |

## [Fase 4] — Client in TypeScript — 2026-10-31

### Modificato
- `packages/client` in **TypeScript strict**, compilato in `dist/` con le dichiarazioni (ESM, `sideEffects: false`); porting 1:1 verificato dalle suite
  esistenti sul build prima di ogni aggiunta (taker 13/13, protect 5/5, wallet 5/5). **Unica dipendenza: `viem`** (verificato da `client-smoke`).
- API pubblica tipizzata e documentata (`packages/client/README.md`): `Quote = IndicativeQuote | VerifiedQuote`, `ExecuteResult`, `TakerEvent`
  (unione discriminata su `type`), `Order`/`OrderInput`, `Submitter`, `CancelResult`, `ProtectionStatus`.
- La guardia sul destinatario non lancia più un'eccezione: blocca con `stopped: 'recipient_guard'` ed evento `blocked`.

### Corretto (bug del codice di riferimento)
| Bug | Correzione | Test |
|---|---|---|
| La guardia ricodificava la richiesta con la **propria** ABI, mentre il wallet la codifica con l'`abi` della richiesta: una richiesta con l'ABI alterata (stessi argomenti, ordine diverso) passava il controllo e veniva inviata diversa | confronto byte per byte tra i dati che il wallet codificherà e quelli attesi (contratto, funzione, destinatario = wallet connesso, ordine) | `taker-advanced` A4 (anche A1–A3: destinatario, contratto, funzione) |
| Con tutti gli endpoint protetti irraggiungibili il submitter lanciava un errore generico: nessuna indicazione all'app, nessuna scelta | stop esplicito `private_unavailable` (nulla inviato); ricaduta sul wallet solo su richiesta, dichiarata | `taker-advanced` A7–A9 |

### Aggiunto
- `createSubmitter({ onUnavailable: 'stop' | 'wallet' })`: default `stop`; `wallet` invia dal wallet con evento `protection_downgraded` e `result.downgraded`.
  `cancelOrders` riporta `private_unavailable`. `isUnreachable()` distingue un endpoint muto da una risposta JSON-RPC.
- `createRpcConfirmations(storage)`: conferma "Ho impostato l'RPC protetto" ricordata per wallet (rdns) e per chain in `localStorage['fondaco-rpcset']`,
  robusta a storage assente, che lancia errori o corrotto.
- Test: guardia sul destinatario (4 manomissioni + controllo), `verify()` subito dopo un fill con cache di 4 s (fallisce senza la correzione T12),
  approve esatto consumato fino a zero su due esecuzioni, endpoint protetti giù (stop, ricaduta dichiarata, cancel), sostituzione nel wallet con un'altra
  chiamata, timeout; soglie di prezzo ai confini esatti (2,00 %, 9,99 %, 10,00 %, 1,00 % e vicini) su 4 prezzi di mezzo; wallet finti EIP-6963 × reti
  1, 8453, 10, 42161, 137; persistenza della conferma.
- `tools/client-smoke`: impacchetta il client, lo installa con npm in un progetto esterno, lo usa da ESM e lo verifica con TypeScript strict
  (switch esaustivi su `Quote` e `TakerEvent`; un caso mancante fa fallire il controllo).

### Risultati
| Suite | Esito |
|---|---|
| wallet | 5/5 |
| client-guards | 9/9 |
| client-smoke | 4/4 |
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
| differential | 3/3 |
| event-order | 2/2 |
| http-security | 11/11 |
| taker | 13/13 |
| protect | 5/5 |
| taker-advanced | 12/12 |
| **Totale** | **201/201** |

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
