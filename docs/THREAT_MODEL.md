# FONDACO — threat model

Scope: the SwapERC20 v4.3 contract (AirSwap, unmodified), the book server, the client library, the web app, the deploy and
operations tooling. Every mitigation points to the test that covers it: suite names from `tools/testkit/run-suites.mjs`,
check IDs from their output.

## Assets

| Asset | Where | Why it matters |
|---|---|---|
| **A1 Users' funds** | users' wallets; the contract never holds any (invariant 2) | a fill moves tokens directly between the two wallets, using the allowance to SwapERC20 |
| **A2 Signatures (signed orders)** | the book, any copy of an order | a valid signature is a standing authorization to trade at that price until expiry or on-chain cancel |
| **A3 Allowances** to SwapERC20 | on-chain | the maximum a fill can take from a maker or taker |
| **A4 Safe keys** (contract owner, fee wallet) | the Safe's signers | the owner sets protocolFee, protocolFeeLight, fee wallet, staking, bonus; it cannot move users' funds |
| **A5 Deploy key** | the deployer's machine, used for 2 transactions per chain | until `transferOwnership` it is the owner; after that it has no power (C2) |
| **A6 Book integrity** | book server + SQLite | users rely on it to see offers that are live and correctly priced |
| **A7 The app build** | static host, IPFS | it builds and signs the orders: a tampered build could sign for an attacker |

## Actors

| Actor | Can | Cannot |
|---|---|---|
| **User** (maker or taker) | sign orders, cancel, fill | fill another user's private order (F6b) |
| **MEV bot** | watch the mempool, copy or front-run fills and cancels, take stale offers | fill an order on different terms (signature); take a private order |
| **Book operator** | hide, delay or reorder offers; go down; serve stale data | change an order's terms or the contract it is signed for; move funds |
| **RPC provider** | lie about state, censor, go down | sign or move funds |
| **Wallet** | choose how to broadcast (public mempool or protected RPC); show or hide what is signed | — |
| **Hosting / gateway** | serve a different build, or stop serving it | change what a correctly verified build signs |
| **Contract owner (Safe)** | change fees, fee wallet, staking, bonus | move funds held by users; change signed orders |

## Risks and mitigations

