# FONDACO — report finale (fasi 0–7)

Exchange P2P non-custodial multi-moneta su AirSwap **SwapERC20 v4.3**, il contratto deployato da AirSwap come "V5.0", non
modificato. Chi propone firma gratis e paga lo 0,30% solo se l'offerta viene eseguita; chi accetta paga prezzo e gas.
Branch di lavoro: `claude/fondaco-p2p-build-test-2glj2b`. Dettagli: `CHANGELOG.md`, `docs/DECISIONS.md` (D-01…D-51),
`docs/PHASE6-RESULTS.md`, `docs/THREAT_MODEL.md`, `docs/OPERATIONS.md`, `docs/AUDIT-DIFF.md`.

## Architettura

```
 browser ──────────────── app statica (apps/web: TypeScript + DOM, Vite) ── IPFS / hosting classico, stesso build
   │  EIP-6963 wallet           │ boot.js: /config + /books in un round trip
   │  (firma EIP-712, tx)       ▼
   │                      book server (packages/book-server)  ── Caddy (TLS) ── backup orario S3 (SigV4)
   │                        node:sqlite (WAL, migrazioni), indicizzazione,
   │                        fail-closed, SSE, /trades /candles, Prometheus
   ▼                              │ RPC con riserva
 SwapERC20 v4.3 (AirSwap, invariato) ◄──────────┘
   owner = Safe, fee 30/30, staking 0, bonus 0
 client (packages/client): plan / verify / execute, invio protetto, guardie di prezzo e destinatario, MEV per wallet
```

- **Nessun Solidity di produzione nostro.** Il fixture è ricompilato dal tag e confrontato con il deploy AirSwap su Ethereum e
  Base (bytecode e metadata identici).
- **La bacheca non custodisce nulla e non firma nulla.** Chiunque può farne girare una, e l'app la sceglie da Impostazioni.
- **L'app si fida solo della propria configurazione** per contratto e monete (D-34) e verifica ogni offerta on-chain prima
  di eseguirla.

## Risultati per fase

| Fase | Contenuto | Numeri |
|---|---|---|
| 0 | Verifica delle fondamenta: sorgente, compilatore, fork a blocco fisso | bytecode identico; `evmVersion paris` obbligatorio (shanghai: bytecode diverso, test negativo) |
| 1 | Libreria contratti, deploy idempotente al nonce 0, Foundry | 65/65 controlli; Foundry 22 (19 + 3 invarianti) |
| 2 | Book server in TypeScript strict, solo `viem` a runtime | e2e 21, engine 13, migrazioni, schema di configurazione, metriche |
| 3 | Test avanzati del book | tempesta di 500 firmatari × 10 000 ordini in ~1,0 s con 21–22 RPC; fault injection, reorg, differenziale, `logSignerChunk` con ricaduta |
| 4 | Client TypeScript | taker 13, protect 5, taker-advanced 12, guardie al confine (2,00% → avviso, 10,00% → pericolo) |
| 5 | App web fedele al prototipo, dati reali | web-model 35, web-keys 5, web-e2e 18 con due bacheche |
| v4.3 | Cambio del contratto di riferimento | runtime = deploy AirSwap su Ethereum e Base; Sourcify exact match; Foundry 29 |
| 6 | Test avanzati dell'app | flussi 21/21; layout: 420 campioni puliti; axe 0 serious/critical; contrasto min 4,59:1; Lighthouse 0,96/1,00; bundle 49 kB; Fast 3G 1,8 s |
| 7 | Sicurezza e rilascio | modello delle minacce; supply chain (0 vulnerabilità, gitleaks pulito); CI con 13 job; immagine Docker e compose con smoke 8/8 (stub S3 e MinIO); IPFS; testnet preparata e provata su fork |

**Regressione locale finale: 39 suite, tutte verdi** (tabella in fondo).

## Deviazioni dalla specifica (tutte approvate)

1. **Contratto:** v4.3 invece di v5.0.0 (D-40). È il sorgente deployato da AirSwap e coperto dall'audit PeckShield; la
   differenza è in `docs/AUDIT-DIFF.md`.
