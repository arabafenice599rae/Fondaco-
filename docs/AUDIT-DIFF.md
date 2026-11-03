# SwapERC20: v4.3 (riferimento) ↔ v5.0.0 (riferimento precedente)

Il progetto usa il sorgente del tag **v4.3** (`6ad0137`), cioè il contratto che AirSwap ha deployato come "V5.0" a
`0xD82E10B9A4107939e55fCCa9B53A9ede6CF2fC46` ed è coperto dall'audit PeckShield "AirSwap V4.3". Fino alla Fase 5 il
riferimento era il tag **v5.0.0** (`28156e5`), mai deployato da AirSwap a quell'indirizzo. Questo documento registra le differenze.
Le dipendenze sono le stesse (solady 0.0.173, solc 0.8.23, 999999 run, evmVersion paris).

## Cosa cambia per chi usa il contratto

| | v4.3 (6ad0137) | v5.0.0 (28156e5) |
|---|---|---|
| Catena | `DOMAIN_CHAIN_ID` fissato al deploy; `swap` e `swapAnySender` revertono con **`ChainIdChanged`** su un'altra chain. **`swapLight` non controlla la chain** e, col separatore fisso, un suo ordine resta eseguibile su un'altra chain (test `test_swapLightIgnoresChainId`) | nessun controllo esplicito, ma il dominio si ricalcola con la chain corrente: le firme di un'altra chain non valgono |
| Separatore EIP-712 | `DOMAIN_SEPARATOR` immutabile, calcolato al deploy | `_hashTypedData` di solady (ricalcola il dominio se la chain cambia) |
| Dominio | `SWAP_ERC20` / `4.3` | `SWAP_ERC20` / `4.3` (uguale) |
| `check()` | 8 slot; il primo errore possibile è `"ChainIdChanged"` | 7 slot |
| Errori dei parametri | `InvalidFee`, `InvalidFeeLight`, `InvalidFeeWallet`, `InvalidStaking` | `ProtocolFeeInvalid`, `ProtocolFeeLightInvalid`, `ProtocolFeeWalletInvalid`, `StakingInvalid` |
| Firma dell'ordine, tipi, commissione, nonce, eventi | uguali | uguali |
| Bytecode di creazione | 12 123 byte, sha256 `45dffc57…6109` | 12 221 byte, sha256 `139ab5cb…3d77` |

Sulla chain di deploy il comportamento osservabile è lo stesso: stessi ordini firmati, stessi esiti; cambiano solo i nomi
dei quattro errori di parametro (mai decodificati dal codice del progetto) e la lunghezza massima di `check()` (array dinamico,
troncato al numero reale di errori). Per questo le suite sono rimaste verdi senza modifiche di logica; i test nuovi
(`ChainId.t.sol`, `Errors.t.sol`) fissano il comportamento specifico della v4.3. FONDACO non usa `swapLight`
(il taker chiama `swapAnySender`), quindi la differenza su `swapLight` non lo tocca.

## Diff dei sorgenti (`v4.3` → `v5.0.0`)

