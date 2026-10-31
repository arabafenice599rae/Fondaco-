# Decisioni e punti aperti

Registro delle scelte prese e dei punti in cui specifica e codice di riferimento sono ambigui o in conflitto.
Stato: **D** = decisa, **A** = aperta (serve conferma), **P** = proposta in attesa di conferma.

## Fase 0

### D-01 · `evmVersion: paris` nella verifica del sorgente — D
La specifica indica solo "solc 0.8.23, ottimizzatore 999999 run". Con queste sole impostazioni solc 0.8.23 usa `shanghai`
e il bytecode **non** coincide (diverso anche in lunghezza: compare `PUSH0`). Il fixture coincide byte per byte solo con
`evmVersion: paris`, che è il default di Hardhat per 0.8.20+ nella versione usata dal repository AirSwap
(`hardhat.config.js` del tag non imposta `evmVersion`). Conseguenza utile: niente `PUSH0`, quindi lo stesso bytecode si deploya
anche su chain senza Shanghai. `tools/verify-source` lo fissa esplicitamente.

### D-02 · anvil al posto di hardhat — D
La specifica §7 dice che i test girano su hardhat; la fase 0 chiede anvil a blocco fisso. I test portati passano su anvil
senza modifiche (alias `hardhat_*`). Nella fase 3 il `testClient` passerà a `mode: 'anvil'` (cambio solo di test).

### D-03 · Un fork nuovo per suite — D
Ogni suite parte con un anvil appena avviato allo stesso blocco: niente stato condiviso tra suite (automine, tempo, snapshot).
Costo ≈ 1 s per suite grazie alla cache su disco di anvil.

### D-04 · RPC per il fork in sviluppo — D
`https://eth.drpc.org` (piano gratuito, risponde a richieste archivio) va bene per lo sviluppo locale ed è il valore di esempio.
In CI servirà un RPC archivio a pagamento come secret (fase 7).

## Punti aperti

### A-01 · Wrapper nel deploy
La v1 esclude il Wrapper, ma `scripts/deploy.js` lo deploya se c'è `WETH` e il test `deploy` (D1–D4) passa `WETH`,
quindi oggi deploya anche il Wrapper (tx #1, `Ownable2Step` con `acceptOwnership` dal Safe). Anche `/config` espone `wrapper`.
**Proposta:** nella fase 1 togliere il Wrapper dal deploy e da `/config` (campo `wrapper: null` per compatibilità),
mantenendo D1–D4 identici per SwapERC20; il fixture `Wrapper.json` resta nel repository solo come riferimento.
È un cambio di un comportamento coperto da test: serve la tua conferma.

### A-02 · `invalid_signer` dopo `revoke()`
Nel server `invalid_signer` è terminale (README di riferimento: "va rifirmato dopo revoke"), ma on-chain, dopo `revoke()`,
le firme vecchie **tornano valide** (invariante (d) della fase 1). Un'offerta che il book considera morta può quindi essere
eseguita da chiunque ne abbia una copia. **Proposta:** non riattivarla nel book (resta terminale, comportamento attuale), ma
in "Le mie offerte" mostrarla come "ancora eseguibile on-chain dopo revoke: annullala" con il pulsante di annullamento protetto.
Da confermare.

### A-03 · "viem unica dipendenza" e requisiti della fase 2
La specifica §3 vuole `viem` come unica dipendenza del server; la fase 2 chiede configurazione validata con uno schema,
log JSON e metriche Prometheus. **Proposta:** dipendenze di runtime ancora solo `viem`; validatore dello schema, logger JSON e
formato Prometheus scritti in casa (piccoli e testati); TypeScript e strumenti di test solo come dipendenze di sviluppo.
In alternativa `zod` come seconda dipendenza di runtime. Da scegliere.

### A-04 · "10 coppie di esempio" e "nessun dato inventato in produzione"
§6.2 descrive i Mercati con 10 coppie di esempio (come il prototipo), la fase 5 vieta dati inventati in produzione.
**Proposta:** in produzione i mercati derivano dalla whitelist di `/config` per chain (solo coppie con un book); le 10 coppie
di esempio solo in una modalità demo esplicita (`VITE_DEMO=1`), mai attiva nel build di produzione.

### A-05 · Campo `confirmations` nelle configurazioni dei test
Le configurazioni dei test passano `confirmations: 0`, ma il motore non lo legge (indicizza fino alla testa e gestisce i reorg).
Nella fase 2, con lo schema di configurazione, una chiave sconosciuta sarà un errore: proposta di toglierla dai test.
