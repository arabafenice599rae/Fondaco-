# Changelog

Formato: [Keep a Changelog](https://keepachangelog.com/it/1.1.0/). Le fasi seguono il piano di lavoro.

## [Fase 0] — Verifica delle fondamenta — 2026-10-31

### Aggiunto
- Monorepo pnpm (`packages/contracts`, `packages/book-server`, `packages/client`, `tools/*`); viem fissato a 2.57.13 come nel lockfile di riferimento.
- `tools/verify-source`: clona `airswap-protocols` al commit `28156e5…`, controlla che il tag `v5.0.0` punti lì,
  verifica lo SHA-256 di `SwapERC20.sol`, scarica solady 0.0.173 controllandone l'integrità con lo `yarn.lock` del tag,
  usa solc 0.8.23 con SHA-256 fissato (e confrontato con la lista ufficiale), compila con le impostazioni Hardhat del repository
  e richiede bytecode di creazione e ABI identici al fixture. Si ferma con exit 1 a qualunque differenza (provato con un fixture alterato).
- `tools/testkit`: anvil che forka mainnet a blocco fisso (`FORK_BLOCK`, default 23 700 000; RPC da `MAINNET_RPC_URL`),
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
