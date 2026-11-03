# exchange-book

Book off-chain per un mini exchange **P2P non-custodial** basato su **AirSwap SwapERC20 v5.0.0** (codice AirSwap invariato dal tag v5.0.0, nessun codice Solidity proprio; prima della produzione serve un audit di questa versione).
Chi propone firma l'ordine senza gas e paga la fee di piattaforma; chi accetta paga solo il prezzo e il gas.

- Una sola dipendenza: `viem`. Database: `node:sqlite` integrato in Node ≥ 22.13 (nessun modulo nativo).
- Letture on-chain raggruppate in Multicall3: la rivalidazione di N ordini costa **1 richiesta RPC ogni ~400 chiamate**.

## Modello

| Ruolo | Cosa fa | Cosa paga |
|---|---|---|
| Proponente (signer) | firma `OrderERC20` (EIP-712, dominio `SWAP_ERC20` v`4.3`) con `senderWallet = 0` | `signerAmount` + fee (`signerAmount × protocolFee / 10000`) |
| Chi accetta (sender) | chiama `swapAnySender` (o il Wrapper per pagare/ricevere ETH) | `senderAmount` + gas |
| Piattaforma | valida, indicizza e serve il book | — incassa la fee nel token del proponente |

- **Ordini privati (OTC):** il proponente indica `senderWallet`; solo quell'indirizzo può eseguirlo con `swap`. Non compaiono nel book pubblico, ma sono leggibili tramite hash.
- **Fill parziali:** con una scala di ordini piccoli (nonce diversi), annullabili in blocco con `cancel(nonces[])`.

## Stati di un ordine

