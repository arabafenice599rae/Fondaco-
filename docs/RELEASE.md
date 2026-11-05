# Release procedures

**Status (2026-11-05):** section 1, the testnets, is **done**: SwapERC20 `0xf86E2c4789F45A8a7AAA2CA98379716070B80131` on Sepolia
and Base Sepolia, C1–C6 and the test fill green, every hash in REPORT.md ("Testnet"). Sections 2–4 (IPFS, ENS, domain) are
still prepared and not executed. Source verification on Etherscan and Basescan: `node packages/contracts/scripts/verify-etherscan.mjs all --confirm`
with `ETHERSCAN_API_KEY` in `.env` (prepared, not run).

Everything here costs money, is irreversible or publishes something: each step needs explicit approval first.

## 1. Testnets: Sepolia (11155111) and Base Sepolia (84532)

Prepared and rehearsed on **local forks** of both networks (`node packages/contracts/scripts/testnet.mjs rehearse`):
- the real deploy script, the checklist and a test fill ran against forks of the live testnets, and nothing was sent to them;
- result: one fresh deployer gave the same address on both forks, C1–C6 passed on both, and the test fill had exact balances.

Read-only plan with the live gas prices: `node packages/contracts/scripts/testnet.mjs plan` (writes `reports/testnet-plan.json`).

### Preparation checklist (for you, before the go-ahead)

Nothing here is sent by me. Give me only **addresses**: keys stay on your machine.

1. **Deployer key, generated offline.**
   - On a machine without network: `cast wallet new` (Foundry), or a hardware wallet account used for nothing else.
   - Store it encrypted: `cast wallet import fondaco-deployer --interactive` (keystore in `~/.foundry/keystores`).
   - Write the private key only in your local `.env` (git-ignored) when the deploy runs; never in the repository or in a chat.
   - Note the address as `DEPLOYER`.
2. **Nonce 0 on both networks** (read-only, from any machine):
   ```bash
   cast nonce $DEPLOYER --rpc-url https://ethereum-sepolia-rpc.publicnode.com   # must print 0
   cast nonce $DEPLOYER --rpc-url https://sepolia.base.org                       # must print 0
   cast code $(cast compute-address $DEPLOYER --nonce 0 | awk '{print $NF}') --rpc-url https://ethereum-sepolia-rpc.publicnode.com   # 0x
   cast code $(cast compute-address $DEPLOYER --nonce 0 | awk '{print $NF}') --rpc-url https://sepolia.base.org                       # 0x
   ```
   Do not send anything from the deployer before the deploy: one transaction moves the address on that chain.
3. **Test Safe 1/1 on each network** (`OWNER_SEPOLIA`, `OWNER_BASE_SEPOLIA`):
   - app.safe.global → network Sepolia → Create account → one owner (a test EOA, **not** the deployer), threshold 1/1.
   - Then "Add another network" → Base Sepolia, to get the same address on both (optional: C2 accepts different owners).
   - Check that it is a contract: `cast code <safe> --rpc-url …` is not `0x`.
4. **Fee wallet** (`FEE_WALLET`): the same test Safe is fine.
5. **Faucets** (test funds only):
   - Sepolia ETH: Google Cloud Web3 faucet (cloud.google.com/application/web3/faucet/ethereum/sepolia), or another Sepolia faucet;
   - Base Sepolia ETH: Coinbase Developer Platform faucet (portal.cdp.coinbase.com/products/faucet), or the Superchain faucet
     (console.optimism.io/faucet);
   - USDC on both: Circle faucet (faucet.circle.com), network "Ethereum Sepolia" and "Base Sepolia".
6. **Minimum amounts.** "Minimum" covers the stress gas price of the table below (30 gwei on Sepolia, 0.1 gwei on Base
   Sepolia), and "Recommended" leaves a margin:

   | Account | Sepolia minimum | Sepolia recommended | Base Sepolia minimum | Base Sepolia recommended |
   |---|---|---|---|---|
   | DEPLOYER (deploy + transferOwnership, 2.61 M gas) | 0.1 ETH | 0.15 ETH | 0.001 ETH | 0.01 ETH |
   | SIGNER (wrap 0.001003 + approve, 91 k gas) | 0.004 ETH | 0.01 ETH | 0.0015 ETH | 0.003 ETH |
   | TAKER (approve + swap, 219 k gas) | 0.007 ETH + 1 USDC | 0.01 ETH + 2 USDC | 0.0001 ETH + 1 USDC | 0.001 ETH + 2 USDC |

   SIGNER and TAKER are two more test accounts, distinct from the deployer and from the Safe owner.