2. **Wrapper per ETH nativo:** escluso dalla v1 (A-01).
3. **App senza framework,** con markup e CSS del prototipo (D-33).
4. **Soglie di prezzo incluse:** "dal 2% in su", "dal 10% in su" e "dall'1% in su" per le offerte superate (D-31).
5. **Aggiunte di prodotto:**
   - offerta privata con link (D-47);
   - `txTimeoutSec` (D-50);
   - `GET /books` e sostituzione della rifirma con lo stesso nonce nella bacheca (D-45, D-48).
6. **Scostamenti grafici per accessibilità e layout** (D-37, D-38, D-51):
   - Demo su telefono e "TU" a punto;
   - etichette del grafico e hover del pulsante;
   - `<h1>` nascosto.
7. **LCP, limite voluto (D-59):**
   - l'elemento LCP è il marchio dello splash, la cui animazione dura 2,8 s per progetto;
   - soglia del controllo 3,0 s, obiettivo 2,5 s;
   - misurato nell'immagine Playwright: **2,6 s** nelle run CI 6 e 7, **2,67 s** con P5 nella run manuale 41927262623,
     **2,53 s** in locale.
8. **MinIO compilato dal tag (D-58, approvata):** non esistono più immagini o binari pubblici (quay.io: `unauthorized`
   anche dal runner; Docker Hub: rimosso; dl.min.io: 410). Il build blocca Go 1.24.7, l'hash del modulo e lo sha256 del
   `go.sum`; il CI tiene il binario in cache per tag e versione di Go.
9. **Preload a priorità bassa (D-57).** Con priorità normale P3 (Fast 3G) passava da 1,8 a 2,4 s; con `fetchpriority="low"`
   è 1,82 s.

## Correzioni della revisione (Fase 7)

| # | Richiesta | Fatto | File | Test |
|---|---|---|---|---|
| 1 | `@font-face` di ripiego tarati su Geist Mono e preload dei woff2; L1 con webfont e con woff2 bloccati | Ripieghi per Menlo, Consolas, DejaVu Sans Mono, Liberation Mono e Courier New, con `size-adjust` e override calcolati sui woff2; preload 400/500/600 | `apps/web/src/fonts.css`, `apps/web/scripts/font-fallback.py`, `apps/web/src/prototype.css`, `apps/web/vite.config.ts` | `web-layout` L1 (webfont) e L1b (woff2 bloccati) verdi su host e immagine; L5 geometria: 0,5 px (host, DejaVu) e 0,4 px (immagine, Liberation) |
| 2 | `web-e2e` nell'immagine Playwright ufficiale bloccata per versione e digest; baseline generate lì; script locale con lo stesso container | `mcr.microsoft.com/playwright:v1.63.0-noble@sha256:eff16c30…4a27`; **una sola serie di 20 baseline**, quelle solo-CI rimosse; `versions.mjs` controlla workflow, immagine e pacchetto | `.github/workflows/verify.yml`, `tools/ci/toolchain.json`, `tools/testkit/in-playwright.mjs`, `apps/web/test/visual.mjs` | `web-visual` V1 20/20, max 0,000%, nell'immagine in locale e in CI |
| 3 | Smoke del backup anche contro MinIO (quay.io, tag e digest) | MinIO costruito dal tag, perché l'immagine pubblica non esiste più (deviazione 8) | `deploy/minio/Dockerfile`, `packages/book-server/test/docker-smoke.mjs` | `docker-smoke` S7–S8 contro MinIO, stesso esito dello stub (S3–S4); 8/8 in locale e in CI |

D-54 nella versione con quattro baseline solo per il CI non era approvata: è stata riscritta e le baseline doppie sono state
rimosse.

## Bug trovati, per fase

