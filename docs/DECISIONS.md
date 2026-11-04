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
| A-01 Wrapper | tolto da deploy e `/config`; `Wrapper.json` (v5.0.0) rimosso col cambio di riferimento (D-40); D1–D4 invariati; test D5 e S1 | fatto (fase 1) |
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

### D-26 · `logSignerChunk` = 1000 con ricaduta automatica (ex A-07, confermata)
Default 1000. Se la query filtrata fallisce con un errore che non è un guasto (timeout, rete irraggiungibile, 408, 429, 5xx), il giro prova
subito quella non filtrata: se riesce, il filtro è stato rifiutato → si usa la non filtrata per 10 minuti, `warn` nei log e
`fondaco_log_filter_fallback_total`; se fallisce anche quella, è un guasto e il giro fallisce. Non classifico i codici JSON-RPC
(-32005 è usato sia per "troppi topic" sia per i rate limit): decide la prova con la query non filtrata. Test F10, F10b.

### D-27 · Numero di blocco senza cache nelle letture fissate — D
Trovato dalla tempesta: con più di 400 chiamate la multicall è fissata a `getBlockNumber()`, che viem tiene in cache (4 s). Ora
`cacheTime: 0`, come in `taker.verify()` (D-25). Test `pinned-read` P1.

### Requisiti registrati per la fase 5 (app)
- Con `503 stale` da `/book`: mostrare "dati non aggiornati" e bloccare il pulsante di scambio finché il book non torna (D-22).
- `executableOnChain` vero su un'offerta non `open`/`unfunded`: avviso "questa offerta può ancora essere eseguita: annullala" e pulsante di
  annullamento protetto (A-02, D-14).
- Modalità demo solo con `DEMO=true`, etichetta "Demo" sempre visibile (A-04).

## Fase 4

### D-28 · Guardia sul destinatario per identità dei dati — D
La guardia confronta i dati che il wallet codificherà dalla richiesta (sua `abi`, funzione, argomenti) con quelli attesi; la copia del riferimento
ricodificava con la propria ABI e non vedeva un'ABI alterata (A4). Non ricostruisco la richiesta da zero: se un componente intermedio la altera,
è più sicuro accorgersene e fermarsi (`blocked`) che correggerla in silenzio. Fuori portata: un wallet che modifica la transazione dopo la firma.

### D-29 · Endpoint protetti irraggiungibili: stop esplicito di default — D
Scelta: `onUnavailable: 'stop'` (default) non invia nulla e ferma l'esecuzione con `private_unavailable`; `onUnavailable: 'wallet'` è un consenso
esplicito del chiamante a passare dalla mempool pubblica, e viene dichiarato (evento, `result.protection = 'wallet'`, `result.downgraded`).
"Irraggiungibile" = errore di trasporto (rete, timeout, HTTP); una risposta JSON-RPC (per esempio "nonce too low") viene propagata. Per l'app: con
un wallet del browser il submitter è sempre in modalità `wallet` e questa regola non si applica.

### D-30 · Conferma dell'RPC protetto per rdns e chain — D
EIP-6963 dà un `uuid` nuovo a ogni sessione: la conferma è legata all'`rdns` del wallet e alla chain (`io.rabby:1`). Per MetaMask la conferma non
cambia il consiglio (Smart Transactions; un RPC personalizzato le disattiverebbe), come nel riferimento (G8).

### D-31 · Soglie di prezzo incluse — da notare
La specifica dice "oltre il 2 %" e "oltre il 10 %"; il riferimento usa `≥` (esattamente 2,00 % → `warn`, 10,00 % → `danger`, 1,00 % → superata).
Ho mantenuto il comportamento del riferimento e l'ho fissato in una tabella di casi (G1, G2). **Approvato (Fase 5): si mantiene `≥`**; la specifica
(`docs/reference/exchange-book-README.md`) ora dice "dal 2% in su", "dal 10% in su" e, per coerenza, "dall'1% in su" per `isStale`.

