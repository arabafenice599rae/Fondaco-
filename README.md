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
cp .env.example .env        # MAINNET_RPC_URL (il blocco del fork è in fork.config.json)
pnpm install --frozen-lockfile
pnpm verify-source          # Fase 0: bytecode del fixture = sorgente v5.0.0 ricompilato
pnpm test                   # build, ABI, unit, verify-source (positivo e negativo), tutte le suite su fork
pnpm test:fork e2e engine   # solo alcune suite
```

I risultati per suite finiscono in `reports/fork-tests.json`, quelli della verifica in `reports/verify-source.json`.

## Riproducibilità del bytecode

Il contratto deployato è AirSwap **SwapERC20 v5.0.0, non modificato**. Le impostazioni ufficiali di compilazione sono
registrate in [`packages/contracts/compiler-settings.json`](packages/contracts/compiler-settings.json) e usate da
`tools/verify-source`, dallo script di deploy e dalla libreria (`COMPILER_SETTINGS`, `EVM_VERSION`):

| Parametro | Valore |
|---|---|
| Sorgente | `airswap-protocols`, tag `v5.0.0`, commit `28156e5115218a444d35f35162162f643e5ccb91` |
| File | `source/swap-erc20/contracts/SwapERC20.sol`, SHA-256 `5203e5a0…4e64` |
| Dipendenze | solady 0.0.173 (integrità dallo `yarn.lock` del tag) |
| Compilatore | solc **0.8.23** (`commit.f704f362`, SHA-256 `28726a45…5732`) |
| Ottimizzatore | attivo, **999999** run |
| **evmVersion** | **`paris`** |
| Nomi delle unità | come Hardhat (`contracts/SwapERC20.sol`, `solady/src/…`): entrano nell'hash dei metadati |
| Risultato | bytecode di creazione di 12 221 byte, SHA-256 `139ab5cb…3d77` |

`evmVersion: paris` è obbligatorio: è il default di Hardhat per solc 0.8.23 nel repository AirSwap al tag (che non lo imposta),
mentre il default di solc è `shanghai` e produce un bytecode diverso (12 024 byte, con `PUSH0`). La regola è fissata da un test:
`pnpm test:verify-source` controlla che con `paris` il bytecode coincida e che con `shanghai` la verifica **fallisca**.
Effetto pratico: senza `PUSH0`, lo stesso bytecode si può deployare anche su chain che non hanno Shanghai.

Lo script di deploy rifiuta un fixture il cui SHA-256 non coincide con quello registrato.

## Deploy (solo dopo conferma esplicita)

```bash
# prova a vuoto: legge soltanto, non firma e non invia nulla (basta l'indirizzo del deployer)
RPC_URL=… DEPLOYER=0x… FEE_BPS=30 FEE_WALLET=0xSafeFee OWNER=0xSafe pnpm --filter @fondaco/contracts run deploy --dry-run
# deploy vero: chiave dedicata al nonce 0, CONFIRM_CHAIN_ID deve coincidere con la chain dell'RPC
RPC_URL=… PRIVATE_KEY=… CONFIRM_CHAIN_ID=11155111 FEE_BPS=30 FEE_WALLET=… OWNER=… pnpm --filter @fondaco/contracts run deploy
```

Lo script è idempotente: con un deploy già fatto e coerente non invia nulla e verifica soltanto; se una esecuzione si è
interrotta dopo il deploy completa il passaggio di ownership; in ogni altro caso si rifiuta. Il Wrapper non viene mai deployato (escluso dalla v1).
Controlli dopo il deploy: owner = Safe, `protocolFee` = `protocolFeeLight` = 30, `protocolFeeWallet`, `stakingToken` = 0,
`bonusMax` = `bonusScale` = 0, `DOMAIN_SEPARATOR` atteso per chain e indirizzo, `ORDER_TYPEHASH`.