`open` → eseguibile e finanziato · `unfunded` → saldo o allowance insufficienti, contando anche gli altri ordini aperti dello stesso firmatario sullo stesso token (vengono finanziati prima i più vecchi) · `filled` · `cancelled` · `expired` · `invalid_fee` (fee del contratto cambiata; se torna al valore firmato l'ordine si riattiva) · `used` (nonce consumato, evento non ancora indicizzato: diventa `filled`/`cancelled` quando arriva) · `invalid_signer` (il firmatario ha impostato un delegato con `authorize`: le sue firme non valgono più on-chain; terminale, va rifirmato dopo `revoke`). I wallet con delegato vengono rifiutati in ingresso (`delegated_signer`).

## API

| Metodo | Percorso | Note |
|---|---|---|
| GET | `/config` | per ogni chain: indirizzi, `protocolFee` attuale, dominio e tipi EIP-712, token ammessi |
| POST | `/orders` | `{ chainId, order }` oppure `{ chainId, orders: [...] }` (fino a 50, es. una scala) |
| GET | `/book?chainId&base&quote&limit&signed` | `asks` / `bids` ordinati dal migliore, solo ordini pubblici, `open` e non in scadenza entro `expiryBufferSec`; `ETag`/`304`; con `signed=1` ogni voce include l'ordine firmato (per chi esegue) |
| GET | `/orders/:hash` | stato e ordine firmato completo (serve a chi esegue) |
| GET | `/orders?chainId&signer` | ordini di un indirizzo |
| GET | `/stream` | SSE: eventi `order` (cambio di stato), `fee` e `reorg` |

Formato dell'ordine: tutti i campi di `OrderERC20` come stringhe decimali o indirizzi, più `v` (27/28), `r`, `s`.

## Controlli all'ingresso

Whitelist dei token · token diversi · importi > 0 e ≥ minimo del token · fee non nulla dopo l'arrotondamento · `protocolFee` uguale a quella on-chain · scadenza tra `minExpirySec` e `maxExpirySec` (sul tempo della chain) · firma valida (EOA in locale; smart wallet EIP-1271 via RPC, solo firme da 65 byte; wallet con delegato `authorize` rifiutati) · hash e nonce non duplicati (anche nello stesso lotto) · nonce non usato on-chain · saldo e allowance ≥ importo + fee.

## Motore: sicurezza e prestazioni

**Indicizzazione con gestione dei reorg.** Gli eventi del contratto (fill, cancel, fee, authorize/revoke) vengono letti fino alla testa della chain, senza attesa di conferme, e ogni stato osservato on-chain (`filled`, `cancelled`, `used`) registra il blocco in cui è stato visto. Il server salva l'hash dell'ultimo blocco indicizzato: se non è più canonico (reorg), tutti gli stati visti negli ultimi `reorgDepth` blocchi (64 ≈ finalità su Ethereum) tornano `unfunded`, quei blocchi vengono reindicizzati e parte una verifica completa. Evento SSE `reorg`.

**Rivalidazione guidata dagli eventi.** A ogni giro: 1 richiesta per la testa; se non c'è un blocco nuovo il giro finisce lì. Altrimenti i log `Transfer`/`Approval` (verso SwapERC20)/`Deposit`/`Withdrawal` dei token in whitelist dicono quali coppie (firmatario, token) sono cambiate, e solo quelle vengono rilette (≈ 4 richieste per giro, indipendentemente dalla dimensione del book). Fino a `logSignerChunk` firmatari il filtro è fatto dal nodo, oltre si legge l'intervallo breve senza filtro e si filtra qui. Una verifica completa di tutti gli ordini gira comunque ogni `fullSweepMs`, dopo un reorg, un cambio fee o un vuoto più lungo di `signalMaxBlocks`: copre ciò che i log non mostrano (blacklist, pause, log persi).

**Letture coerenti.** Una sola chiamata Multicall è atomica; se servono più blocchi di 400 chiamate vengono tutte fissate allo stesso numero di blocco.

**Smart wallet (EIP-1271).** La loro firma può smettere di valere in qualsiasi momento (es. cambio owner di un Safe): i loro ordini vengono ricontrollati con `SwapERC20.check()` in ogni rivalidazione e passano a `invalid_signer` se la firma non è più accettata.

**Qualità del book.** Rifiutati gli ordini la cui fee si arrotonda a zero (`fee_too_small`: polvere senza commissione) e quelli sotto il minimo per token (`tokens[addr].min`, unità base: `amount_too_small`). Gli ordini che scadono entro `expiryBufferSec` non vengono più offerti nel book (chi accetta non rischia `OrderExpired`). Capienza totale `maxLiveOrders` (`book_full`) oltre a `maxOpenPerSigner`. Nessuna cancellazione "soft": un ordine firmato resta eseguibile finché il nonce non è usato on-chain, quindi l'unico annullamento è `cancel()`.

**API.**
- Timeout per client lenti (header 10 s, richiesta 20 s, keep-alive 5 s).
- `POST` solo con `content-type: application/json`: blocca i POST cross-origin "semplici".
- Corpo massimo 256 KB, al massimo 50 ordini per lotto, al massimo `maxConcurrentSubmits` inserimenti in parallelo (`503 busy`). Il recupero firma cede il ciclo di eventi ogni 8 ordini.
- Limite di richieste per client:
  - LRU limitato: un flood di chiavi nuove non azzera i contatori degli altri.
  - IPv6 raggruppato per /64, con un secondo limite per /48 (budget 16×).
  - `X-Forwarded-For` usato solo con `trustProxy: N`; si prende l'N-esimo indirizzo da destra.
- SSE: al massimo `ssePerClient` stream per client (`503`).
- Book in cache per versione: ogni cambio di stato la invalida. `ETag` e `304`.
- Gli ordini privati elencati per firmatario non includono la firma: l'ordine completo si ottiene solo con l'hash.

**RPC.** `rpc` può essere una lista (failover automatico). L'esecuzione resta comunque protetta lato compratore dalla simulazione sul proprio RPC (`client/taker.js`).

Test: `npm run test:engine` (13 scenari: rivalidazione incrementale, modifica senza evento coperta dalla verifica completa, WETH deposit/withdraw, giro a vuoto = 1 richiesta, reorg, buffer di scadenza, polvere, capienza, ETag, content type, limite SSE, slowloris, ordini privati, chiavi client).

## Avvio

```bash
npm install
cp config.example.json config.json   # inserisci RPC, indirizzi deployati, token
npm start
```

## Deploy del contratto (per ogni chain)

Chiave deployer **dedicata** con nonce 0 su ogni chain: così SwapERC20 (tx #0) e Wrapper (tx #1) hanno lo stesso indirizzo ovunque.

```bash
RPC_URL=... PRIVATE_KEY=... FEE_BPS=30 FEE_WALLET=0xSafeFee OWNER=0xSafeOwner WETH=0x... npm run deploy
```

Lo script deploya SwapERC20 con `protocolFee = protocolFeeLight = FEE_BPS` e bonus a zero, trasferisce l'ownership al Safe e verifica lo stato finale. Il Wrapper usa Ownable2Step: **il Safe deve chiamare `acceptOwnership()`**.

⚠️ Non usare una factory CREATE2: il costruttore assegna l'owner a `msg.sender`, che diventerebbe la factory, e fee e wallet delle fee resterebbero bloccati per sempre.
⚠️ Non chiamare mai `setStaking` (non si può riportare a zero). Cambiare `protocolFee` invalida tutti gli ordini aperti.

## Test (fork mainnet locale)

```bash
# in un altro terminale: nodo fork con chainId 1, es.
#   anvil --fork-url $MAINNET_RPC --chain-id 1     oppure   npx hardhat node (forking)
npm test            # 19 controlli end-to-end
npm run test:deploy # 4 controlli sullo script di deploy
```

I bytecode in `test/fixtures/` sono compilati dal tag `v5.0.0` di `airswap-protocols` (solc 0.8.23, optimizer 999999 run, le stesse impostazioni del repository).

## Rischi residui da gestire

- Nessun report di audit pubblico copre esattamente SwapERC20 v5.0.0: conviene una review del diff rispetto alla v4 auditata.
- Togliere un ordine dal book non lo annulla: la firma resta valida fino alla scadenza o a `cancel` on-chain (per questo le scadenze sono brevi).
- Phishing tramite firme: mostrare l'ordine in chiaro prima della firma e proporre approvazioni limitate.
- L'operatore vede gli ordini per primo: dichiarare o vietare l'esecuzione in proprio.
- Normativa (MiCA): serve un parere legale prima del lancio.

## Esecuzione lato compratore (`client/taker.js`)

Modulo per il frontend (browser o Node, solo `viem`): `import { createTaker, plan } from 'exchange-book/taker'`.

1. **`plan(book.asks | book.bids, importo)`** — dal book con `signed=1` prende ordini **interi** dal migliore (ogni ordine è tutto-o-niente). Risultato `kind: 'indicative'`.
2. **`taker.verify(plan)`** — una sola lettura Multicall: `check()` di SwapERC20 per ogni ordine (firma, nonce, scadenza, fondi del proponente alla fee attuale) + saldo e allowance di chi compra. Risultato `kind: 'verified'` con il blocco, gli ordini scartati e se serve l'approve.
3. **`taker.execute(verified, { approval: 'exact' | 'max' })`** — approve se serve (con reset a 0 per token tipo USDT), poi per ogni ordine: `eth_call` di `swapAnySender` subito prima dell'invio, invio, tracciamento.

Garanzie:
- **Destinatario fisso**: non è un parametro. Ogni chiamata paga l'account connesso; il calldata viene decodificato e verificato (contratto, funzione, `recipient`) prima di passarlo al wallet.
- **Ordine preso prima dell'invio** → saltato dalla simulazione, nessun gas (`skipped`, `costsGas: false`).
- **Ordine preso nello stesso blocco** → transazione fallita, diagnosticata leggendo `nonceUsed` (`failed`, `reason: 'taken'`, `costsGas: true`).
- **Velocizzata nel wallet** (stessa chiamata, fee più alta) → seguita fino alla sostituta (`sped_up`).
- **Annullata o sostituita** nel wallet, **firma rifiutata**, **timeout** → l'esecuzione si ferma, gli ordini restanti non vengono inviati.

Eventi per la UI via `onUpdate`: `verified`, `approval_reset`, `approving`, `simulating`, `awaiting_signature`, `pending`, `sped_up`, `filled`, `skipped`, `failed`, `cancelled`, `replaced`, `timeout`, `rejected`, `done`. Testi in italiano in `REASONS`.

Test: `npm run test:taker` (fork mainnet, 11 scenari: piano, verifica, approve esatto, gara prima dell'invio e in mempool, speed-up, cancel, rifiuto, USDT, ordini privati).

## Protezione MEV lato utente (`client/protect.js`)

Nessuna dipendenza dal server: tutto avviene dove l'utente firma.

- **Invio privato** — `createSubmitter({ publicClient, walletClient, chainId })`. Con un account locale (bot, script, wallet incorporato) la transazione viene firmata qui e inviata a un RPC protetto (mainnet: MEV Blocker `/noreverts`, Flashbots Protect `/fast`), non alla mempool pubblica: nessuno può copiarla e anticiparla. Con revert protection una transazione che fallirebbe (offerta già presa) non viene inclusa: zero gas. Il nonce si prende su `latest`, così l'ordine successivo subentra a quello mai incluso. Con un wallet del browser (`json-rpc`) l'invio lo fa il wallet: `mode: 'wallet'`, `why: 'browser_wallet'`, e l'app spiega come attivare la protezione nel wallet. Su L2 con sequencer (Base, OP, Arbitrum) `why: 'sequencer'`: non c'è mempool pubblica.
- **Compratore** — `createTaker({ ..., submitter })`: fill e approve passano dal submitter; un ordine non incluso perché preso da altri diventa `skipped` con `reason: 'not_included'`, `costsGas: false`, e si prosegue con il successivo.
- **Annullamento protetto** — `cancelOrders({ publicClient, walletClient, submitter, swap, nonces })`: un `cancel()` in mempool pubblica può essere anticipato da un fill; inviato in privato no. Riporta `cancelled` o `partly_taken` con i nonce già eseguiti.
- **Controlli di prezzo** — `priceCheck({ side, price, mid })`: `warn` dal 2% in su più conveniente del prezzo di mezzo per chi accetta, `danger` dal 10% in su (l'app chiede conferma esplicita prima di pubblicare). `isStale(...)` segnala le offerte aperte superate dal mercato (dall'1% in su). Le soglie sono incluse: esattamente 2,00% è già un avviso (D-31). `EXPIRY`: scadenza di default 1 h, avviso oltre 24 h.

Test: `npm run test:protect` (5 scenari: invio privato, ordine preso e non incluso senza gas con subentro del nonce, scelta della modalità, annullamento protetto, controlli di prezzo).

### Stato della protezione per wallet (`client/wallet-protection.js`)

Solo informativo per l'interfaccia: non cambia come viene inviata una transazione.

- `discoverWallets()` — EIP-6963: chiede ai wallet installati di annunciarsi e restituisce `{ info: { uuid, name, icon, rdns }, provider }` (deduplicati per `uuid`).
- `protectionStatus({ rdns, chainId, userSetRpc })`:
  - `l2` (Base, OP, Arbitrum) — non serve: sequencer, nessuna mempool pubblica;
  - `wallet` (MetaMask, MetaMask Flask su mainnet) — protetto da Smart Transactions, attivo di default: l'app chiede di verificarlo e avverte di **non** impostare un RPC personalizzato, che lo disattiverebbe;
  - `guide` (altri wallet su mainnet) — non protetto: guida in 4 passi e gli RPC protetti da copiare (MEV Blocker `/noreverts`, Flashbots Protect `/fast`);
  - `user_rpc` — l'utente ha confermato di aver impostato l'RPC protetto (ricordato per wallet);
  - `none` — rete senza RPC protetto noto.

Test: `npm run test:wallet` (5 controlli, senza chain).
