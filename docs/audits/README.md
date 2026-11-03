# Audit

| File | Contenuto |
|---|---|
| `PeckShield-Audit-Report-AirSwap-v1.0.2.pdf` | PeckShield, report #2024-047 "AirSwap V4.3" (SwapERC20, Swap, Staking, Registry), 23 aprile 2024. Fonte: link "AirSwap V4.3: SwapERC20, Swap, Staking, Registry" in about.airswap.xyz/technology/deployments → github.com/peckshield/publications, `audit_reports/PeckShield-Audit-Report-AirSwap-v1.0.2.pdf` |
| `swap-erc20-27b60da-to-6ad0137.diff` | contratti di `source/swap-erc20` dal commit post-correzioni dell'audit al sorgente deployato: solo `version = "4.2"` → `"4.3"` più commenti |
| `swap-erc20-bcd4c48-to-6ad0137.diff` | dal commit esaminato al sorgente deployato (include il passaggio OpenZeppelin → solady, #1293) |
| `SHA256SUMS` | SHA-256 dei tre file (`sha256sum -c SHA256SUMS`) |

Commit esaminato `bcd4c48`, commit dopo le correzioni `27b60da`, entrambi antenati di `6ad0137` (tag `v4.3`).
Sintesi dei rilievi e riserva sul passaggio a solady: README principale, sezione "Audit".