| # | Risk | Mitigation | Covered by |
|---|---|---|---|
| R1 | A tampered or unexpected contract | The fixture is rebuilt from the tagged source (v4.3, SHA-256 pinned, solc and solady pinned). Its runtime equals the AirSwap deployment on Ethereum and Base, metadata included. The deploy script refuses a fixture with another hash. The app trusts only its own configured address, and the book cannot change it. | verify-source V1–V4; deploy; web-model U23; e2e W3b |
| R2 | Order replayed on another chain | `DOMAIN_CHAIN_ID` plus `ChainIdChanged` on `swap`/`swapAnySender`; the EIP-712 domain carries chainId and contract | foundry `ChainId.t.sol`; addresses A4 |
| R3 | A fee change breaks or exposes offers | Offers with the old fee are `invalid_fee`, out of the book and refused on-chain. The re-sign keeps the nonce, so at most one of the two can fill. If the higher fee needs more allowance, the app authorizes it first. | e2e E11, E11b; web-flows F3; foundry `FeeChange.t.sol` |
| R4 | A signer revokes funds or allowance after posting | Funds are allocated oldest-first; the order is `unfunded` and hidden, then `open` again when the funds come back | e2e E7, E10; web-flows F2 |
| R5 | A cancelled offer stays fillable | On-chain `cancel(nonces)`, protected when possible; the book marks the nonces used; the remaining parts of a ladder are cancelled together | web-flows F1d; foundry Nonces; signers S5 |
| R6 | A dead offer (`invalid_signer`) that is still valid on-chain after `revoke` | `executableOnChain` in the API; "Ancora eseguibile → Annulla ora" in the app | web-flows F4; signers; web-model U12 |
| R7 | A taker fills a stale or taken order and pays gas for nothing | `verify()` is one batched read at a block. Each leg is simulated just before sending. A race shows as "parziale" with the real cost. | taker; taker-advanced; web-flows F5 |
| R8 | The taker is paid at the wrong address | The recipient is always the connected account, and a guard decodes the transaction before the wallet sees it | client-guards; taker T* (recipient guard) |
| R9 | MEV front-running of fills or cancels | Private submission (revert-protected RPCs) for local accounts. For browser wallets: wallet mode, the real MEV status shown, and the guide to enable protection. | protect; wallet; web-e2e W3b; web-flows F8 |
| R10 | Price typos / bot bait | Price guard warns from 2% and asks for an explicit acknowledgement from 10%; expiry 1 h by default, with a warning at 7 days | client-guards G1–G3; web-model |
| R11 | The book serves unverified data during an RPC outage | Fail-closed after `maxStalenessMs`: `503 stale`, and the app blocks trading ("Dati non aggiornati") | faults; pinned-read; web-e2e W15 |
| R12 | Chain reorg | Rollback of the last `reorgDepth` blocks (fills, statuses) | reorg R1–R5 |
| R13 | Abuse of the book (spam, oversized batches, slowloris) | Rate limit per client (`trustProxy` aware), batch and live-order caps, SSE limits, body size and timeouts | http-security; metrics |
| R14 | Private-offer leak | The book never lists private orders and withholds their signature in `/orders?signer`; the link opens only for the counterparty; `swap()` enforces the sender | e2e E14; web-flows F6 |
| R15 | Keys or secrets in the repo or in the build | `.env` git-ignored; gitleaks on the whole history in CI; key-pattern scan of production and demo builds; no source maps; no RPC with a key in `config.json` | supply-chain (gitleaks); web-keys K1–K6 |
| R16 | Supply chain (dependencies, tools) | Frozen lockfile; `pnpm audit` (zero high/critical) in CI; exact versions; actions pinned by commit SHA; Foundry, solc, kubo and gitleaks pinned with checksums; base images pinned by digest; SHA256SUMS for the fixture, the audit report and the fonts | supply-chain; checksums; toolchain version check |
| R17 | A tampered app build (host or gateway) | Reproducible build: the same tree hash and the same IPFS CID from two independent CI jobs; `verify-served.mjs` compares any host or gateway with the manifest; ENS contenthash only after that check | reproducible-build; reproducible-compare |
| R18 | Phishing through signatures | Terms shown in clear before signing; exact approvals by default, never unlimited unless chosen | web-e2e W2; web-flows |
| R19 | Deploy mistakes (wrong chain, wrong owner, address drift) | `CONFIRM_CHAIN_ID` required to broadcast; nonce-0 address identical on every chain; post-deploy checklist C1–C6; idempotent resume | deploy D1–D8; testnet rehearsal |
| R20 | Lost book database | Hourly consistent backups (integrity-checked, retention); restore procedure; the chain is the source of truth for everything except unpublished offers | backup B1–B3; docker-smoke S3–S4 |

## Residual risks (accepted, explicit)

1. **Browser wallets without MEV protection.** A wallet that broadcasts to the public mempool exposes fills and cancels to
   copy or front-running. The app cannot redirect a browser wallet's transactions. It shows the real status ("Mempool
   pubblica") and a guide to enable a protected RPC in the wallet (R9). On L2s with a sequencer it does not apply.
2. **Offers overtaken by the market.** A signed price stays valid until expiry. If the market moves past it, takers and
   bots get it below market. Mitigations: short default expiry, the stale flag "Il mercato si è spostato" (≥ 1%), protected
   cancel. The maker must act.
3. **Trust in the book operator.** A book can hide, delay or reorder offers, or favour some makers, and its operator sees
   offers before others. It cannot change terms or move funds, and every offer is verified on-chain before execution. Users
   can switch book at any time.
4. **`swapLight` does not check the chain (v4.3).** With a fixed domain separator, a `swapLight` order signed on one chain
   would stay executable after a chain split. FONDACO never signs or executes `swapLight` orders (senderWallet = 0,
   `swapAnySender`). Pinned by `test_swapLightIgnoresChainId`; not among the audit findings (D-43).
5. **Reorg deeper than `reorgDepth`** (64 blocks by default). It is not corrected automatically; the documented procedure is a
   restore from a backup older than the fork point (OPERATIONS.md §6). Test `reorg` R4 documents the behaviour.
6. **OpenZeppelin → solady outside the audit.** The switch (#1293) lies between the commit PeckShield reviewed (`bcd4c48`)
   and the post-fix commit (`27b60da`). The report names `27b60da` as final but does not say whether that change was
   reviewed. The deployed source differs from `27b60da` only by the domain version string (D-41).
7. **RPC provider honesty.** The book and the app read state through RPCs. A lying RPC could show wrong balances or hide a
   fill. Execution is still enforced by the contract. Users can set their own RPC in Impostazioni.
8. **Owner powers.** The Safe can change fees (up to 99.99% by contract), the fee wallet and staking. Offers signed with the old
   fee simply stop being valid (R3); no signed order can be filled at a fee it did not sign. Governance changes are shown
   in the app.
