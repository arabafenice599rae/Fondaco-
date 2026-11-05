# Fase 6 — Test avanzati dell'app: risultati

Ambiente: anvil al blocco fisso (`fork.config.json`), SwapERC20 v4.3 dal fixture, due book server, build statica servita con
gzip, wallet EIP-6963 iniettato che inoltra agli account sbloccati di anvil (nessuna chiave). Layout, accessibilità e
regressione visiva usano la build `DEMO=true` (dati simulati, deterministici). Comando: `node tools/testkit/run-suites.mjs`.

## Tabella dei test

**35 suite, 320 controlli, tutti verdi.** Foundry ha avuto un errore di infrastruttura alla prima esecuzione e poi è passato
29/29 (vedi la nota sotto la tabella).

| Suite | Esito | Contenuto |
|---|---|---|
| **web-flows** (nuova) | 21/21 | F1–F9 qui sotto + F10 console pulita in 11 pagine |
| **web-perf** (nuova) | 4/4 | bundle iniziale, font, Fast 3G, Lighthouse mobile |
| **web-layout** (nuova) | 5/5 | rilevatore di sovrapposizioni (autotest + 420 campioni), scorrimento orizzontale, console |
| **web-a11y** (nuova) | 3/3 | axe-core, contrasto misurato, tastiera nei fogli |
| **web-visual** (nuova) | 2/2 | 20 screenshot di riferimento + autotest |
| web-e2e | 18/18 | smoke della Fase 5, ora anche con gli avvisi della console |
| web-model | 39/39 | +4: copertura dei font, URL di boot.js = app, `txTimeoutSec`, offerte private |
| web-keys | 6/6 | +1: niente source map (K6); niente codice demo in produzione (K4) |
| e2e (book) | 22/22 | +1: E11b rifirma con lo stesso nonce |
| trades (book) | 12/12 | +2: `GET /books` (T10, T11) |
| foundry | 29/29 | invariato dopo la Fase v4.3 |
| altre 24 suite | tutte ok | regressione delle fasi precedenti |

Nota su Foundry: alla prima esecuzione l'invariante 3 non è partito. L'RPC pubblico gratuito usato per il fork (drpc) ha
risposto `408 Request timeout on the free plan`, quindi l'invariante ha fatto 0 esecuzioni. Rilanciata da sola, la suite è
passata 29/29. Non è un errore del codice. Con un RPC d'archivio meno limitato non si ripete.

## 1. Flussi e2e (web-flows)

Ogni flusso verifica i saldi on-chain.

| | Flusso | Risultato misurato |
|---|---|---|
| F1 | Scala in 4 parti → acquisto di 1 parte da un secondo account → "Eseguite 1 su 4" → "Annulla il resto" | taker +0,1 WETH −250 USDC; maker +250 USDC −0,1003 WETH; i 3 nonce residui risultano usati on-chain, ordini `cancelled` |
| F2 | Fondi del firmatario spostati → "In pausa" → fondi rimessi → "Attiva" | `unfunded` → `open`; saldo 0 → ripristinato |
| F3 | `setProtocolFee(40)` dall'owner (Safe di test) → "Da rifirmare" → rifirma → "Attiva"; fee riportata a 30 | la rifirma usa lo **stesso nonce**, l'ordine vecchio è sostituito, l'autorizzazione viene alzata a importo + nuova fee; l'offerta mai rifirmata torna attiva senza rifirma |
| F4 | Pubblica → `authorize` → `revoke` → avviso e "Annulla ora" → annullamento protetto | `invalid_signer` con executableOnChain da false a true → `cancelled`, nonce usato, pulsante sparito |
| F5 | Gara: la 2ª offerta di uno scambio da 2 viene presa da un terzo account durante l'esecuzione | "Scambio parziale completato"; taker +0,1 WETH −240 USDC, terzo account +0,1 WETH; costo mostrato 0,003361 ETH = somma delle 3 ricevute = ETH spesi |
| F6 | Offerta privata sulla **seconda bacheca** | assente dal libro; il link copiato apre l'offerta; per un altro account: "Questa offerta non è per te" e `swap` rifiutato on-chain; la controparte la esegue con saldi esatti |
| F7 | Firma rifiutata nel wallet; poi timeout di conferma con automine spento (`txTimeoutSec` 8) | rifiuto: nessuno swap inviato e saldi intatti; timeout: stop dopo 9 s, la 2ª offerta mai inviata; alla ripresa dei blocchi viene eseguita esattamente una offerta |
| F8 | Cambio rete nel wallet 1 → 8453 → 1 | etichetta Base; MEV da `guide` a `l2`; contratto non configurato su Base, quindi banner, nessun mercato e scambio disattivato; poi di nuovo su Ethereum |
| F9 | Bacheca irraggiungibile all'avvio | "Bacheca non disponibile", stato vuoto esplicito, scambio disattivato, nessun errore JavaScript |

