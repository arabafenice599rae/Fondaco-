# @fondaco/client

Lato utente di FONDACO: esecuzione delle offerte (taker), protezione MEV (protect) e stato della protezione del wallet
(wallet-protection). ESM con dichiarazioni TypeScript; **unica dipendenza: `viem`**. Funziona in browser e in Node.

```ts
import { plan, createTaker, createSubmitter, cancelOrders, priceCheck, isStale, discoverWallets, protectionStatus, createRpcConfirmations } from '@fondaco/client'
// oppure per entry point: '@fondaco/client/taker', '@fondaco/client/protect', '@fondaco/client/wallet-protection'
```

## Taker: plan → verify → execute

| Funzione | Restituisce | Note |
|---|---|---|
| `plan(entries, pay)` | `IndicativeQuote` (`kind: 'indicative'`) | ordini interi dal migliore finché entrano in `pay`; nessuna lettura on-chain |
| `createTaker({ publicClient, walletClient, swap, submitter?, onUpdate?, timeoutMs?, privateTimeoutMs?, confirmations? })` | `Taker` | il destinatario è sempre `walletClient.account`, non è un parametro |
| `taker.verify(quote)` | `VerifiedQuote` (`kind: 'verified'`) | una multicall al blocco corrente (mai un numero di blocco in cache): `check()` per ogni ordine + saldo/allowance; `dropped` con il motivo |
| `taker.execute(verified, { approval: 'exact' \| 'max' })` | `ExecuteResult` | approve (reset a 0 per USDT), poi per ogni ordine: simulazione, **guardia sul destinatario**, invio, tracciamento |

`Quote = IndicativeQuote | VerifiedQuote`. `ExecuteResult`: `filled`, `skipped` (senza gas), `failed` (`costsGas`), `stopped`
(perché l'esecuzione si è fermata, `null` se ha provato tutto), `paid`, `received`, `gasCostWei`, `protection` (`private` | `wallet`), `downgraded?`.

**Guardia sul destinatario.** Prima dell'invio, i dati che il wallet codificherà dalla richiesta (con la sua `abi`, funzione e argomenti) devono
essere identici a `swapAnySender`/`swap(destinatario = wallet connesso, quell'ordine)` sul contratto configurato. Altrimenti nulla viene inviato:
evento `blocked`, `stopped: 'recipient_guard'`.

**Eventi `onUpdate`** — unione discriminata `TakerEvent` su `type`:
`verified` · `protection` · `approval_reset` · `approving` · `simulating` · `awaiting_signature` · `pending` · `sped_up` · `filled` · `skipped` ·
`failed` · `cancelled` · `replaced` · `timeout` · `rejected` · `blocked` · `private_unavailable` · `protection_downgraded` · `done`.
Testi italiani dei motivi in `REASONS`.

## Protect

| Funzione | Note |
|---|---|
| `createSubmitter({ publicClient, walletClient, chainId, privateTransport?, onUnavailable? })` | account locale + RPC protetto → `mode: 'private'` (MEV Blocker `/noreverts`, Flashbots `/fast` su mainnet; nonce su `latest`); wallet del browser → `mode: 'wallet'`; L2 → `why: 'sequencer'` |
| `cancelOrders({ publicClient, walletClient, submitter, swap, nonces })` | `cancelled` · `partly_taken` (con i nonce già eseguiti) · `rejected` · `timeout` · `reverted` · `private_unavailable` |
| `priceCheck({ side, price, mid })` | `ok` · `warn` (≥ 2,00 % più conveniente del mercato per chi accetta) · `danger` (≥ 10,00 %); soglie **incluse** |
| `isStale({ side, price, mid })` | superata dal mercato di ≥ 1,00 % |
| `EXPIRY` | default 1 h, avviso oltre 24 h |

**Endpoint protetti tutti irraggiungibili.** Default (`onUnavailable: 'stop'`): **nessuna transazione inviata**, l'esecuzione si ferma con
`private_unavailable` (evento con l'errore). Con `onUnavailable: 'wallet'` (scelta esplicita del chiamante) la transazione passa dal wallet, cioè
dalla mempool pubblica su mainnet, e il passaggio è dichiarato: evento `protection_downgraded`, `result.protection = 'wallet'`, `result.downgraded = true`.
Mai un invio silenzioso in mempool pubblica. Un errore JSON-RPC dell'endpoint protetto è una risposta, non un'indisponibilità: viene propagato.

## Wallet protection (solo informativo)

| Funzione | Note |
|---|---|
| `discoverWallets({ target?, timeoutMs? })` | EIP-6963, deduplicati per `uuid`, annunci malformati ignorati |
| `protectionStatus({ rdns, chainId, userSetRpc })` | `l2` (Base, OP, Arbitrum) · `wallet` (MetaMask, Flask su mainnet) · `guide` (altri wallet su mainnet) · `user_rpc` · `none` |
| `createRpcConfirmations(storage?)` | ricorda "Ho impostato l'RPC protetto" per wallet (**rdns**, stabile; non l'`uuid`, che cambia a ogni sessione) e per chain, in `localStorage['fondaco-rpcset']`; senza storage o con storage che lancia errori funziona in memoria |
