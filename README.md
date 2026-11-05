<div align="center">

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/assets/fondaco-logo-dark.svg">
  <source media="(prefers-color-scheme: light)" srcset="docs/assets/fondaco-logo-light.svg">
  <img alt="FONDACO" src="docs/assets/fondaco-logo-light.svg" width="440">
</picture>

### The public OTC board for Ethereum.
**You set the price, the contract settles it.**

[![verify](https://github.com/arabafenice599rae/Fondaco-/actions/workflows/verify.yml/badge.svg)](https://github.com/arabafenice599rae/Fondaco-/actions/workflows/verify.yml)
![contract](https://img.shields.io/badge/contract-AirSwap%20SwapERC20%20v4.3-7C93FF)
![fee](https://img.shields.io/badge/fee-0.30%25%20only%20when%20filled-F4AE52)
![testnet](https://img.shields.io/badge/live%20on-Sepolia%20%C2%B7%20Base%20Sepolia-3c873a)
![custody](https://img.shields.io/badge/custody-none-555)

[How it works](#how-it-works) · [Quick start](#quick-start) · [Verification](#verification-and-ci) · [Contract & audit](#contract-and-audit) · [Release](#release) · [Docs](#documentation)

</div>

---

## What it is

FONDACO is a **peer-to-peer, non-custodial** order board for ERC-20 tokens. Nobody holds anybody's funds.

- **Makers post offers for free.** An offer is an EIP-712 signature made off-chain. The maker pays a **0.30%** fee only if
  the offer is filled.
- **Takers fill on-chain.** They pay the price and the gas, and the trade settles wallet to wallet in one transaction.
- **The contract is AirSwap SwapERC20 v4.3, unmodified.** It is the same bytecode AirSwap deployed on Ethereum and Base,
  rebuilt from source and compared byte for byte.
- **The board only lists offers.** It collects and checks offers, but holds nothing and signs nothing. Anyone can run one,
  and the app lets every user pick theirs.

## How it works

```
 browser ──────────────── static app (apps/web: TypeScript + DOM, Vite) ── IPFS / classic hosting, same build
   │  EIP-6963 wallet           │ boot.js: /config + /books in one round trip
   │  (EIP-712 signature, tx)   ▼
   │                      board (packages/book-server)  ── Caddy (TLS) ── hourly S3 backup (SigV4)
   │                        node:sqlite (WAL, migrations), indexing,
   │                        fail-closed, SSE, /trades /candles, Prometheus
   ▼                              │ RPC with fallback
 SwapERC20 v4.3 (AirSwap, unmodified) ◄─────────┘
   owner = Safe, fee 30/30, staking 0, bonus 0
 client (packages/client): plan / verify / execute, protected submission, price and recipient guards, per-wallet MEV status
```

| Principle | In practice |
|---|---|
| **No Solidity of our own in production** | The fixture is rebuilt from the v4.3 tag and matched byte for byte against AirSwap's deployment. |
| **The board is not trusted** | It can hide or delay offers, never change them. The app verifies every offer on-chain before filling it. |
| **The app trusts only its own config** | Contract and tokens come from `config.json`, never from the board. |
| **Reproducible build** | One commit gives one tree hash and one IPFS CID, checked by two separate CI jobs. |

## Quick start

**You need**
- Node 22.23.4 (`.nvmrc`) and pnpm 10 (`corepack enable`);
- Foundry (`anvil`), tested with 1.5.1-stable; set `ANVIL_BIN` for another path;
- a mainnet RPC with **archive state**, read-only and used only for the local fork: `MAINNET_RPC_URL` in `.env`.

```bash
git clone https://github.com/arabafenice599rae/Fondaco-.git && cd Fondaco-
git submodule update --init           # forge-std, for the Foundry tests only
cp .env.example .env                  # MAINNET_RPC_URL (the fork block is in fork.config.json)
pnpm install --frozen-lockfile

pnpm verify-source                    # fixture = v4.3 source rebuilt = code deployed by AirSwap (Ethereum, Base)
pnpm test                             # build, ABI, unit, verify-source, every fork suite
pnpm test:fork e2e engine             # a few suites only
```

**Run a board locally**

```bash
pnpm build
cp packages/book-server/config.example.json packages/book-server/config.json   # contract, RPC, tokens
pnpm --filter @fondaco/book-server start
```

For the web app see [`apps/web/README.md`](apps/web/README.md). To run a board in production (Docker, Caddy, backups) see
[`docs/OPERATIONS.md`](docs/OPERATIONS.md).

## Repository layout

| Path | What's inside |
|---|---|
| [`apps/web`](apps/web) | static web app: Vite, framework-free TypeScript, EIP-6963 wallets |
| [`packages/book-server`](packages/book-server) | the board: Node, `viem`, `node:sqlite` in WAL mode |
| [`packages/client`](packages/client) | taker library: `plan`, `verify`, `execute`, protected submission, guards |
| [`packages/contracts`](packages/contracts) | verified SwapERC20 fixture, deploy and release scripts, Foundry tests |
| [`deploy`](deploy) | board Docker image, compose with Caddy and backups, MinIO for the smoke test |
| [`tools`](tools) | `verify-source`, testkit (anvil forks, suite runner), reproducible build, IPFS, CI helpers |
| [`docs`](docs) | decisions, threat model, operations, release, audits |

## Verification and CI

CI is the self-contained [`verify`](.github/workflows/verify.yml) workflow. The
[`setup-toolchain`](.github/actions/setup-toolchain) composite action installs pinned versions (from
[`tools/ci/toolchain.json`](tools/ci/toolchain.json)) and fails if any of them differs.

| When | What runs |
|---|---|
| **Pull request** | quick profile: slow suites skipped in the unit and fork jobs, Foundry `ci-quick`, public RPC with 3 retries per suite |
| **Nightly**, 02:17 UTC (`cron: "17 2 * * *"`) | everything, full Foundry, archive RPC from the `FORK_RPC_URL` secret |
| **Manual** | Actions → verify → Run workflow, or `gh workflow run verify.yml -f suite=full [-f fork_block=23700000] [-f ref=<branch or commit>]`; `suite`: `quick`, `full`, `contracts`, `book-server`, `client`, `web` |
| **`v*` tag** | everything, then `docker-publish` pushes the board image to GHCR |

<details>
<summary><b>Workflow jobs</b></summary>

| Job | What it does |
|---|---|
| `toolchain` | run plan, warm caches |
| `lint` | build, typecheck, generated files, lint, checksums |
| `unit` | board, client and contracts, including the source check against AirSwap's deployment |
| `fork` | anvil at a fixed block, a fresh fork per suite |
| `foundry` | contract tests and invariants |
| `web-e2e` | Playwright, Lighthouse, axe, layout (with web fonts and with the woff2 blocked), visual regression, user flows; runs in `mcr.microsoft.com/playwright:v1.63.0-noble`, pinned by digest |
| `supply-chain` | `pnpm audit`, frozen lockfile, gitleaks over the whole history, SHA256SUMS |
| `reproducible-build-a/b`, `reproducible-compare` | two separate builds: same tree hash, same IPFS CID |
| `docker` | one build of the board image (OCI archive); compose smoke test on that very image; a check that a push keeps its digest; backups to the SigV4 stub and to MinIO built from its release tag (binary cached) |
| `docker-publish` | only on a `v*` tag push with every job green: pushes the smoke-tested image to GHCR, same digest |

</details>

- **Concurrency:** PR and push runs of the same ref are replaced by the newest commit. Manual and nightly runs never cancel
  each other (D-60).
- **Secrets:**
  - `FORK_RPC_URL`: archive mainnet RPC; without it, a public RPC with retries;
  - `BASE_RPC_URL`: optional, for the comparison with the Base deployment.
- **Run summary:** every job writes its suites, checks, timings, tool versions and build hashes to the run page. The
  `reports-*` artefacts hold Lighthouse, layout, accessibility, visual diffs, screenshots and anvil logs.

**Locally**

```bash
node tools/testkit/run-suites.mjs [--group …] [--profile quick] [--retries N] [suite …]
node tools/testkit/in-playwright.mjs <command>      # any command inside the CI Playwright image
pnpm --filter @fondaco/web test:visual:update       # regenerate the visual baselines, in that same container
```

- **Visual regression** runs only inside the CI Playwright image, so there is one set of baselines for every machine.
  Started anywhere else, `web-visual` re-runs itself in the container (Docker needed).
- **Load test** (about 3 minutes) is outside `pnpm test`: `node tools/load/load-test.mjs`, results in
  [`docs/LOAD.md`](docs/LOAD.md).

## The board

Strict TypeScript, compiled to `packages/book-server/dist`; the only third-party runtime dependency is `viem`.

| Aspect | Behaviour |
|---|---|
| **Configuration** | validated at start; unknown keys and bad values are listed all at once, with their path. Reference: [`docs/CONFIG.md`](docs/CONFIG.md) |
| **Database** | SQLite in WAL mode, versioned migrations applied at start; a database newer than the code is refused |
| **Reorgs** | the last `reorgDepth` blocks are rolled back (default 64); raise it on chains with slower finality. Deeper reorgs are repaired from a backup |
| **Fail-closed** | if indexing fails for `maxStalenessMs` (default 120 s), `/book` and `/books` answer `503 stale` |
| **`GET /books`** | up to 10 pairs in one request, for the app's first screen |
| **Fee changes** | an order re-signed with the same nonce replaces the `invalid_fee` one: at most one fill per nonce |
| **Logs and metrics** | JSON on stdout; Prometheus `GET /metrics` is **off by default** and reachable only from an allow-list or with a token |

## Contract and audit

The deployed contract is AirSwap **SwapERC20 v4.3, unmodified**. The compiler settings are in
[`packages/contracts/compiler-settings.json`](packages/contracts/compiler-settings.json).

| Parameter | Value |
|---|---|
| Source | `airswap-protocols`, tag `v4.3`, commit `6ad0137fa62ab2bd9eead257b77b8f77962d0bf3` |
| File | `source/swap-erc20/contracts/SwapERC20.sol`, SHA-256 `4103d213…3a36` |
| Dependencies | solady 0.0.173 (integrity from the tag's `yarn.lock`) |
| Compiler | solc **0.8.23** (`commit.f704f362`, SHA-256 `28726a45…5732`), optimizer on, **999999** runs |
| **evmVersion** | **`paris`**: the `shanghai` default gives different bytecode (11,930 bytes, with `PUSH0`); a test checks it |
| Result | creation 12,123 bytes (SHA-256 `45dffc57…6109`), runtime 11,264 bytes |

**It is the contract AirSwap deployed** as "V5.0" at `0xD82E10B9A4107939e55fCCa9B53A9ede6CF2fC46`. `verify-source`
compares the rebuilt runtime with `eth_getCode` on Ethereum and Base: identical, metadata included. Sourcify reports an
*exact match* on both chains (D-40).

**Audit:** [PeckShield, report #2024-047 "AirSwap V4.3"](docs/audits/), 23 April 2024 (the PDF's SHA-256 is in
`docs/audits/SHA256SUMS`).

| Finding | Severity | Scope | Status |
|---|---|---|---|
| PVE-001 Repeated `available()` calculation | Low | Staking (not used) | Resolved |
| PVE-002 Revisited staking duration update | Informational | Staking (not used) | Resolved / confirmed |
| PVE-003 Improved order validation in `check()` | Informational | Swap, SwapERC20 | Resolved |

From the post-fix commit (`27b60da`) to the deployed source (`6ad0137`), **only the EIP-712 domain version string changes**:
`"4.2"` → `"4.3"`.

> [!IMPORTANT]
> **Audit caveat.** The switch from OpenZeppelin to solady (#1293, `a145565`) sits between the audited commit (`bcd4c48`)
> and the post-fix commit (`27b60da`), and the report does not say whether that change was reviewed. The full diff is in
> [`docs/audits/`](docs/audits/); the differences with v5.0.0 are in [`docs/AUDIT-DIFF.md`](docs/AUDIT-DIFF.md).

The threat model, with each mitigation linked to the test that covers it, is in [`docs/THREAT_MODEL.md`](docs/THREAT_MODEL.md).

## Release

> [!NOTE]
> **Live on testnet.** SwapERC20 v4.3 runs on **Sepolia** and **Base Sepolia** at
> `0xf86E2c4789F45A8a7AAA2CA98379716070B80131`, owned by a 1/1 test Safe that is also the fee wallet. Post-deploy checks
> C1–C6 and a test fill are green, and the contract is an *exact match* on Sourcify. Every hash and number is in
> [`REPORT.md`](REPORT.md#testnet-sepolia-e-base-sepolia--2026-11-05).

> [!WARNING]
> **No mainnet yet.** There is no mainnet deployment, IPFS publication or ENS record without the maintainer's explicit go-ahead,
> following [`docs/RELEASE.md`](docs/RELEASE.md).

```bash
# dry run: reads only, signs and sends nothing
RPC_URL=… DEPLOYER=0x… FEE_BPS=30 FEE_WALLET=0xSafeFee OWNER=0xSafe pnpm --filter @fondaco/contracts run deploy --dry-run
# real deploy: dedicated key at nonce 0; CONFIRM_CHAIN_ID must match the RPC's chain
RPC_URL=… PRIVATE_KEY=… CONFIRM_CHAIN_ID=11155111 FEE_BPS=30 FEE_WALLET=… OWNER=… pnpm --filter @fondaco/contracts run deploy
```

The script is idempotent:
- with a consistent deployment already in place, it only verifies;
- if a run stopped after the deploy, it completes the ownership transfer;
- in every other case it refuses.

After deploying, `post-deploy-check.mjs` verifies, as checks C1–C6:
- the address is the deployer's nonce-0 address;
- the runtime code matches the fixture;
- the owner is the Safe;
- the fee is 30/30;
- staking and bonus are 0;
- the `DOMAIN_SEPARATOR` is correct.

## Documentation

| Document | Contents |
|---|---|
| [`REPORT.md`](REPORT.md) | final report: architecture, results per phase, deviations, residual risks, testnet hashes *(Italian)* |
| [`CHANGELOG.md`](CHANGELOG.md) | what changed, phase by phase *(Italian)* |
| [`docs/DECISIONS.md`](docs/DECISIONS.md) | decisions taken (D-01 … D-62) and open points *(Italian)* |
| [`docs/THREAT_MODEL.md`](docs/THREAT_MODEL.md) | assets, actors, risks and mitigations, with their tests |
| [`docs/OPERATIONS.md`](docs/OPERATIONS.md) | running a board: configuration, backups, upgrades, reorgs |
| [`docs/RELEASE.md`](docs/RELEASE.md) | testnet, IPFS, ENS, domain: procedures and checklists |
| [`docs/CONFIG.md`](docs/CONFIG.md) | full reference of the board configuration |
| [`docs/AUDIT-DIFF.md`](docs/AUDIT-DIFF.md) | differences between the deployed v4.3 and v5.0.0 |
| [`docs/PHASE6-RESULTS.md`](docs/PHASE6-RESULTS.md) | numbers from the app's advanced tests: performance, accessibility, layout *(Italian)* |

## Project status

- **Phases 0–7 done:** verified contract, board, client, app, advanced tests, security and release tooling.
- **Testnet live:** Sepolia and Base Sepolia, `0xf86E2c4789F45A8a7AAA2CA98379716070B80131`.
- **Pending:**
  - Etherscan and Basescan verification;
  - IPFS publication and the `fondaco.eth` contenthash;
  - the first `v*` release.
- **Next:**
  - EIP-5792, to approve and swap in one confirmation;
  - an optional built-in wallet;
  - the Wrapper for native ETH;
  - legal review before mainnet.