7. **Send me:** `DEPLOYER`, `OWNER_SEPOLIA`, `OWNER_BASE_SEPOLIA`, `FEE_WALLET`, `SIGNER`, `TAKER`. I then run the read-only
   checks (nonce, code at the deterministic address, balances, Safe code) and report them before asking for the final go.

### What is needed from you
1. **A dedicated deployer key**, new, with nonce 0 on both networks, used for nothing else. Give its address as `DEPLOYER`.
   The key itself stays on your machine, in `.env`, never in the repository.
2. **A test Safe on each network** (the owner), or one per network at the same address: `OWNER_SEPOLIA`,
   `OWNER_BASE_SEPOLIA`.
3. **The fee wallet** (`FEE_WALLET`), for example the same test Safe.
4. **Funds:**
   - test ETH for the deployer on both networks;
   - for the test fill, a SIGNER and a TAKER account with the amounts of the checklist above.

### Exact transactions, per network (same order on both)

| # | From | Nonce | Transaction | Gas (measured on the fork) |
|---|---|---|---|---|
| 0 | deployer | 0 | deploy SwapERC20 v4.3 from the verified fixture, args `(30, 30, FEE_WALLET, 0, 0)` | 2 578 924 |
| 1 | deployer | 1 | `transferOwnership(OWNER)` (solady Ownable: immediate) | 28 521 |
| 2 | SIGNER | — | `WETH.deposit{value: 0.001003 ETH}` | 44 866 |
| 3 | SIGNER | — | `WETH.approve(SwapERC20, 0.001003)` | 46 019 |
| 4 | TAKER | — | `USDC.approve(SwapERC20, 1)` | 55 425 |
| 5 | TAKER | — | `swapAnySender(...)`: the signed order, 0.001 WETH ↔ 1 USDC | 163 785 |

Transactions 0–1 are `deploy.js`; 2–5 are `test-fill.mjs`; read-only checks run before and after. Tokens:
- Sepolia: WETH `0xfFf9…6B14`, USDC `0x1c7D…7238`;
- Base Sepolia: WETH `0x4200…0006`, USDC `0x036C…CF7e`.
All four were checked on-chain (code, `symbol`, `decimals`).

**Estimated cost** with the prices read on 2026-11-04, deploy gas +20% (table from `testnet.mjs plan`):

| Network | Gas price now | Deploy + transfer now | At a stress price | Test fill now |
|---|---|---|---|---|
| Sepolia | 21 wei | ≈ 0,00000000007 ETH | ≈ 0,094 ETH at 30 gwei | negligible |
| Base Sepolia | 0,006 gwei (+ L1 data ≈ 9 200 wei) | ≈ 0,000019 ETH | ≈ 0,00031 ETH at 0,1 gwei | ≈ 0,0000019 ETH |

Recommended funding, for gas price spikes: 0,15 test ETH for the deployer on Sepolia, 0,01 on Base Sepolia.

### Commands (after approval), per network
```bash
RPC_URL=… PRIVATE_KEY=… CONFIRM_CHAIN_ID=11155111 FEE_BPS=30 FEE_WALLET=… OWNER=… node packages/contracts/scripts/deploy.js
RPC_URL=… DEPLOYER=… OWNER=… FEE_WALLET=… FEE_BPS=30 node packages/contracts/scripts/post-deploy-check.mjs     # C1–C6
RPC_URL=… SWAP=… SIGNER_KEY=… TAKER_KEY=… FEE_WALLET=… node packages/contracts/scripts/test-fill.mjs sepolia
```
Then the same with `CONFIRM_CHAIN_ID=84532` and `baseSepolia`. `deploy.js` refuses to broadcast if the RPC's chain differs
from `CONFIRM_CHAIN_ID`, or if the deployer's nonce is not 0 (no contract at the deterministic address). A run interrupted
after transaction 0 resumes with the transfer.

