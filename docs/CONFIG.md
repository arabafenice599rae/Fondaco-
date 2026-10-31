# Configurazione del book server

Generato da `packages/book-server/src/config.ts` (`pnpm --filter @fondaco/book-server docs:config`). Non modificare a mano.

Le chiavi sconosciute sono un errore all'avvio. Tutti gli errori vengono elencati insieme, con il percorso.

## Radice

| Chiave | Tipo | Default | Descrizione |
|---|---|---|---|
| `port` | integer ≥ 0 ≤ 65535 | `8080` | HTTP port (0 = any free port). |
| `host` | string | `"127.0.0.1"` | Listen address. |
| `db` | string | `"book.sqlite"` | SQLite file (":memory:" for tests). WAL mode. |
| `corsOrigin` | string | `"*"` | Access-Control-Allow-Origin. |
| `trustProxy` | integer ≥ 0 ≤ 10 | `0` | Number of reverse proxies in front; X-Forwarded-For is used only when > 0 (N-th address from the right). |
| `maxConcurrentSubmits` | integer ≥ 1 | `8` | Parallel POST /orders being processed; beyond: 503 busy. |
| `ssePerClient` | integer ≥ 1 | `4` | Max /stream connections per client key. |
| `rateLimit` | object | (vedi sotto) | Token bucket per client (IPv4 address, IPv6 /64, plus a /48 bucket). |
| `log` | object | (vedi sotto) | Structured JSON logs on stdout, one object per line. |
| `metrics` | object | (vedi sotto) | Prometheus metrics endpoint: off by default; when on, only from `allow` or with `token`. |
| `chains` | map a chain id (positive integer) → object | **obbligatoria** | Chains served: chain id → chain settings. |

## `rateLimit`

| Chiave | Tipo | Default | Descrizione |
|---|---|---|---|
| `capacity` | number ≥ 1 | `60` | Bucket size (burst) per client key; IPv6 /48 gets 16×. |
| `refillPerSec` | number ≥ 0 | `2` | Tokens refilled per second. |

## `log`

| Chiave | Tipo | Default | Descrizione |
|---|---|---|---|
| `level` | "debug" | "info" | "warn" | "error" | "silent" | `"info"` | Minimum level written. |

## `metrics`

| Chiave | Tipo | Default | Descrizione |
|---|---|---|---|
| `enabled` | boolean | `false` | Serve GET /metrics (Prometheus text format). |
| `token` | a token of at least 16 characters | — | Bearer token accepted on /metrics (Authorization: Bearer …), from any address. |
| `allow` | list of a CIDR block (e.g. 10.0.0.0/8, ::1/128) | `["127.0.0.1/32","::1/128"]` | Source networks allowed on /metrics without a token (direct peer address, never X-Forwarded-For). |

## `chains.<chainId>`

| Chiave | Tipo | Default | Descrizione |
|---|---|---|---|
| `rpc` | an http(s) URL or list of an http(s) URL | **obbligatoria** | One RPC URL or a list (automatic failover to the next one). |
| `rpcTimeoutMs` | integer ≥ 100 | `15000` | Timeout of one RPC request. |
| `swap` | address | **obbligatoria** | SwapERC20 v5.0.0 address on this chain. |
| `multicall` | address | `"0xcA11bde05977b3631167028862bE2a173976CA11"` | Multicall3 address (same on every major EVM chain). |
| `startBlock` | integer (decimal string allowed) | `"0"` | First block to index (deployment block of the contract). 0 = start from the current head. |
| `pollMs` | integer ≥ 100 | `4000` | Interval between two indexing rounds. |
| `logChunk` | integer ≥ 1 | `2000` | Max blocks per eth_getLogs of the swap contract. |
| `reorgDepth` | integer ≥ 1 | `64` | Blocks rolled back and re-read after a reorg (64 ≈ finality on Ethereum). |
| `signalMaxBlocks` | integer ≥ 1 | `50` | A gap longer than this many blocks triggers a full sweep instead of token logs. |
| `logSignerChunk` | integer ≥ 1 | `200` | Up to this many live signers, token logs are filtered by the node; above, read unfiltered and filtered here. |
| `fullSweepMs` | integer ≥ 1000 | `60000` | Interval between full verifications of every live order. |
| `expiryBufferSec` | integer ≥ 0 | `30` | Orders expiring within this many seconds are not offered in /book. |
| `minExpirySec` | integer ≥ 0 | `60` | Minimum remaining validity at submission (expiry_too_short). |
| `maxExpirySec` | integer ≥ 1 | `604800` | Maximum validity at submission (expiry_too_long). |
| `maxOpenPerSigner` | integer ≥ 1 | `200` | Max live orders per signer and token (too_many_orders). |
| `maxLiveOrders` | integer ≥ 1 | `100000` | Max live orders on this chain (book_full). |
| `maxStalenessMs` | integer ≥ 1000 | `120000` | Fail-closed: if no indexing round has succeeded for this long, GET /book answers 503 stale instead of serving unverified offers. |
| `tokens` | map address → object | **obbligatoria** | Token whitelist: address → { symbol, decimals, min? }. |

## `chains.<chainId>.tokens.<address>`

| Chiave | Tipo | Default | Descrizione |
|---|---|---|---|
| `symbol` | string | **obbligatoria** | Display symbol. |
| `decimals` | integer ≥ 0 ≤ 36 | **obbligatoria** | Token decimals. |
| `min` | integer (decimal string allowed) | — | Minimum order size in base units, for both sides (amount_too_small). |

