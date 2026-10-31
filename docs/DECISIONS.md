# Decisioni e punti aperti

Registro delle scelte prese e dei punti in cui specifica e codice di riferimento sono ambigui o in conflitto.
Stato: **D** = decisa, **A** = aperta (serve conferma), **P** = proposta in attesa di conferma.

## Fase 0

### D-01 · `evmVersion: paris` nella verifica del sorgente — D
La specifica indica solo "solc 0.8.23, ottimizzatore 999999 run". Con queste sole impostazioni solc 0.8.23 usa `shanghai`
e il bytecode **non** coincide (diverso anche in lunghezza: compare `PUSH0`). Il fixture coincide byte per byte solo con
`evmVersion: paris`, che è il default di Hardhat per 0.8.20+ nella versione usata dal repository AirSwap
(`hardhat.config.js` del tag non imposta `evmVersion`). Conseguenza utile: niente `PUSH0`, quindi lo stesso bytecode si deploya
anche su chain senza Shanghai. `tools/verify-source` lo fissa esplicitamente.

### D-02 · anvil al posto di hardhat — D
La specifica §7 dice che i test girano su hardhat; la fase 0 chiede anvil a blocco fisso. I test portati passano su anvil
senza modifiche (alias `hardhat_*`). Nella fase 3 il `testClient` passerà a `mode: 'anvil'` (cambio solo di test).

### D-03 · Un fork nuovo per suite — D
Ogni suite parte con un anvil appena avviato allo stesso blocco: niente stato condiviso tra suite (automine, tempo, snapshot).
Costo ≈ 1 s per suite grazie alla cache su disco di anvil.

### D-04 · RPC per il fork in sviluppo — D
`https://eth.drpc.org` (piano gratuito, risponde a richieste archivio) va bene per lo sviluppo locale ed è il valore di esempio.
In CI servirà un RPC archivio a pagamento come secret (fase 7).

## Risposte ai punti aperti della fase 0 (confermate)

| Punto | Decisione | Stato |
|---|---|---|
| A-01 Wrapper | tolto da deploy e `/config`; `Wrapper.json` resta come riferimento; D1–D4 invariati; test D5 e S1 | fatto (fase 1) |
| A-02 `invalid_signer` dopo `revoke()` | terminale nel book; avviso "questa offerta può ancora essere eseguita: annullala" e annullamento protetto nell'app | server e test fatti (fase 1, S3–S6); app in fase 5 |
| A-03 dipendenze | runtime solo `viem`; schema, log JSON e Prometheus scritti in casa con test; `zod` al massimo come devDependency; stop se lo schema supera 200 righe | fase 2 |
| A-04 mercati di esempio | solo con `DEMO=true` esplicito, etichetta "Demo" sempre visibile, dati marcati come simulati; in produzione dalla whitelist di `/config`, stato vuoto se vuota | fase 5 |
| A-05 `confirmations` | rimossa con lo schema; chiavi sconosciute rifiutate con errore leggibile | fase 2 |

## Fase 1

### D-05 · Impostazioni di compilazione in un solo file — D
`packages/contracts/compiler-settings.json` contiene sorgente, compilatore, `evmVersion: paris` e lo SHA-256 del bytecode atteso.
Lo leggono `verify-source`, lo script di deploy (che rifiuta un fixture diverso) e la libreria. Un test negativo fissa che `shanghai` fallisce.

### D-06 · Blocco del fork in `fork.config.json` — D
Unica fonte del blocco (23 700 000) per testkit, test JS e test Foundry. La CI (fase 7) userà lo stesso file; non ci sono override da variabile d'ambiente.

### D-07 · Semantica di "deploy idempotente" — D
Il test D4 (riferimento) chiede che un secondo deploy con una chiave già usata venga rifiutato; la fase 1 chiede idempotenza.
Conciliazione: con nonce > 0 lo script guarda l'indirizzo deterministico (nonce 0). Se c'è il contratto con le impostazioni attese
e owner = Safe → verifica soltanto (D7); se owner = deployer → completa `transferOwnership` (D8); in ogni altro caso (come in D4,
dove il Safe ha nel frattempo cambiato la fee) → rifiuto con `deployer nonce is N …`.

### D-08 · `invalid_signer` stabile anche nei reorg — D
Conseguenza di A-02. Senza una memoria dello stato, il rollback di un reorg riportava a `unfunded` un fill di un'offerta revocata e la
verifica successiva la rimetteva `open` nel book. Nuova colonna additiva `signer_revoked` (impostata quando l'ordine diventa
`invalid_signer`): il rollback la riporta a `invalid_signer`. Un fill o cancel indicizzato di un'offerta `invalid_signer` ora la porta a
`filled`/`cancelled` (prima restava `invalid_signer` per sempre e l'app avrebbe chiesto di annullare un'offerta già chiusa).
Nessun test esistente cambia; nuovi test S4–S6. La colonna entrerà nelle migrazioni versionate della fase 2.

