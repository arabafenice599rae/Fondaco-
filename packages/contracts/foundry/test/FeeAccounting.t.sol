// SPDX-License-Identifier: MIT
pragma solidity 0.8.23;

import { Base } from "./utils/Base.sol";
import { IERC20 } from "./utils/Interfaces.sol";

/// Invariant (a): the fee always goes from the SIGNER to the fee wallet, in the signerToken, on top of signerAmount;
/// the sender pays exactly senderAmount, the recipient receives exactly signerAmount; nothing stays in the contract.
/// Fuzzed over amounts, fee values (0..9999 bps) and four token pairs (incl. USDT, which returns no bool).
contract FeeAccountingTest is Base {
  struct Bal { uint256 sS; uint256 sR; uint256 tS; uint256 tR; uint256 rS; uint256 fS; uint256 fR; uint256 cS; uint256 cR; }

  function pair(uint256 sel) internal pure returns (address give, address want) {
    sel = sel % 4;
    if (sel == 0) return (WETH, USDC);
    if (sel == 1) return (USDC, WETH);
    if (sel == 2) return (USDT, USDC);
    return (USDC, USDT);
  }

  function snap(address give, address want, address taker, address recipient) internal view returns (Bal memory b) {
    b.sS = IERC20(give).balanceOf(alice); b.sR = IERC20(want).balanceOf(alice);
    b.tS = IERC20(give).balanceOf(taker); b.tR = IERC20(want).balanceOf(taker);
    b.rS = IERC20(give).balanceOf(recipient);
    b.fS = IERC20(give).balanceOf(feeWallet); b.fR = IERC20(want).balanceOf(feeWallet);
    b.cS = IERC20(give).balanceOf(address(swapC)); b.cR = IERC20(want).balanceOf(address(swapC));
  }

  function run(uint256 signerAmount, uint256 senderAmount, uint256 feeBps, uint256 sel, bool otherRecipient) internal {
    (address give, address want) = pair(sel);
    if (feeBps != FEE) swapC.setProtocolFee(feeBps); // the test contract deployed the fixture: it is the owner
    address recipient = otherRecipient ? address(0xBEEF) : bob; // recipient is NOT signed: the taker chooses it
    Order memory o = sign(alicePk, order(alice, 1, give, signerAmount, want, senderAmount));
    fund(o, bob);
    uint256 fee = (signerAmount * feeBps) / 10000;
    Bal memory b0 = snap(give, want, bob, recipient);
    fillAny(bob, recipient, o);
    Bal memory b1 = snap(give, want, bob, recipient);

    eq(b0.sS - b1.sS, signerAmount + fee, "signer pays signerAmount + fee");
    eq(b1.sS, 0, "signer funded exactly amount + fee ends at 0");
    eq(b1.sR - b0.sR, senderAmount, "signer receives senderAmount");
    eq(b0.tR - b1.tR, senderAmount, "sender pays exactly senderAmount");
    eq(b1.fS - b0.fS, fee, "fee wallet receives floor(signerAmount*fee/10000) in signerToken");
    eq(b1.fR, b0.fR, "fee wallet receives nothing in senderToken");
    eq(b1.cS + b1.cR, 0, "no balance left in the contract");
    if (otherRecipient) {
      eq(b1.rS - b0.rS, signerAmount, "recipient receives exactly signerAmount");
      eq(b1.tS, b0.tS, "sender receives nothing when recipient differs");
    } else {
      eq(b1.tS - b0.tS, signerAmount, "sender (= recipient) receives exactly signerAmount");
    }
  }

  function testFuzz_feeFromSignerInSignerToken(uint256 signerAmount, uint256 senderAmount, uint256 feeBps, uint256 sel, bool otherRecipient) public {
    signerAmount = bound(signerAmount, 1, 1e30);
    senderAmount = bound(senderAmount, 1, 1e30);
    feeBps = bound(feeBps, 0, 9999);
    run(signerAmount, senderAmount, feeBps, sel, otherRecipient);
  }

  /// Rounding: at 30 bps the fee is 0 up to signerAmount = 333 and 1 from 334 (floor(334*30/10000) = 1).
  function testFuzz_feeIsZeroBelowThreshold(uint256 signerAmount, uint256 sel) public {
    signerAmount = bound(signerAmount, 1, 333);
    (address give,) = pair(sel);
    uint256 before = IERC20(give).balanceOf(feeWallet);
    run(signerAmount, 1e6, FEE, sel, false);
    eq(IERC20(give).balanceOf(feeWallet) - before, 0, "fee rounds down to 0");
  }

  function test_feeThresholdAt30Bps() public {
    run(334, 1e6, FEE, 0, false);
    eq(IERC20(WETH).balanceOf(feeWallet), 1, "334 units pay a fee of 1");
  }

  function testFuzz_feeFormulaMatchesFloor(uint256 signerAmount, uint256 feeBps) public {
    signerAmount = bound(signerAmount, 1, 1e30);
    feeBps = bound(feeBps, 1, 9999);
    uint256 fee = (signerAmount * feeBps) / 10000;
    ok(fee * 10000 <= signerAmount * feeBps && (fee + 1) * 10000 > signerAmount * feeBps, "floor");
    if (signerAmount * feeBps < 10000) eq(fee, 0, "below threshold the fee is zero");
  }
}