```diff
--- v4.3/SwapERC20.sol
+++ v5.0.0/SwapERC20.sol
@@ -15,7 +15,6 @@
  * @notice https://www.airswap.io/
  */
 contract SwapERC20 is ISwapERC20, Ownable, EIP712 {
-  uint256 public immutable DOMAIN_CHAIN_ID;
   bytes32 public immutable DOMAIN_SEPARATOR;
 
   bytes32 public constant ORDER_TYPEHASH =
@@ -27,7 +26,7 @@
     );
 
   uint256 public constant FEE_DIVISOR = 10000;
-  uint256 private constant MAX_ERROR_COUNT = 8;
+  uint256 private constant MAX_ERROR_COUNT = 7;
   uint256 private constant MAX_MAX = 100;
   uint256 private constant MAX_SCALE = 77;
 
@@ -63,15 +62,14 @@
     uint256 _bonusScale,
     uint256 _bonusMax
   ) {
-    if (_protocolFee >= FEE_DIVISOR) revert InvalidFee();
-    if (_protocolFeeLight >= FEE_DIVISOR) revert InvalidFeeLight();
-    if (_protocolFeeWallet == address(0)) revert InvalidFeeWallet();
+    if (_protocolFee >= FEE_DIVISOR) revert ProtocolFeeInvalid();
+    if (_protocolFeeLight >= FEE_DIVISOR) revert ProtocolFeeLightInvalid();
+    if (_protocolFeeWallet == address(0)) revert ProtocolFeeWalletInvalid();
     if (_bonusMax > MAX_MAX) revert MaxTooHigh();
     if (_bonusScale > MAX_SCALE) revert ScaleTooHigh();
 
     _initializeOwner(msg.sender);
 
-    DOMAIN_CHAIN_ID = block.chainid;
     DOMAIN_SEPARATOR = _domainSeparator();
 
     protocolFee = _protocolFee;
@@ -257,23 +255,19 @@
 
     // Recover the signatory from the hash and signature
     address signatory = ECDSA.tryRecover(
-      keccak256(
-        abi.encodePacked(
-          "\x19\x01", // EIP191: Indicates EIP712
-          DOMAIN_SEPARATOR,
-          keccak256(
-            abi.encode(
-              ORDER_TYPEHASH,
-              nonce,
-              expiry,
-              signerWallet,
-              signerToken,
-              signerAmount,
-              protocolFeeLight,
-              msg.sender,
-              senderToken,
-              senderAmount
-            )
+      _hashTypedData(
+        keccak256(
+          abi.encode(
+            ORDER_TYPEHASH,
+            nonce,
+            expiry,
+            signerWallet,
+            signerToken,
+            signerAmount,
+            protocolFeeLight,
+            msg.sender,
+            senderToken,
+            senderAmount
           )
         )
       ),
@@ -330,7 +324,7 @@
    */
   function setProtocolFee(uint256 _protocolFee) external onlyOwner {
     // Ensure the fee is less than divisor
-    if (_protocolFee >= FEE_DIVISOR) revert InvalidFee();
+    if (_protocolFee >= FEE_DIVISOR) revert ProtocolFeeInvalid();
     protocolFee = _protocolFee;
     emit SetProtocolFee(_protocolFee);
   }
@@ -341,7 +335,7 @@
    */
   function setProtocolFeeLight(uint256 _protocolFeeLight) external onlyOwner {
     // Ensure the fee is less than divisor
-    if (_protocolFeeLight >= FEE_DIVISOR) revert InvalidFeeLight();
+    if (_protocolFeeLight >= FEE_DIVISOR) revert ProtocolFeeLightInvalid();
     protocolFeeLight = _protocolFeeLight;
     emit SetProtocolFeeLight(_protocolFeeLight);
   }
@@ -352,7 +346,7 @@
    */
   function setProtocolFeeWallet(address _protocolFeeWallet) external onlyOwner {
     // Ensure the new fee wallet is not null
-    if (_protocolFeeWallet == address(0)) revert InvalidFeeWallet();
+    if (_protocolFeeWallet == address(0)) revert ProtocolFeeWalletInvalid();
     protocolFeeWallet = _protocolFeeWallet;
     emit SetProtocolFeeWallet(_protocolFeeWallet);
   }
@@ -385,7 +379,7 @@
    */
   function setStaking(address _stakingToken) external onlyOwner {
     // Ensure the new staking token is not null
-    if (_stakingToken == address(0)) revert InvalidStaking();
+    if (_stakingToken == address(0)) revert StakingInvalid();
     stakingToken = _stakingToken;
     emit SetStaking(_stakingToken);
   }
@@ -474,10 +468,6 @@
     order.s = s;
     order.senderWallet = senderWallet;
 
-    if (DOMAIN_CHAIN_ID != block.chainid) {
-      errors[count++] = "ChainIdChanged";
-    }
-
     // Validate as the authorized signatory if set
     address signatory = order.signerWallet;
     if (authorized[signatory] != address(0)) {
@@ -655,9 +645,6 @@
     bytes32 r,
     bytes32 s
   ) private {
-    // Ensure execution on the intended chain
-    if (DOMAIN_CHAIN_ID != block.chainid) revert ChainIdChanged();
-
     // Ensure the expiry is not passed
     if (expiry <= block.timestamp) revert OrderExpired();
 
@@ -711,23 +698,19 @@
     uint256 senderAmount
   ) private view returns (bytes32) {
     return
-      keccak256(
-        abi.encodePacked(
-          "\x19\x01", // EIP191: Indicates EIP712
-          DOMAIN_SEPARATOR,
-          keccak256(
-            abi.encode(
-              ORDER_TYPEHASH,
-              nonce,
-              expiry,
-              signerWallet,
-              signerToken,
-              signerAmount,
-              protocolFee,
-              senderWallet,
-              senderToken,
-              senderAmount
-            )
+      _hashTypedData(
+        keccak256(
+          abi.encode(
+            ORDER_TYPEHASH,
+            nonce,
+            expiry,
+            signerWallet,
+            signerToken,
+            signerAmount,
+            protocolFee,
+            senderWallet,
+            senderToken,
+            senderAmount
           )
         )
       );
--- v4.3/interfaces/ISwapERC20.sol
+++ v5.0.0/interfaces/ISwapERC20.sol
@@ -28,17 +28,16 @@
   event SetBonusMax(uint256 bonusMax);
   event SetStaking(address indexed staking);
 
-  error ChainIdChanged();
-  error InvalidFee();
-  error InvalidFeeLight();
-  error InvalidFeeWallet();
-  error InvalidStaking();
-  error OrderExpired();
   error MaxTooHigh();
   error NonceAlreadyUsed(uint256);
+  error OrderExpired();
+  error ProtocolFeeInvalid();
+  error ProtocolFeeLightInvalid();
+  error ProtocolFeeWalletInvalid();
   error ScaleTooHigh();
   error SignatoryInvalid();
   error SignatureInvalid();
+  error StakingInvalid();
   error TransferFromFailed();
 
   function swap(
```