### D-09 · Firme high-s — D
Osservato su fork: il contratto accetta il gemello high-s (Foundry `Malleability`). Il server lo accetta in ingresso (il recupero locale
non impone low-s) ma deduplica per hash EIP-712 (S2). Non lo normalizziamo: un solo nonce, quindi un solo fill possibile.

### D-10 · Test Foundry senza forge-std — superata da D-12
L'aggiunta di forge-std come submodule è stata bloccata dalla policy dell'ambiente (integrazione di codice di terzi). I test usano
un'interfaccia dei cheatcode scritta qui (`foundry/test/utils/Vm.sol`, solo le funzioni usate) e asserzioni proprie: nessun codice di
terzi nel repository. Se preferisci forge-std (es. `deal`, `StdInvariant`), si può aggiungere come submodule fissato a un commit, con la tua autorizzazione.

### D-11 · TypeScript compilato in `dist/` — D
`@fondaco/contracts` si compila con `tsc` (strict, `exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`) in `dist/`.
Niente esecuzione diretta di `.ts` (stripping dei tipi stabile solo da Node 22.18, il requisito è ≥ 22.13). `lib` include `DOM` perché i tipi di viem/ox lo richiedono.

### D-12 · forge-std, solo per i test — D (autorizzata)
Submodule `packages/contracts/foundry/lib/forge-std`, tag **v1.9.7**, commit **`77041d2ce690e692d6e03cc812b57d1ddaa4d505`**
(`git submodule update --init` dopo il clone). Usato solo dagli invariant test (`foundry/test/invariant`); i test esistenti restano sulla
loro interfaccia locale dei cheatcode. Nessuna dipendenza Solidity nel codice di produzione (che non esiste: il contratto è il fixture).

### D-13 · Invariant test con handler (ex A-06) — D
`SwapInvariants.t.sol` con `Handler.sol`: azioni casuali fill pubblico, fill privato, cancel (anche del delegato), setProtocolFee 0–9999,
authorize, revoke, transfer e approve dei firmatari, su USDC, USDT e WETH; firme a volte del firmatario a volte del delegato, fondi a volte
insufficienti. Invarianti: (1) fee wallet = Σ floor(signerAmount·fee/10000) dei fill riusciti, per token; (2) il contratto non detiene
token; (3) un nonce usato non torna libero. 32 run × 64 chiamate su fork (≈ 2 000 chiamate per invariante; un controllo di mutazione, fee arrotondata per eccesso, viene rilevato).

### D-14 · `executableOnChain` nell'API — D
`/orders/:hash` e `/orders?signer` aggiungono `executableOnChain` (campi esistenti invariati): `true` se l'ordine firmato può ancora
essere eseguito on-chain, ora o appena il firmatario ha fondi, e quindi solo `cancel()` lo chiude. `open`/`unfunded` → `true`;
`invalid_signer` → `true` quando la firma torna valida (dopo `revoke()`, o se lo smart wallet la riaccetta); `filled`/`cancelled`/`used`/
scaduto → `false`; `invalid_fee` → `false` finché la fee del contratto è diversa. Per gli `invalid_signer` il motore ricontrolla la firma
on-chain (stessa multicall: `authorized`, `nonceUsed`, `check()` per gli smart wallet) quando arriva un `Authorize`/`Revoke` del firmatario
e a ogni verifica completa; nessuna richiesta se non ci sono ordini da sorvegliare. Un cambio emette un evento SSE `order` con
`executableOnChain`. L'app mostra "annulla ora" quando `executableOnChain` è `true` e lo stato non è `open`/`unfunded`. Test S7, S8.

### D-15 · Firma high-s nel taker — D
Esito documentato: un ordine valido del book con la firma malleata (high-s) **viene eseguito correttamente**, perché il contratto
accetta high-s e il taker verifica con `check()` e simula prima di inviare; la copia originale viene poi scartata in verify come
`taken`, senza transazione. Una malleazione non valida (s alto senza invertire v) è rifiutata in verify (`signature`), nulla inviato.
Test T12, T13.

## Fase 2

### D-16 · Dipendenze di runtime — D
Il server dipende da `viem` (unica dipendenza di terzi) e dal pacchetto interno `@fondaco/contracts` (ABI, tipi EIP-712, Multicall3), che a
sua volta dipende solo da `viem`. Validatore dello schema (123 righe), logger, registro Prometheus e confronto CIDR sono scritti qui.

### D-17 · Migrazioni — D
Versione in `PRAGMA user_version`, storia in `schema_migrations`, ogni passo in una transazione (anche `user_version` è transazionale).
Un database con `user_version = 0` che contiene già `orders` viene "adottato" come v1 (è il server JS); i passi successivi sono idempotenti
(aggiungono colonne e indici solo se mancano), così migra qualunque layout intermedio del riferimento. Test con i `db.js` originali come fixture.

