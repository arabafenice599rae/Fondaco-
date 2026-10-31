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

### D-10 · Test Foundry senza forge-std — D
L'aggiunta di forge-std come submodule è stata bloccata dalla policy dell'ambiente (integrazione di codice di terzi). I test usano
un'interfaccia dei cheatcode scritta qui (`foundry/test/utils/Vm.sol`, solo le funzioni usate) e asserzioni proprie: nessun codice di
terzi nel repository. Se preferisci forge-std (es. `deal`, `StdInvariant`), si può aggiungere come submodule fissato a un commit, con la tua autorizzazione.

### D-11 · TypeScript compilato in `dist/` — D
`@fondaco/contracts` si compila con `tsc` (strict, `exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`) in `dist/`.
Niente esecuzione diretta di `.ts` (stripping dei tipi stabile solo da Node 22.18, il requisito è ≥ 22.13). `lib` include `DOM` perché i tipi di viem/ox lo richiedono.

## Punti aperti

### A-06 · Test sul contratto con fuzz di tipo "invariant"
I test Foundry coprono le invarianti con fuzz per funzione (256 run). Un invariant test con handler (sequenze casuali di fill/cancel/fee)
è previsto dal test differenziale della fase 3 lato server; se lo vuoi anche in Solidity, serve forge-std (`StdInvariant`) o un handler scritto qui.