La console è pulita in tutte le pagine dei flussi e dell'e2e: nessun errore, nessun avviso, nessuna eccezione. L'unica
eccezione ammessa, e dichiarata nel test F9, sono le righe `net::ERR_CONNECTION_REFUSED` che Chrome stampa da solo quando
la bacheca non risponde.

## 2. Sovrapposizioni (web-layout)

- **Copertura:** 15 viste e fogli × 7 viewport (320×640, 360×740, 390×844, 430×932, 900×800, 1280×800, 1440×900) × 4
  posizioni di scorrimento = 420 campioni.
- **Esito:** zero elementi coperti o tagliati, nessuno scorrimento orizzontale.
- **Autotest (L0):** una copertura e un taglio iniettati vengono rilevati.
- **Troncamenti voluti:** 96, tutti sull'importo che si adatta con i puntini in "Ricevi"; elencati in `reports/layout.json`.

## 3. Accessibilità (web-a11y)

- **axe-core 4.14:** zero violazioni serious/critical in 15 viste e fogli × 390/1440. Restano 16 avvisi *moderate*
  (`page-has-heading-one`): la pagina non ha un `<h1>` stabile, perché l'unico è nello splash (vedi i dubbi).
- **Contrasto misurato:** 3273 nodi di testo, minimo **4,59:1**. Il colore di ogni testo è confrontato con lo sfondo
  effettivo, composto risalendo gli antenati con le loro trasparenze. Esclusi i controlli disabilitati, come fa la WCAG.
- **Tastiera:** su 5 fogli su 5 il foglio si apre con Invio, Tab e Maiusc+Tab (35 pressioni) restano dentro, Esc chiude e il
  focus torna a chi l'aveva aperto.

## 4. Regressione visiva (web-visual)

- **Riferimenti:** 10 viste × 390/1440 in `apps/web/test/visual/baseline/`, con orologio fisso, casualità con seme e senza
  aggiornamenti periodici.
- **Soglia:** 0,1% dei pixel (pixelmatch, soglia per pixel 0,1). Differenza misurata: 0,000%.
- **Aggiornamento:** solo con `pnpm --filter @fondaco/web test:visual:update`.
- **Autotest (V0):** cambiare il colore del pulsante principale fa superare la soglia.

## 5. Prestazioni (web-perf)

| Misura | Soglia | Valore |
|---|---|---|
| Bundle iniziale (JS + CSS da `index.html`, gzip) | **≤ 60 kB** (proposta) | **49,2 kB**: boot.js 1,1 + index.js 36,9 + CSS 11,2; HTML 6,6 kB |
| Caricati su richiesta | — | wallet-rt 84,4 kB, ccip 1,3 kB |
| Font (5 sottoinsiemi latini) | ≤ 130 kB | 118 kB (erano 250 kB) |
| Libro visibile su Fast 3G (DevTools: 562,5 ms RTT, 1,44 Mbit/s) | ≤ 2000 ms | **1807 ms** (mediana di 1784, 1807, 1813) |
| Lighthouse mobile, Performance | ≥ 0,90 | **0,96** (mediana di 0,98 / 0,96 / 0,96) |
| Lighthouse mobile, Accessibility | ≥ 0,90 | **1,00** |
| FCP / LCP / TBT / CLS / Speed Index | — | 1,7 s / 2,5 s / 4 ms / 0,013 / 1,7 s |

Prima della fase la misura era molto diversa: Performance 0,45, CLS 0,877, libro visibile su Fast 3G a 4,85 s.

Cosa è cambiato, in breve:
- **CLS:** la shell resta invisibile sotto lo splash finché non ha il layout definitivo.
- **Un solo round trip per il libro:** `boot.js` parte prima del CSS e chiede `/config` e `GET /books`, il nuovo endpoint
  batch della bacheca, mentre il bundle principale si scarica.
- **Bundle:** il runtime del wallet viene caricato solo all'uso; il client è diviso in moduli puri (`plan`, `guards`) per il
  tree-shaking; c'è una sola copia di viem nel bundle.
- **Font:** sottoinsiemi latini.