| Fase | Bug | Test |
|---|---|---|
| 1 | `invalid_signer` tornava `open` dopo un reorg; un fill o cancel di un ordine `invalid_signer` non veniva mai registrato | signers S4–S6 |
| 3 | Una multicall fallita per intero rendeva `invalid_signer` tutti gli ordini (terminale); `nonceUsed` e `authorized` illeggibili trattati come validi; in ingresso, ordini con stato illeggibile accettati | faults F2–F5 |
| 3 | Numero di blocco in cache nelle letture fissate e nel `verify()` del taker | pinned-read P1, taker T12 |
| 4 | La guardia sul destinatario ricodificava con la propria ABI (una richiesta manomessa passava); endpoint protetti tutti giù → errore generico | client-guards, protect |
| 5 | Importi convertiti con `toFixed(18)`: 0,2 WETH firmati come 0,200000000000000011; primo clic perso dopo un blur | web-model U15–U17, e2e W12 |
| 6 | Rifirma con nonce nuovi (doppia esposizione se la fee tornava) e senza alzare l'autorizzazione | E11b, F3 |
| 6 | Client: offerta privata scartata in verifica; rifiuto nel wallet non riconosciuto con due copie di viem | F6b, F7a |
| 6 | CLS 0,877; libro a 4,85 s su Fast 3G; 400 in console; focus trap bucato; nomi accessibili; contrasti; Demo e "TU" sopra il contenuto | P3–P4, A1–A3, L1 |
| 7 | Nessun difetto del prodotto. Errori miei negli strumenti nuovi, corretti prima del commit: un'esecuzione sincrona bloccava il server di prova nello stesso processo (smoke Docker; Lighthouse in Fase 6); una cache del server di test serviva un `index.html` vecchio | docker-smoke, web-perf |

## Rischi residui

Dettagli in `docs/THREAT_MODEL.md`.

1. **Wallet del browser senza protezione MEV:** l'app mostra lo stato reale e la guida, ma non può reindirizzare le
   transazioni del wallet.
2. **Offerte superate dal mercato:** scadenza breve di default, avviso dall'1%, annullamento protetto.
3. **Fiducia nell'operatore della bacheca:** può nascondere o ritardare offerte, non cambiarle; si può cambiare bacheca.
4. **`swapLight` senza controllo della chain:** non usato da FONDACO (D-43).
5. **Reorg oltre 64 blocchi:** ripristino da backup, come da procedura documentata.
6. **OpenZeppelin → solady fuori dall'audit:** sta tra il commit esaminato e quello post-correzioni (D-41).

## Fase 7 in dettaglio