### D-18 · Dettagli dello schema di configurazione — D
- Un valore `undefined` conta come assente (i test passano `rateLimit: undefined` per i default di produzione).
- `startBlock` e `tokens.*.min` accettano numero o stringa decimale (i test passano stringhe); restano stringhe nella configurazione validata.
- `config.example.json` resta un modello: l'unico campo non valido è il segnaposto dell'indirizzo del contratto (test C6).

### D-19 · `/metrics` — D
Spento: 404. Acceso: 200 se l'indirizzo **diretto** del client è in `metrics.allow` (default solo loopback) oppure con `Bearer` uguale a
`metrics.token` (confronto a tempo costante sugli hash); altrimenti 401. `X-Forwarded-For` non conta mai, anche con `trustProxy`:
dietro un proxy serve il token. La route non consuma il rate limit.

### D-20 · RPC per giro incrementale — osservazione
Misurato: 1 richiesta per un giro a vuoto, **5** per un giro con un Transfer di un firmatario quando esistono firmatari `unfunded`
(testa, log del contratto, due query di log dei token in parallelo — uscite e entrate verso gli unfunded —, multicall), 4 altrimenti.
La specifica dice "circa 4": coerente. Le misure a 10 000 ordini sono nella fase 3.

## Fase 6b (annullata)

La governance con OpenZeppelin (token, Governor, Timelock) è stata avviata e poi **annullata** su richiesta: nessun file, test,
dipendenza o submodule è rimasto nel repository (non era stato fatto alcun commit). Restano valide le regole della specifica v1.1:
owner e `protocolFeeWallet` di SwapERC20 = Safe, nessun Solidity di produzione nostro.

## Fase 3

### D-21 · Fail-closed sugli errori RPC (bug del codice di riferimento) — D
Trovato con la fault injection. Con `allowFailure: true`, viem trasforma una multicall fallita per intero (timeout, 5xx) in
"tutte le chiamate fallite"; il riferimento leggeva allora `authorized()` come delegato e **tutti gli ordini vivi diventavano
`invalid_signer`**, stato terminale: un solo timeout distruggeva il book. Ora:
- un blocco della multicall con tutte le chiamate fallite è un errore di trasporto: il giro fallisce e nessuno stato cambia;
- un valore illeggibile in una risposta parziale rende `unknown` gli ordini interessati: l'intera coppia (firmatario, token) va
  `unfunded` per quel giro (mai `open` senza verifica, mai uno stato terminale) e torna normale al giro successivo;
- in ingresso un ordine con stato illeggibile è rifiutato con `chain_unavailable` (riprovabile), nulla viene salvato.
Test `faults` F1–F5.

### D-22 · `maxStalenessMs`: il book non serve offerte non verificate — D
Durante un'interruzione lunga dell'RPC gli ordini restavano `open` sulla base dell'ultima verifica. Nuovo parametro per chain
`maxStalenessMs` (default 120 s): se nessun giro è riuscito da più di quel tempo, `GET /book` risponde `503 stale`; torna a 200 al primo
giro riuscito. Cambia solo il comportamento in caso di guasto. Test F9.

### D-23 · Reorg più profondi di `reorgDepth` — comportamento documentato
Con una reorg di 65 blocchi (> 64) il server se ne accorge, ma un fill nel primo blocco abbandonato **resta `filled`** e un cancel nel
primo blocco del nuovo ramo viene visto solo come `used` (dalla verifica completa). In entrambi i casi l'ordine non viene offerto,
quindi nessuno rischia fondi; su Ethereum 64 blocchi superano la finalità. Test R4.

### D-24 · Generatore di carico in casa invece di autocannon/k6 — D
La specifica chiede p50/p95/p99; autocannon non riporta il p95 e k6 non è installabile senza binari esterni. `tools/load/bench-http.mjs`
(40 righe, `node:http`, keep-alive) gira in un processo separato e calcola i percentili esatti su tutti i campioni.

### D-25 · `verify()` del taker legge un numero di blocco fresco — D
viem tiene in cache il numero di blocco (fino a 4 s): `verify()` poteva controllare gli ordini a un blocco precedente a un fill appena
avvenuto (test T12 instabile). Ora `getBlockNumber({ cacheTime: 0 })`.

### A-07 · Default di `logSignerChunk`
Proposta: 1000 invece di 200 (vedi `docs/LOAD.md`): su mainnet la query non filtrata costa ~87 KB per blocco a prescindere dal book,
quella filtrata 66 byte per firmatario nella richiesta. Da confermare; dipende dai limiti del provider sulla lista dei topic.