### Post-deploy checklist (`post-deploy-check.mjs`)

| | Check |
|---|---|
| C6 | address = CREATE(deployer, nonce 0), identical on the two networks |
| C1 | runtime code = fixture runtime, simulated on the same chain, with immutables masked |
| C2 | owner = the test Safe, and it is a contract |
| C3 | protocolFee = 30, protocolFeeLight = protocolFee, fee wallet as configured |
| C4 | stakingToken = 0, bonusMax = 0, bonusScale = 0 |
| C5 | DOMAIN_SEPARATOR = EIP712(SWAP_ERC20, 4.3, chainId, address), DOMAIN_CHAIN_ID = chainId, ORDER_TYPEHASH |
| — | test fill: signer −(0,001 + 0,000003 fee) WETH, +1 USDC; taker +0,001 WETH, −1 USDC; fee wallet +0,000003 WETH |

Then record the two addresses in `packages/contracts/src/addresses.ts` and `apps/web/public/config.json`, through a commit
reviewed by you.

## 2. App on IPFS

1. **Build:** the CI builds the app twice in separate jobs (`reproducible-build-a/b`) and compares the tree hash and the CID.
   Locally: `node tools/build-hash.mjs --twice`.
2. **CID** (offline, no upload): `node tools/ipfs.mjs cid <dist>`. For the app at commit `cd11d87` (testnet addresses in
   `config.json`) it is `bafybeiau7cgw5rfowzq723wxjol2mjfgujxlnwpt5z46gr2pfaecrzkqji` (tree hash `c0a051cc…e324`); before, at commit `5b7b87a`, it was
   `bafybeigfhaqqpvoxleq5qn5u7t3cjwafc7tjdqm35vxofjf2rukmo66n7q` (tree hash `c9b62461…f1efe`), the same locally and in both CI
   builds of run 41914373389. Any change to the app (sources, fonts, build config) gives a new CID.
3. **Pin** (publishes, after approval):
   `PINNING_ENDPOINT=… PINNING_TOKEN=… node tools/ipfs.mjs pin <dist> --confirm`.
   - It needs any provider of the IPFS Pinning Service API.
   - The command prints the CID once the provider reports it as pinned. It must equal the CI's CID.
4. **Check a gateway:** `node tools/verify-served.mjs https://<cid>.ipfs.dweb.link/ reports/build-manifest.txt`. Every file must
   be identical.

## 3. ENS contenthash of fondaco.eth (documented, not executed)

1. Encoding (EIP-1577): `node tools/ipfs.mjs contenthash <cid>`. For commit `cd11d87`:
   `0xe3010170122014f88d6ec4aeb661fd6ed74b97a624a6a26eb6d9f3ee79e3474f280828e5504a`; for the older commit `5b7b87a`:
   `0xe30101701220c5382107d5d75921d837b4fcf624d80517e691c19bed6ee2a4ba8d14c77bcdfc`.
2. The **manager** of `fondaco.eth` sets the record (ideally the Safe, with a Safe transaction):
   - in the ENS app: Records → Content hash → `ipfs://<cid>`;
   - or directly: `PublicResolver.setContenthash(namehash("fondaco.eth"), <contenthash>)`.
3. Verify (read-only):
   ```bash
   cast call <resolver> "contenthash(bytes32)(bytes)" $(cast namehash fondaco.eth) --rpc-url $MAINNET_RPC_URL
   node tools/verify-served.mjs https://fondaco.eth.limo/
   ```
   The bytes must equal step 1, and every file must be identical.
4. Every new release means a new CID, a new `setContenthash`, and the same checks again.

## 4. Classic domain

The domain serves the **same build**, for example by copying the CI artefact to the static host. Then
`node tools/verify-served.mjs https://<domain>/`:
- every file of the bundle must be identical;
- `config.json` may differ, since a host may legitimately serve its own configuration, and the tool reports it separately.

Recommended host headers:
- `Cache-Control: no-cache` for `index.html`, `config.json` and `boot.js`;
- immutable caching for `assets/*`;
- the CSP is already in the page.