- **Supply chain:**
  - `pnpm audit`: 0 vulnerabilità a ogni livello;
  - lockfile bloccato (il CI verifica che l'installazione non lo modifichi);
  - gitleaks 8.24.3 sull'intera storia pulito, e un `PRIVATE_KEY` iniettato viene rilevato;
  - SHA256SUMS per fixture, report di audit e font (suite `checksums`);
  - action bloccate per SHA di commit, strumenti con checksum, immagini di base per digest.
- **CI** (`.github/workflows/verify.yml`):
  - **trigger:** `pull_request` rapido, notturno completo, `workflow_dispatch` (`suite`, `fork_block`, `ref`);
  - **job:** `toolchain`, lint, unit, fork, foundry, web-e2e, supply-chain, due build riproducibili, confronto, docker e
    docker-publish (solo al push di un tag `v*`, con `packages: write`; D-56);
  - **riepilogo:** ogni job scrive la sua tabella nel riepilogo della run.
- **Build riproducibile**, app al commit `5b7b87a` (dopo le correzioni della revisione):
  - tree hash `c9b62461e1c7cc0e15c24e8d31c00a541b033782ea84a07c3d34ea0c593f1efe`;
  - CID `bafybeigfhaqqpvoxleq5qn5u7t3cjwafc7tjdqm35vxofjf2rukmo66n7q`;
  - contenthash EIP-1577 `0xe30101701220c5382107d5d75921d837b4fcf624d80517e691c19bed6ee2a4ba8d14c77bcdfc`;
  - identici tra due build locali e nei due job separati del CI (run 41914373389). I valori precedenti (`fdf0d326…`,
    `bafybeihr4of…`) valgono per il build prima dei font di ripiego e del preload, e non vanno più usati.
- **Bacheca:**
  - immagine `node:22.23.4-alpine3.24@sha256:fe4f…9914`, utente `node`;
  - compose con Caddy, backup orario S3 (firma verificata contro l'esempio ufficiale AWS) e rotazione dei log;
  - smoke test autosufficiente 8/8: S1–S6 con lo stub SigV4, S7–S8 backup, list e restore contro MinIO (D-58);
  - guida `docs/OPERATIONS.md`.
- **IPFS:**
  - `tools/ipfs.mjs cid` funziona offline, `pin` richiede `--confirm` e **non è stato eseguito**;
  - `tools/verify-served.mjs` confronta host o gateway con il manifest;
  - procedura per il contenthash di `fondaco.eth` documentata in `docs/RELEASE.md`, **non eseguita**.
- **Testnet (Sepolia e Base Sepolia):**
  - preparati `testnet.mjs` (plan e rehearse), `post-deploy-check.mjs` (C1–C6) e `test-fill.mjs`;
  - prova completa su fork locali delle due testnet: stesso indirizzo, C1–C6 verdi su entrambe, fill di prova con saldi
    esatti; gas misurato: deploy 2.578.924, `transferOwnership` 28.521;
  - **deploy eseguito il 2026-11-05** su Sepolia e Base Sepolia: vedi la sezione "Testnet".

## Testnet (Sepolia e Base Sepolia) — 2026-11-05

Deploy eseguito con chiavi di test usa-e-getta (in `.env` locale, mai nel repository). Prima Sepolia, poi Base Sepolia, solo
dopo C1–C6 e fill di prova verdi. Mainnet esclusa. Nessun tag, nessuna pubblicazione IPFS.

**SwapERC20 v4.3: `0xf86E2c4789F45A8a7AAA2CA98379716070B80131`**, lo stesso indirizzo sulle due reti (CREATE dal deployer al nonce 0).

| | Sepolia (11155111) | Base Sepolia (84532) |
|---|---|---|
| Contratto | [`0xf86E…0131`](https://sepolia.etherscan.io/address/0xf86E2c4789F45A8a7AAA2CA98379716070B80131) | [`0xf86E…0131`](https://sepolia.basescan.org/address/0xf86E2c4789F45A8a7AAA2CA98379716070B80131) |
| Owner e fee wallet: Safe 1/1 1.4.1 | `0xc5ec52f78D049760c41c6223ECC8755B64371F31` | `0xc5ec52f78D049760c41c6223ECC8755B64371F31` |
| Sourcify | [exact match](https://repo.sourcify.dev/11155111/0xf86E2c4789F45A8a7AAA2CA98379716070B80131) (creazione e runtime) | [exact match](https://repo.sourcify.dev/84532/0xf86E2c4789F45A8a7AAA2CA98379716070B80131) (creazione e runtime) |
| Etherscan / Basescan | preparato, non eseguito (serve `ETHERSCAN_API_KEY`) | preparato, non eseguito |

**Account di test:** DEPLOYER `0xf0dA07f530B412d8FBc10AfDFa59b97772328D5d`, FUNDER `0x22b357Eae06aE0E8813eF03ae1F657D1281BD5F9`,
SIGNER `0xEe07C06d7DD66aCf8d66dc9b338CB5307de51840`, TAKER `0x7f6Bfad4C79665F146c190d714Af499caE7929b2`. FUNDER esiste
per lasciare il deployer al nonce 0: riceve i fondi, li distribuisce e crea i Safe.

**Preparazione verificata prima di inviare**
- **Bridge di Base:** `L1StandardBridge` `0xfd0Bf71F60660E2f608ed56e1659C450eB113120`, preso da docs.base.org (Base Sepolia
  non compare più nel Superchain registry attuale) e verificato on-chain da entrambi i lati: `messenger()` =
  `L1CrossDomainMessenger` `0xC34855F4…1f20`, `OTHER_BRIDGE` = `0x4200…0010`, `portal` `0x49f53e41…9e85`, `l2ChainId` =
  84532; su L2 `0x…10.OTHER_BRIDGE()` = `0xfd0B…3120`.
- **Safe:** `SafeProxyFactory` `0x4e1D…ec67`, `SafeL2` `0x29fc…C762` e `CompatibilityFallbackHandler` `0xfd07…Ec99` hanno il
  codehash di `@safe-global/safe-deployments` 1.37.32 su entrambe le reti. Il Safe creato ha owner = DEPLOYER, soglia 1,
  versione 1.4.1, singleton SafeL2 e il fallback handler canonico.

**Transazioni, con `gasUsed` dalle ricevute**

| Transazione | Da | Sepolia | gas | Base Sepolia | gas |
|---|---|---|---|---|---|
| Bridge ETH (L1 deposito → L2 accredito. 303 s) | FUNDER | [`0x4c70089f…`](https://sepolia.etherscan.io/tx/0x4c70089faa3e40662db6f92d29ba469cfd62ebd4683626d6692dce529a266194) | 634.136 | [`0xcb9efcb8…`](https://sepolia.basescan.org/tx/0xcb9efcb86b82157ed22ce8f703872ca74740fb87291927bd7de162b18cc1239f) | 123.940 |
| Safe 1/1 (SafeProxyFactory 1.4.1. owner DEPLOYER) | FUNDER | [`0x8f952694…`](https://sepolia.etherscan.io/tx/0x8f952694dcc6d1b1fac5308995679349882bea3e92277110ae3d9eb3d9cfc40c) | 1.260.365 | [`0x65867bf0…`](https://sepolia.basescan.org/tx/0x65867bf0dc3f2201cbba71af66764f3fb271ec3f962419cd7eb45a345e1cc8df) | 258.859 |
| ETH → DEPLOYER | FUNDER | [`0x18886b18…`](https://sepolia.etherscan.io/tx/0x18886b18cf56930a6886907c577a5e0b2692ce1b78e44c3f2a15dfbc43f975c1) | 204.600 | [`0x665e1374…`](https://sepolia.basescan.org/tx/0x665e13742807955b98a8f0fbd8970399a7a200abda060946c6bf9ea600864c22) | 21.000 |
| ETH → SIGNER | FUNDER | [`0x92f7c391…`](https://sepolia.etherscan.io/tx/0x92f7c391db75a624ea000c75ca842b086d1021a16bff550bd2991c5e3b0c92ee) | 204.600 | [`0x44034b9e…`](https://sepolia.basescan.org/tx/0x44034b9eeb02f4afce746fb49d3bc8620345b85fc5e6df80e8d4662698bf0649) | 21.000 |
| ETH → TAKER | FUNDER | [`0x13e0958f…`](https://sepolia.etherscan.io/tx/0x13e0958f293338f272d331b11017b19ee5251481e672e55a3bdd19d73a6b3292) | 204.600 | [`0xde0ee275…`](https://sepolia.basescan.org/tx/0xde0ee275737170da680f51b2b10dca87a289a9ffe8840cbc1d65088274ae7465) | 21.000 |
| **deploy SwapERC20 v4.3** (nonce 0) | DEPLOYER | [`0x869dbc09…`](https://sepolia.etherscan.io/tx/0x869dbc09308676cf09c92f448d7eb356bd92960720feb89e8ffe83c38277bd85) | 18.068.336 | [`0xdbf94e57…`](https://sepolia.basescan.org/tx/0xdbf94e5788c34abd107dacc39523cde3825254600d463743c4f4bc0b19d3988e) | 2.578.924 |
| **transferOwnership(Safe)** (nonce 1) | DEPLOYER | [`0x97a0e2e5…`](https://sepolia.etherscan.io/tx/0x97a0e2e5a68c35ba4393b0d0590381e48ea12c6da302c0a0f6d077d59e4cc384) | 29.721 | [`0xd47cdefa…`](https://sepolia.basescan.org/tx/0xd47cdefa8c2b6ddd15ce8eb50acb7a38788152e0fd95160aed3ebdf7ad4a039e) | 28.521 |
| WETH.deposit 0.001003 | SIGNER | [`0x12d528e0…`](https://sepolia.etherscan.io/tx/0x12d528e02755f8d96ba896969e9f8b835c7156a26299c72dd0df970f82bf2b69) | 133.058 | [`0xb78aea20…`](https://sepolia.basescan.org/tx/0xb78aea20c4e6dfc6481624f339dab9382ac9463be2067caccec70e1caaaf38cd) | 44.866 |
| WETH.approve(Swap) | SIGNER | [`0x76a05c3f…`](https://sepolia.etherscan.io/tx/0x76a05c3f1127652821e80e16713112312622c312e0215ae99cb3587aee2346d7) | 127.972 | [`0xd45641d5…`](https://sepolia.basescan.org/tx/0xd45641d5adb96172e24132484a7ac0391ca1aeaa7246d9d662ccb9be41512d47) | 46.031 |
| USDC.approve(Swap. 1) | TAKER | [`0xccded7cd…`](https://sepolia.etherscan.io/tx/0xccded7cd6da6ed74dcd404f56adb9bf8247c36721ddec0590fb19aa546aa7029) | 137.757 | [`0x613b6a5f…`](https://sepolia.basescan.org/tx/0x613b6a5f44dab89127ce67a7a04fffe05b42a81fb81d741220eb8313675fe365) | 55.437 |
| **swapAnySender** 0.001 WETH ↔ 1 USDC | TAKER | [`0xf8757cd3…`](https://sepolia.etherscan.io/tx/0xf8757cd3b69107814d37a8bb29386e5b5ceb649d81a97a022ac303d82db5c6f3) | 520.129 | [`0x9eb084b3…`](https://sepolia.basescan.org/tx/0x9eb084b31eb845bc238421ae1f5b4bb83e4558aaa3df56b41d3bfe57dc324d48) | 163.797 |

**Checklist post-deploy (`post-deploy-check.mjs`): verde su entrambe le reti**

| | Controllo | Sepolia | Base Sepolia |
|---|---|---|---|
| C6 | indirizzo = CREATE(deployer, nonce 0), identico | ✅ | ✅ |
| C1 | runtime = fixture (11.264 byte, immutabili mascherate) | ✅ | ✅ |
| C2 | owner = Safe, ed è un contratto | ✅ | ✅ |
| C3 | protocolFee = protocolFeeLight = 30, fee wallet = Safe | ✅ | ✅ |
| C4 | stakingToken 0, bonusMax 0, bonusScale 0 | ✅ | ✅ |
| C5 | DOMAIN_SEPARATOR (`0x2747d32b…` / `0x42e93286…`), DOMAIN_CHAIN_ID, ORDER_TYPEHASH | ✅ | ✅ |

**Fill di prova** (SIGNER vende 0,001 WETH a TAKER per 1 USDC, fee 0,30% pagata dal SIGNER in WETH): saldi esatti su
entrambe le reti.

| | WETH prima | WETH dopo | USDC prima | USDC dopo |
|---|---|---|---|---|
| SIGNER | 0 (+0,001003 dal wrap) | 0 (−0,001003) | 0 | **1** |
| TAKER | 0 | **0,001** | 20 | **19** |
| Safe (fee wallet) | 0 | **0,000003** | 0 | 0 |

**Gas su Sepolia (D-55 corretta).**
- **Base Sepolia** ha esattamente il gas misurato sui fork locali.
- **Sepolia** costa di più solo dove si crea stato nuovo:

  | Cosa | Costo in più su Sepolia |
  |---|---|
  | invio a un account vuoto | 204.600 invece di 21.000 |
  | slot di storage nuovo | circa +82–88 mila |
  | byte di codice depositato | circa +1.340 gas |
  | sovrascrittura di uno slot esistente (`transferOwnership`) | +1.200 |

- **Il fork attivo** (da `eth_config`): attivato il 2026-10-06 13:53:36 UTC, forkId `0x6c1d9423`, con contratti di sistema
  per i builder (`BUILDER_DEPOSIT`, `BUILDER_EXIT`). Il quadro è compatibile con un aumento del costo della creazione di stato
  in quel fork, ma il nome e le EIP non sono esposti da `eth_config` e restano da confermare.
- **Due nodi diversi**, publicnode (Geth 1.17.9) e il gateway Tenderly, riportano lo stesso `gasUsed` del deploy (18.068.336).
- **Costo totale del deploy su Sepolia:** circa 0,00000002 ETH, con il gas a ~0,000001 gwei; soglia di stop 0,85 gwei, mai
  raggiunta.

**Verifica su Etherscan e Basescan, quando `ETHERSCAN_API_KEY` sarà in `.env`:**

```bash
cd packages/contracts
node scripts/verify-etherscan.mjs all                                  # dry run: controlla Sourcify e prepara la richiesta
set -a; . ../../.env; set +a; node scripts/verify-etherscan.mjs all --confirm
```

**Configurazione dell'app:**
- `apps/web/public/config.json` e `packages/contracts/src/addresses.ts` contengono le due testnet: contratto, WETH, USDC ed
  explorer;
- Base Sepolia è tra le reti a sequencer (`SEQUENCER_CHAINS`, stato MEV "L2");
- la rete predefinita resta Ethereum, dove `swap` è `null`.
- il build dell'app cambia di conseguenza. Al commit `cd11d87`: tree hash
  `c0a051cc36fcfab45043f11c147f074b4dd9a0dba444297e38da6cc7f668e324`, CID
  `bafybeiau7cgw5rfowzq723wxjol2mjfgujxlnwpt5z46gr2pfaecrzkqji`, contenthash
  `0xe3010170122014f88d6ec4aeb661fd6ed74b97a624a6a26eb6d9f3ee79e3474f280828e5504a`. Il build è riproducibile tra due build
  locali; il CI lo ricontrolla alla prossima run. Sostituisce il CID del commit `5b7b87a` per qualunque pubblicazione futura.

## Immagine della bacheca

Non ancora pubblicata: la pubblica il CI al push di un tag `v*` su un commit di `main`, creato dal proprietario dopo la testnet
(D-56). Alla pubblicazione, qui vanno tag, digest e commit, presi dal riepilogo della run:

| Tag | Digest | Commit | Run |
|---|---|---|---|
| — | — | — | — |

## Prossimi passi

1. **EIP-5792 (`wallet_sendCalls`):** approve + swap in un'unica conferma nei wallet che lo supportano, e invio atomico
   delle offerte multiple.
2. **Wallet integrato opzionale** (account locale nel browser): renderebbe possibile l'invio protetto (RPC privati con
   protezione dal revert) anche senza wallet esterno. Richiede un'analisi su custodia della chiave e recupero.
3. **Wrapper per ETH nativo** (esclusa dalla v1): pagare e ricevere ETH senza wrap manuale. Richiede il contratto Wrapper
   AirSwap e la sua verifica.
4. **Parere legale** su operatività della bacheca, commissioni, KYC/AML e giurisdizione, prima della mainnet.
5. **Revisione indipendente** del diff OpenZeppelin → solady (#1293), per chiudere la riserva sull'audit.
6. **Dopo la conferma:** deploy testnet → checklist → fill di prova → pubblicazione IPFS → contenthash ENS → dominio classico
   verificato con `verify-served.mjs`.

## Tabella dei test (regressione locale finale)

`node tools/testkit/run-suites.mjs --retries 2` al commit `def2674`: 39 suite, tutte verdi, exit 0. `web-visual` si è
rilanciato da solo nell'immagine Playwright. Il `docker-smoke` (8/8) è esplicito: in locale e nel job `docker` del CI.

| Gruppo | Suite (controlli) |
|---|---|
| tools | lint 1/1 · checksums 3/3 · testkit 4/4 · reproducible-build 1/1 |
| contracts | verify-source 4/4 · foundry 29/29 · addresses 5/5 · deploy 8/8 · fee 2/2 |
| book-server | backup 3/3 · config 9/9 · allocation 5/5 · migrations 7/7 · observability 5/5 · e2e 22/22 · engine 13/13 · signers 8/8 · metrics 7/7 · trades 12/12 · faults 12/12 · reorg 5/5 · pinned-read 1/1 · differential 3/3 · event-order 2/2 · http-security 11/11 |
| client | wallet 5/5 · client-guards 9/9 · client-smoke 4/4 · taker 13/13 · protect 5/5 · taker-advanced 12/12 |
| web | web-model 39/39 · web-keys 6/6 · web-layout 7/7 (L1 con webfont, L1b con woff2 bloccati, L5 geometria) · web-a11y 4/4 · web-visual 2/2 · web-e2e 18/18 · web-flows 21/21 · web-perf 5/5 (P5 LCP) |

Totale: **332 controlli** su 39 suite, più `docker-smoke` 8/8.

Suite web eseguite anche nell'immagine Playwright in locale: model 39, keys 6, layout 7, a11y 4, visual 2, e2e 18, flows 21,
perf 5 (P5 LCP 2,53 s), tutte verdi.

## Prova del CI (`verify.yml`)

Run verde dopo le correzioni della revisione: **https://github.com/arabafenice599rae/Fondaco-/actions/runs/41918930214**
(run 7, commit `61a0ee4`, profilo `full`, trigger push temporaneo: D-53). **Durata: 18 min 9 s** (21:44:44 → 22:02:53 UTC).
Zero `FAIL` e nessuna suite ripetuta.

| Job | Esito | Durata |
|---|---|---|
| toolchain (piano + cache) | ✅ | 1 min 6 s |
| lint (build, typecheck, generati, lint, checksums) | ✅ | 1 min 46 s |
| unit | ✅ | 1 min 31 s |
| fork (anvil al blocco 23700000) | ✅ | 4 min 46 s |
| foundry | ✅ | 1 min 9 s |
| web-e2e, nel container `mcr.microsoft.com/playwright:v1.63.0-noble@sha256:eff16c30…4a27` | ✅ | 16 min 57 s |
| supply-chain (audit, lockfile, gitleaks, SHA256SUMS) | ✅ | 24 s |
| reproducible-build-a / -b | ✅ / ✅ | 34 s / 32 s |
| reproducible-compare (tree hash `c9b62461…f1efe`, CID `bafybeigfhaq…66n7q`, uguali) | ✅ | 3 s |
| docker (immagine, MinIO dal tag, compose smoke 8/8) | ✅ | 5 min 45 s |
| docker-publish | saltato, come previsto (solo al push di un tag `v*`) | — |

Valori principali di `web-e2e` nella run 7:
- **Layout:** L1 e L1b puliti su 420 campioni ciascuno; L5 al massimo 0,4 px.
- **Visual:** V1 20/20, differenza massima 0,000%, con una sola serie di baseline.
- **Flussi:** F4a verde al primo tentativo.
- **Prestazioni:**
  - P3 Fast 3G 1,84 s;
  - Lighthouse 0,96/1;
  - LCP 2,6 s, il marchio dello splash: accettato, con soglia 3,0 s e obiettivo 2,5 s (D-59).

Storico delle run:

| Run | Esito | Causa | Correzione |
|---|---|---|---|
| [1](https://github.com/arabafenice599rae/Fondaco-/actions/runs/41792062847) | web-e2e: V1 20/20 diverse, L1 | rendering dei glifi diverso sul runner | — |
| 2 | annullata dalla run 3 (concurrency) | — | — |
| [3](https://github.com/arabafenice599rae/Fondaco-/actions/runs/41795830126) | identica alla 1 | ipotesi sbagliata (font in ritardo) | attesa dei font, tenuta |
| [4](https://github.com/arabafenice599rae/Fondaco-/actions/runs/41798013672) | L1 verde, V1 4/20 | antialiasing del runner | rendering fissato |
| [5](https://github.com/arabafenice599rae/Fondaco-/actions/runs/41800320167) | verde | — | baseline solo CI: **non approvata**, rimossa |
| [6](https://github.com/arabafenice599rae/Fondaco-/actions/runs/41914373389) | verde, ma F4a solo al 2° tentativo | il test leggeva lo stato una volta; gli eventi del firmatario sono indicizzati un giro dopo | F4a aspetta lo stato (max 20 s) |
| [7](https://github.com/arabafenice599rae/Fondaco-/actions/runs/41918930214) | **verde al primo tentativo** | — | — |

Dopo il merge della PR #2: run manuale `workflow_dispatch` (suite `full`) sul branch,
**https://github.com/arabafenice599rae/Fondaco-/actions/runs/41927262623**, verde, 18 min 19 s.
- Tutti i job verdi, nessuna suite ripetuta.
- Valori principali:
  - P5 LCP 2,67 s;
  - V1 20/20;
  - F4a al primo tentativo;
  - MinIO compilato dal tag (dl.min.io: 410);
  - sonda quay.io `unauthorized` (sonda poi tolta, D-58 nella forma originale).

Dopo la run 7 il trigger push sul branch è stato tolto. Restano `pull_request`, il notturno, `workflow_dispatch` (attivo
quando `verify.yml` è su `main`) e il push dei tag `v*`.