### D-32 · Il client non dipende da `@fondaco/contracts` — D
Per avere `viem` come unica dipendenza pubblicata, il client definisce le sue ABI minime e i suoi tipi (`Order`, …) invece di importarli dal pacchetto
contracts. La coerenza tra i due è coperta dai test su fork (stessi ordini firmati, stesso contratto).

## Fase 5

### D-33 · App senza framework — D
TypeScript + DOM con Vite. Il prototipo è già DOM + CSS: markup e foglio di stile restano identici (fedeltà esatta), il bundle resta piccolo.
La UI parla solo con un'interfaccia `Backend` (`src/backend.ts`), implementata dal backend live e, solo nella build `DEMO=true`, da quello simulato
(import dinamico: il codice demo non è nel bundle di produzione, verificato da K4).

### D-34 · L'app si fida della propria configurazione — D
Contratto e monete vengono da `config.json` (o da Impostazioni, con avviso esplicito), mai dalla bacheca. Se la bacheca dichiara un altro contratto lo
scambio è bloccato; il dominio EIP-712 è costruito dall'app; una coppia appare solo se entrambe le monete sono configurate nell'app.

### D-35 · Niente source map nella build pubblicata — D
Le source map contengono i commenti dei sorgenti di terze parti (viem cita fornitori RPC nella documentazione), che la scansione delle chiavi dovrebbe
altrimenti mettere in whitelist. La build è riproducibile dal repository.

### D-36 · Tempo della catena per scadenze e "scade tra" — D
L'app usa il tempo della catena servito dalla bacheca (`/candles.now`, estrapolato), non l'orologio del dispositivo: il contratto confronta la scadenza
con `block.timestamp`. Verificato sul fork, dove il tempo della catena è indietro di un anno.

### D-37 · Impostazioni su telefono — da notare
Sotto 520 px l'intestazione non ha spazio per un quarto elemento: l'ingranaggio passa nel foglio Wallet ("Impostazioni: bacheca, RPC, contratto") e
l'etichetta Demo diventa una linguetta sotto il logo (il prototipo la nasconde sotto 520 px; qui deve restare sempre visibile).

### D-38 · Due correzioni rispetto al prototipo — da notare
1. Dopo aver scritto un importo, il primo clic su un prezzo ("Altro") andava perso: il blur del campo ridisegnava i pulsanti tra mousedown e mouseup
   (stesso comportamento nel prototipo). Ora i pulsanti si ridisegnano solo se cambiano. Trovato dall'e2e.
2. Gli importi venivano convertiti con `toFixed(18)`, che espone il rumore binario (0,2 → 0,200000000000000011 WETH firmati). Ora si parte dalla
   rappresentazione decimale più corta (U15–U17, W12).

### D-39 · Commissione mostrata dalla bacheca — D
La percentuale nel riquadro "Proponi" e il calcolo dell'importo da autorizzare usano `protocolFee` di `/config`, non lo 0,30% scritto nel
prototipo.

### Punti aperti (Fase 5)
- **Avviso sulla scadenza**: la specifica originale dice "avviso oltre 24 h"; la richiesta di Fase 5 e il prototipo lo mostrano a 7 giorni. Ho
  seguito la Fase 5 e il prototipo.
- **"Annulla ora" su `invalid_signer` ancora eseguibile**: coperto dai test unitari (U12) e dalla UI, ma non dall'e2e (servirebbe una delega
  `authorize` revocata e poi ripristinata sul fork). Si può aggiungere in Fase 6.
- **MEV nel browser**: con un wallet del browser l'invio passa sempre dal wallet (`createSubmitter` in modalità wallet). La riga MEV mostra lo
  stato reale di quel wallet (W3b: "Mempool pubblica" per un wallet sconosciuto, con il link "Attivala" alla guida).

## Cambio del contratto di riferimento

### D-40 · Riferimento = tag v4.3 (6ad0137), identico al deploy AirSwap "V5.0" — D (richiesto)
Il sorgente di riferimento passa da v5.0.0 (`28156e5`) a **v4.3** (`6ad0137fa62ab2bd9eead257b77b8f77962d0bf3`, SwapERC20.sol
SHA-256 `4103d213…3a36`), stesse impostazioni (solc 0.8.23, 999999 run, paris, solady 0.0.173). Motivo: è il codice che AirSwap ha
deployato come "V5.0" ed è coperto dall'audit PeckShield "AirSwap V4.3".

