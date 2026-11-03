# Prova di carico del book server

`node tools/load/load-test.mjs` (risultati grezzi in `reports/load.json`). Misura del 2026-10-31 (seconda esecuzione, dopo la correzione del numero di blocco in cache).

## Condizioni

- Fork di mainnet con anvil al blocco 23 700 000, sulla stessa macchina del server (latenza RPC locale).
- 1 000 firmatari (500 vendono WETH, 500 comprano con USDC), 10 ordini ciascuno = **10 000 ordini**, tutti `open`.
- Server in-process con database su file (WAL); le richieste HTTP arrivano da un **processo separato**
  (`tools/load/bench-http.mjs`, 32 connessioni keep-alive, 10 s per endpoint), così il generatore non condivide l'event loop del server.
- Node 22.23, una sola istanza, nessun proxy davanti.

Limiti della misura: l'RPC è locale (in produzione ogni richiesta costa 50–150 ms in più) e il fork non ha traffico di fondo
sui token. Per la scelta di `logSignerChunk` ho quindi misurato a parte, su **mainnet reale**, il costo della query dei log dei token
(`tools/load/mainnet-logs.mjs`).

## Risultati

| Misura | Valore |
|---|---|
| Ingresso: 10 000 ordini in 200 lotti da 50 (4 in parallelo) | 30 s, **334 ordini/s**, 200 richieste RPC (1 per lotto); lotto p50 590 ms, p95 741 ms, p99 780 ms |
| Verifica completa di 10 000 ordini | **34 richieste RPC**, **0,83–0,91 s** |
| Giro a vuoto (nessun blocco nuovo) | **1 richiesta**, 4 ms |
| Giro incrementale (20 firmatari muovono fondi nello stesso blocco, 200 ordini ricontrollati) | **4 richieste**, 27–37 ms, uguale per ogni `logSignerChunk` sul fork |
| **Tempesta**: 500 firmatari ricevono un Transfer nello stesso blocco (5 000 ordini da rifinanziare, 10 000 nel book) | `logSignerChunk` 1000 (filtrato): **1,03 s, 22 richieste**; 200 (non filtrato): **1,01 s, 21 richieste**; 5 000/5 000 rifinanziati nello stesso giro in entrambi; limite 2 s rispettato |
| Memoria (RSS del processo) | 215 MB all'avvio → 333 MB dopo l'ingresso → 367 MB dopo il carico HTTP; heap 132 MB |
| Database | 14,7 MB per 10 000 ordini (file + WAL) |

API (32 connessioni, 10 s ciascuna):

| Endpoint | Richieste/s | p50 | p95 | p99 |
|---|---|---|---|---|
| `GET /book` limit 50 | 5 058 | 5,3 ms | 11,03 ms | 15,95 ms |
| `GET /book` limit 200, `signed=1` | 785 | 36,13 ms | 62,74 ms | 82,8 ms |
| `GET /book` con `If-None-Match` (4 s; 30 % 304, poi l'ETag è cambiato) | 6 023 | 4,82 ms | 10,17 ms | 13,83 ms |
| `GET /orders?signer` (10 ordini) | 4 609 | 5,93 ms | 11,57 ms | 15,13 ms |
| `GET /orders/:hash` | 12 815 | 2,08 ms | 5,11 ms | 7,68 ms |

La tempesta ha trovato un bug: la verifica con più di 400 chiamate fissa tutti i blocchi della multicall a `getBlockNumber()`, che viem tiene
in cache fino a 4 s; con `logSignerChunk` 1000 il giro rileggeva i 5 000 ordini giusti ma **su uno stato precedente ai Transfer** e li lasciava
`unfunded` fino alla verifica completa successiva. Corretto (`cacheTime: 0`), test di regressione `pinned-read` P1 (fallisce senza la correzione).

Osservazioni:
- La cache del book è indicizzata anche per secchi di 5 s di tempo della chain (buffer di scadenza): l'`ETag` cambia ogni 5 s anche
  senza nuovi ordini, quindi un client che fa polling riceve 304 al massimo per 5 s di fila.
- `/book` con `signed=1` e 200 voci è il punto più costoso (serializzazione di 400 ordini completi): ~7× più lento di `limit=50`.
- L'ingresso è limitato dalla CPU (recupero della firma, ~2 ms per ordine), non dall'RPC.

## Log filtrati e non filtrati (`logSignerChunk`)

Sul fork entrambe le strategie costano 4 richieste per giro e ~27 ms, perché nel blocco ci sono solo i nostri log. Su mainnet reale
(USDC, WETH, USDT; firmatari = 978 indirizzi realmente attivi, quindi il caso peggiore per il filtro):

| Intervallo | Non filtrato | Filtrato su 200 firmatari | Filtrato su 978 firmatari |
|---|---|---|---|
| 1 blocco | richiesta 0,5 KB, risposta **87 KB** (141 log), 77 ms | richiesta 14 KB, risposta 24 KB, 73 ms | richiesta **66 KB**, risposta 46 KB, 118 ms |
| 5 blocchi | risposta 564 KB (919 log), 163 ms | risposta 191 KB, 73 ms | risposta 281 KB, 117 ms |

- La query non filtrata scarica tutto il traffico dei token, ~87 KB per blocco: con un giro ogni 4 s (≈ 1 blocco) sono ~1,9 GB/giorno per
  chain, a prescindere da quanti firmatari ha il book.
- Quella filtrata scarica solo i log dei nostri firmatari; il costo si sposta sulla richiesta (66 byte per firmatario: 66 KB a 1 000).
  I firmatari reali di FONDACO, che di solito non muovono fondi a ogni blocco, avranno risposte molto più piccole di quelle misurate qui.
- Il provider usato (drpc, piano gratuito) accetta 978 indirizzi nella lista dei topic. Altri provider possono avere limiti diversi.

**Default confermato: `logSignerChunk = 1000`** (filtrato fino a 1 000 firmatari, richiesta ≤ 66 KB; oltre, non filtrato). Se il provider
rifiuta il filtro, il giro ricade sulla query non filtrata, lo registra (`warn` + `fondaco_log_filter_fallback_total`) e ritenta il filtro dopo
10 minuti (test `faults` F10). Quando conviene 200: `docs/CONFIG.md`, sezione Note. Il valore non cambia il numero di richieste per giro
(~4) né la correttezza (test differenziale).
