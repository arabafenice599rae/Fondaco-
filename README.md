# FONDACO

Exchange **P2P non-custodial multi-moneta** su AirSwap **SwapERC20 v5.0.0** (contratto invariato).
Chi propone firma gratis e paga lo 0,30% solo se l'offerta viene eseguita; chi accetta paga prezzo e gas.

## Struttura (monorepo pnpm)

| Percorso | Contenuto |
|---|---|
| `packages/contracts` | fixture SwapERC20 (bytecode verificato), script di deploy, test fee e deploy |
| `packages/book-server` | book server (Node, viem, `node:sqlite` WAL) |
| `packages/client` | `taker`, `protect`, `wallet-protection` |
| `apps/web` | app (fase 5) |
| `tools/verify-source` | ricompila SwapERC20 dal tag e confronta il bytecode |
| `tools/testkit` | fork di mainnet con anvil a blocco fisso, wallet casuali, saldi di test, runner delle suite |
| `docs/reference` | materiale di partenza: prototipo `mini-exchange.html`, README originale |
| `docs/DECISIONS.md` | decisioni prese e punti aperti |

## Requisiti

- Node ≥ 22.13, pnpm 10 (`corepack enable`)
- Foundry (`anvil`) — testato con 1.5.1-stable; `ANVIL_BIN` per un percorso diverso
- git, tar
- un RPC mainnet **con stato archivio** solo per il fork locale (sola lettura): `MAINNET_RPC_URL` in `.env`

```bash
cp .env.example .env        # MAINNET_RPC_URL, FORK_BLOCK
pnpm install --frozen-lockfile
pnpm verify-source          # Fase 0: bytecode del fixture = sorgente v5.0.0 ricompilato
pnpm test                   # unit + tutte le suite su fork (un anvil nuovo per suite)
pnpm test:fork e2e engine   # solo alcune suite
```

I risultati per suite finiscono in `reports/fork-tests.json`, quelli della verifica in `reports/verify-source.json`.