Confronto con `eth_getCode` di `0xD82E10B9A4107939e55fCCa9B53A9ede6CF2fC46` (verify-source passo 7, `reports/verify-source.json`):

| Chain | RPC | Runtime | Escluso metadata | Metadata | Immutabili lette | sha256 del codice on-chain |
|---|---|---|---|---|---|---|
| Ethereum (1) | eth.drpc.org | 11 264 byte | **identico** | identico | `DOMAIN_CHAIN_ID` = 1, `DOMAIN_SEPARATOR` = `0xaabfe942…1d9d` | `58c22fde…7be8` |
| Base (8453) | mainnet.base.org | 11 264 byte | **identico** | identico | `DOMAIN_CHAIN_ID` = 8453, `DOMAIN_SEPARATOR` = `0x15c1a531…527c` | `dfbbf66e…ec40` |

Le immutabili vengono mascherate nel confronto (posizioni da `immutableReferences` di solc) e poi controllate: i due
`DOMAIN_SEPARATOR` coincidono con keccak(EIP712Domain, `SWAP_ERC20`, `4.3`, chainId, indirizzo) ricalcolato a parte. Sourcify:
`exact_match` di creazione e runtime su entrambe le chain (verificato rispettivamente l'8 agosto 2024 e il 9 luglio 2026).
Fixture ricompilato: 12 123 byte, sha256 `45dffc57…6109`. Fixture v5.0.0 e `Wrapper.json` rimossi; differenze in `docs/AUDIT-DIFF.md`.

### D-41 · Audit PeckShield V4.3 e riserva — da notare
Report #2024-047 (23 aprile 2024, `docs/audits/`, SHA-256 `d1ccb9b3…03e2`): commit esaminato `bcd4c48`, commit dopo le correzioni
`27b60da`. Accettato `27b60da` come riferimento auditato: dal sorgente deployato differisce **solo** per `version = "4.2"` → `"4.3"`
nel dominio EIP-712 (più commenti); i sei file solady importati sono identici tra 0.0.172 e 0.0.173.
Rilievi: PVE-001 (Low) e PVE-002 (Informational) su Staking, che il progetto non usa (stakingToken = 0); PVE-003 (Informational)
su `check()`, risolto in `bcd4c48`. Nota: PVE-002 è "Resolved" nella tabella ma "confirmed" nel dettaglio.
**Riserva:** il passaggio OpenZeppelin → solady (#1293) sta tra il commit esaminato e quello post-correzioni; il report indica
`27b60da` come commit finale ma non dice se quel cambio è stato riesaminato.

### D-42 · Nomi degli errori e `check()` della v4.3 — D
`InvalidFee`, `InvalidFeeLight`, `InvalidFeeWallet`, `InvalidStaking`, `ChainIdChanged`; `check()` con `MAX_ERROR_COUNT = 8`.
`SignatureInvalid` e `NonceAlreadyUsed` si escludono, quindi il caso peggiore riempie 7 slot su 8 (test
`test_checkWorstCaseSevenErrorsInEightSlots`). Il client e il book server non decodificano gli errori di parametro e leggono
`check()` come array dinamico: nessuna modifica di logica. `ChainIdChanged` nel client ricade su `unknown`, ma non può presentarsi:
il client legge sempre la chain del contratto configurato.

### D-43 · `swapLight` della v4.3 non controlla la chain — da notare
In v4.3 solo `swap`/`swapAnySender` passano da `_check` (che reverte con `ChainIdChanged`); `swapLight` no, e il
`DOMAIN_SEPARATOR` è fisso: dopo uno split della chain un ordine `swapLight` firmato sulla chain originale resterebbe
eseguibile sull'altra. FONDACO non firma né esegue ordini `swapLight` (senderWallet = 0, `swapAnySender`). Fissato dal test
`test_swapLightIgnoresChainId`. Non è tra i rilievi dell'audit.

## Fase 6

### D-44 · Rilevatore di sovrapposizioni scritto da zero — da notare
La richiesta chiedeva di "portare il rilevatore a campionamento di punti del prototipo", ma né `docs/reference/mini-exchange.html`
né la specifica ne contengono uno. L'ho scritto in `apps/web/test/layout.mjs`. Per ogni elemento con testo o controllo, campiona
una griglia 3×3 della parte visibile (viewport ∩ contenitori che ritagliano) con `elementFromPoint`. Non conta come sovrapposizione:
- l'intestazione, la barra inferiore e il toast, che coprono il contenuto per progetto;
- le parti di uno stesso controllo;
- un contenitore chiuso.
Un autotest (L0) dimostra che rileva una copertura e un taglio iniettati.

### D-45 · Avvio: il libro in un solo round trip — D
- `public/boot.js` (1 kB, senza dipendenze, prima del CSS) chiede `/config` e `GET /books`, il nuovo endpoint batch della bacheca,
  mentre il bundle principale si scarica; l'app prende le risposte per URL esatto, e se l'URL non coincide fa la richiesta normale.
- Il backend live è importato staticamente; il runtime del wallet (client viem, approve, taker) è caricato all'uso.
- Il client è diviso in moduli puri (`plan.ts`, `guards.ts`, `errors.ts`, API pubblica invariata), così il primo bundle non
  trascina le azioni viem.
- La shell resta invisibile fino al primo render (CLS).
Fast 3G = profilo DevTools (562,5 ms di RTT, 1,44 Mbit/s); la misura vale con lo splash già visto nella sessione.

### D-46 · Font: sottoinsiemi latini — D
I cinque Geist (OFL, nessun Reserved Font Name) sono ridotti a Latin + Latin-1 + punteggiatura, valute e frecce usate, con tutte le
feature OpenType: 118 kB invece di 250 kB. Lo script è `scripts/subset-fonts.sh`; il test U36 fallisce se il codice usa un
carattere fuori dal sottoinsieme.

### D-47 · Offerta privata nell'app — da notare (aggiunta di prodotto)
Il flusso richiesto non esisteva nel prototipo. Aggiunte minime:
- campo "Solo per un indirizzo" in Proponi, con l'offerta firmata come `senderWallet` e in una sola parte;
- "Copia link" in Le mie offerte, che produce `#offerta=<hash>`;
- l'apertura nel foglio di conferma, solo per quell'account.
La bacheca già nascondeva gli ordini privati dal libro e li serviva per hash.

### D-48 · Rifirma con lo stesso nonce — D (correzione di un difetto)
Prima la rifirma usava nonce nuovi: se la fee tornava al valore precedente, ordini vecchi e nuovi erano validi insieme, e il
firmatario era esposto due volte. Ora l'app rifirma con lo stesso nonce. La bacheca accetta il riuso solo sopra un ordine
`invalid_fee` con le stesse condizioni (token, importi, controparte; cambiano fee, firma e scadenza) e lo sostituisce.
La rifirma alza prima l'autorizzazione se la nuova fee lo richiede: in quel caso non è gratis, ed è una transazione.

### D-49 · Soglie di prestazione — D (proposte)
- Bundle iniziale (JS + CSS referenziati da `index.html`) ≤ 60 kB gzip, oggi 49,2 kB.
- Font ≤ 130 kB.
- Libro visibile su Fast 3G ≤ 2 s.
- Lighthouse mobile ≥ 0,90 su Performance e Accessibility, mediana di 3 esecuzioni.
Valori in `apps/web/test/perf.mjs` (`BUDGET`).

### D-50 · `txTimeoutSec` in `config.json` — D
È il tempo di attesa della conferma prima di fermarsi (default 300 s, 5–3600). Serve all'e2e del timeout ed è un parametro di
deploy ragionevole.

### D-51 · Scostamenti dal prototipo per accessibilità e layout — da notare
- Etichette degli assi del grafico in `--muted`: erano `--faint`, a 3,33:1.
- Hover del pulsante principale più scuro: il più chiaro dava 4,25:1.
- Sotto i 400 px il tag "TU" nel libro è un punto: copriva la quantità; il testo resta per i lettori di schermo.
- In demo, su telefono, l'intestazione è più alta di 20 px per contenere l'etichetta Demo: la soluzione D-37 la faceva uscire
  sopra il contenuto.

### Punti aperti (Fase 6)
- **`page-has-heading-one`** (axe, *moderate*): l'unico `<h1>` è nello splash. Un `<h1>` stabile richiede di cambiare il markup
  del marchio. Non è richiesto (serious/critical = 0), lo propongo per la Fase 7.
- **LCP 2,5 s** su Lighthouse: è il marchio dello splash, la cui animazione dura 2,8 s per progetto. Accorciarla migliorerebbe il
  punteggio, ma è una scelta di design.
- **Console in F9**: le righe `net::ERR_CONNECTION_REFUSED` sono stampate da Chrome per le richieste fallite e non si possono
  evitare; sono l'unica eccezione ammessa, dichiarata nel test.
- **RPC di fork gratuito** (drpc): un timeout 408 ha fatto saltare una volta l'invariante 3 di Foundry. Per CI conviene un RPC
  d'archivio meno limitato.

### D-52 · CI: rapido su PR, completo di notte — D
- **Su `pull_request`:** profilo `quick` (salta le suite lente), Foundry con il profilo `ci-quick`, RPC gratuito con
  `--retries 3`.
- **Di notte e con `workflow_dispatch suite=full`:**
  - tutte le suite;
  - Foundry completo;
  - `FORK_RPC_URL` dal secret (RPC d'archivio a pagamento), con ricaduta sull'RPC pubblico se il secret manca.
- **Permessi:** `contents: read` ovunque; `packages: write` solo in `docker-publish`, su `main` o sui tag.

### D-53 · `workflow_dispatch` vive solo sul branch predefinito — da notare
GitHub accetta il dispatch soltanto per i workflow presenti sul branch predefinito, quindi un dispatch sul branch di lavoro
risponde 404. Per la prova della Fase 7 ho aggiunto un trigger `push` temporaneo sul branch di lavoro, che il piano tratta
come `full`. È stato tolto dopo le run verdi. Per abilitare il dispatch, `verify.yml` deve arrivare su `main`, e per questo
serve la tua conferma.

### D-54 · Rendering del testo fissato nei test dell'app — D
Sul runner GitHub, V1 falliva su tutte le 20 schermate (0,6–6,7%) e L1 vedeva l'importo coprire l'etichetta. Il motivo è che
il runner fa l'hinting completo dei glifi: avanzamenti a pixel interi, testo un po' più largo, a capo diversi. Le run 1 e 3
hanno dato le stesse percentuali, quindi l'errore è deterministico.
- **Correzione.** Il browser di test parte con `--font-render-hinting=none` e con `FONTCONFIG_FILE=apps/web/test/fontconfig/fonts.conf`
  (niente hinting, antialiasing in scala di grigi). In locale i pixel non cambiano e in CI L1 passa, così come 16 schermate su 20.
- **Residuo.** Due fogli (conferma e wallet, a 390 e 1440) mettono il testo a offset frazionari, e il runner lo rasterizza con
  un antialiasing leggermente diverso (0,4–2,2%, posizioni identiche). Per queste quattro schermate il CI usa
  `test/visual/baseline-ci/`, preso a mano dagli artefatti `*-actual.png` della run 4 dopo averli guardati. `--update` non le
  scrive mai.
- **Altre misure.** I test aspettano comunque che tutte le facce dei font siano caricate (`fontsLoaded`) e falliscono se una
  manca: non era la causa, ma toglie una fonte di instabilità.

### D-55 · Stima del gas del deploy su testnet — D
Il nodo pubblico di Sepolia stima 18,2 M di gas per il deploy, mentre quello misurato sul fork è 2.578.924. Il piano usa il gas
misurato ×1,2 e riporta anche la stima del nodo. Il deploy vero passa comunque da `estimateGas` del wallet.

### D-56 · Immagine della bacheca — D
L'immagine viene pubblicata su GHCR solo da `main` e dai tag `v*`, con il digest nel riepilogo della run. Sui branch viene
costruita e provata con lo smoke test, ma non pubblicata.
