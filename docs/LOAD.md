# Prova di carico del book server

`node tools/load/load-test.mjs` (risultati grezzi in `reports/load.json`). Misura del 2026-10-31.

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
| Ingresso: 10 000 ordini in 200 lotti da 50 (4 in parallelo) | 30 s, **335 ordini/s**, 200 richieste RPC (1 per lotto); lotto p50 588 ms, p95 699 ms, p99 793 ms |
| Verifica completa di 10 000 ordini | **33–34 richieste RPC**, **0,72–0,80 s** |
| Giro a vuoto (nessun blocco nuovo) | **1 richiesta**, 4 ms |
| Giro incrementale (20 firmatari muovono fondi nello stesso blocco, 200 ordini ricontrollati) | **4 richieste**, 25–30 ms, uguale per ogni `logSignerChunk` sul fork |
| Memoria (RSS del processo) | 210 MB all'avvio → 323 MB dopo l'ingresso; heap 103 MB |
| Database | 14,7 MB per 10 000 ordini (file + WAL) |

API (32 connessioni, 10 s ciascuna):

| Endpoint | Richieste/s | p50 | p95 | p99 |
|---|---|---|---|---|
| `GET /book` limit 50 | 5 538 | 5,0 ms | 9,4 ms | 13,0 ms |
| `GET /book` limit 200, `signed=1` | 763 | 38,6 ms | 59,8 ms | 87,8 ms |
| `GET /book` con `If-None-Match` (83 % 304) | 11 110 | 2,3 ms | 5,9 ms | 9,1 ms |
| `GET /orders?signer` (10 ordini) | 4 940 | 5,6 ms | 11,5 ms | 14,5 ms |
| `GET /orders/:hash` | 12 594 | 2,2 ms | 4,8 ms | 6,9 ms |

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

**Proposta di default:** `logSignerChunk = 1000` (filtrato fino a 1 000 firmatari, richiesta ≤ 66 KB; oltre, non filtrato).
È un cambio di default rispetto al riferimento (200) e va confermato. Con un provider che limita la lista dei topic, tenere 200.
Il valore non cambia il numero di richieste per giro (sempre ~4) né la correttezza (coperta dal test differenziale).