**Limite voluto (approvato):** l'LCP di 2,5 s è il marchio dello splash, la cui animazione dura 2,8 s per progetto; non si accorcia lo splash per migliorare il punteggio. Il tempo Fast 3G è misurato con lo
splash già visto nella sessione: alla prima visita il libro è già caricato sotto lo splash.

## 6. Robustezza

- **Console pulita** in tutti gli e2e (web-e2e W16, web-flows F10) e in tutte le viste demo (web-layout L4).
- **web-keys:** niente codice demo (K4) e niente source map (K6) nella build di produzione.

## Difetti trovati, e il test che li copre

| # | Difetto | Correzione | Test |
|---|---|---|---|
| 1 | Rifirma dopo un cambio di fee con nonce nuovi: se la fee tornava al valore precedente, ordini vecchi e nuovi erano validi insieme (doppia esposizione) | rifirma con lo **stesso nonce**; la bacheca sostituisce l'ordine `invalid_fee` con le stesse condizioni (altrimenti `nonce_reused`) | E11b, F3b |
| 2 | La rifirma non alzava l'autorizzazione: con una fee più alta l'offerta finiva "In pausa" invece che attiva | la rifirma autorizza importo + nuova fee prima di firmare | F3b |
| 3 | Client: un'offerta privata veniva scartata in verifica (`SenderAllowanceLow`, la nostra autorizzazione è concessa solo dopo): non era mai eseguibile | `SenderAllowanceLow` ignorato in verifica, `SenderBalanceLow` → `taker_balance` | F6b |
| 4 | Due copie di viem nel bundle (effetto delle dipendenze di test): un rifiuto nel wallet diventava "Errore: …" invece di "Firma rifiutata"; bundle più pesante di 20 kB | `resolve.dedupe: ['viem']`; il client riconosce il rifiuto anche per codice 4001 e per nome dell'errore | F7a, P1 |
| 5 | Layout shift all'avvio (CLS 0,877): la shell veniva dipinta prima del primo render | classe `booting` fino al primo render | P4 (CLS 0,013) |
| 6 | Il libro arrivava dopo 5 richieste in sequenza (4,85 s su Fast 3G); `/config` chiesto due volte | `boot.js` + `GET /books`, una sola `/config`, runtime del wallet pigro, client divisibile | P3, T10–T11 |
| 7 | Richieste anticipate di coppie non in whitelist → 400 in console | endpoint batch `/books`: la coppia sconosciuta è una voce, non un errore HTTP | T10, W16 |
| 8 | Etichetta Demo sopra il contenuto sui telefoni | l'intestazione si allunga per contenerla | L1 |
| 9 | Tag "TU" sopra la quantità nelle righe del libro sotto i 400 px | il tag diventa un punto (il testo resta per i lettori di schermo) | L1 |
| 10 | Focus trap dei fogli bucato: `[href]` contava le `<use>` delle icone, i gruppi di radio contavano come più fermate, il focus iniziale veniva dato con il foglio ancora invisibile (anche nel prototipo) | `a[href]`, una fermata per gruppo, focus dopo l'apertura, rete di sicurezza su `focusin` | A3 |
| 11 | Nomi accessibili diversi dal testo visibile (chip, pulsanti di moneta e mercato, righe del libro): WCAG 2.5.3 | nome dal contenuto + descrizione `.sr-only` | A1 |
| 12 | Contrasto: etichette del grafico 3,33:1, hover del pulsante 4,25:1 | `--muted` per gli assi; hover più scuro | A2 |
| 13 | Messaggio "Questa offerta non è per te" coperto dal toast "Wallet collegato" | il link privato viene gestito dopo la connessione | F6b |
| 14 | Testo "Eseguite 1 parti su 4" (anche nel prototipo) | "Eseguite 1 su 4" | F1c |

## Aggiunte di prodotto, necessarie ai flussi

Sono anche nelle decisioni.
- **Offerta privata:** campo "Solo per un indirizzo" in Proponi, link `#offerta=<hash>`, apertura nel foglio di conferma; una
  sola parte.
- **`txTimeoutSec`:** nuova opzione in `config.json`, il tempo massimo di attesa di una conferma prima di fermarsi (default
  300 s).
- **Book server, `GET /books`:** più libri in una richiesta.


**Aggiornamento (Fase 7, D-59):** il controllo `web-perf` P5 ha soglia LCP 3,0 s e obiettivo documentato 2,5 s.
Misurato nell'immagine Playwright: 2,6 s nelle run CI 6 e 7, 2,67 s nella run manuale 41927262623, 2,53 s in locale.
