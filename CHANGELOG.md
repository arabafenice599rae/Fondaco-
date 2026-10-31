# Changelog

Formato: [Keep a Changelog](https://keepachangelog.com/it/1.1.0/). Le fasi seguono il piano di lavoro.

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
