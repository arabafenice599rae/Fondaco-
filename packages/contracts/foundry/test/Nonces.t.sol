// SPDX-License-Identifier: MIT
pragma solidity 0.8.23;

import { Base } from "./utils/Base.sol";
import { ISwapERC20 } from "./utils/Interfaces.sol";
import { Vm } from "./utils/Vm.sol";

/// Invariant (b): every nonce is used once — by a fill or by a cancel — in a bitmap of 256 nonces per word, per signatory.
contract NoncesTest is Base {
  function ready(uint256 nonce) internal returns (Order memory o) {
    o = sign(alicePk, order(alice, nonce, WETH, 1e18, USDC, 2500e6));
    fund(o, bob);
    setBalance(WETH, alice, 10e18); // enough for several fills
  }

  function test_fillTwiceReverts() public {
    Order memory o = ready(7);
    fillAny(bob, bob, o);
    ok(swapC.nonceUsed(alice, 7), "nonce marked used by the fill");
    setBalance(USDC, bob, 2500e6);
    vm.expectRevert(abi.encodeWithSelector(ISwapERC20.NonceAlreadyUsed.selector, 7));
    fillAny(bob, bob, o);
  }

  function test_cancelThenFillReverts() public {
    Order memory o = ready(8);
    uint256[] memory ns = new uint256[](1);
    ns[0] = 8;
    vm.prank(alice);
    swapC.cancel(ns);
    ok(swapC.nonceUsed(alice, 8), "nonce marked used by cancel");
    vm.expectRevert(abi.encodeWithSelector(ISwapERC20.NonceAlreadyUsed.selector, 8));
    fillAny(bob, bob, o);
  }

  /// Documented behaviour: cancel() of an already-used nonce does not revert and emits no Cancel event.
  /// This is how protect.cancelOrders tells "cancelled" from "partly_taken".
  function test_cancelAfterFillEmitsNothing() public {
    Order memory o = ready(9);
    fillAny(bob, bob, o);
    uint256[] memory ns = new uint256[](2);
    ns[0] = 9;
    ns[1] = 10;
    vm.recordLogs();
    vm.prank(alice);
    swapC.cancel(ns);
    Vm.Log[] memory logs = vm.getRecordedLogs();
    eq(logs.length, 1, "one Cancel event (for the unused nonce only)");
    ok(logs[0].topics[0] == ISwapERC20.Cancel.selector && uint256(logs[0].topics[1]) == 10, "Cancel(10)");
  }

  /// cancel() acts on msg.sender's nonces only: someone else cannot cancel alice's orders.
  function test_cancelOnlyOwnNonces() public {
    Order memory o = ready(11);
    uint256[] memory ns = new uint256[](1);
    ns[0] = 11;
    vm.prank(bob);
    swapC.cancel(ns);
    ok(swapC.nonceUsed(bob, 11) && !swapC.nonceUsed(alice, 11), "bob's cancel marks bob's bitmap only");
    fillAny(bob, bob, o);
  }

  /// Bitmap isolation: using one nonce never marks another, also across 256-bit word boundaries.
  function testFuzz_bitmapIsolation(uint256 a, uint256 b) public {
    vm.assume(a != b);
    uint256[] memory ns = new uint256[](1);
    ns[0] = a;
    vm.prank(alice);
    swapC.cancel(ns);
    ok(swapC.nonceUsed(alice, a), "a used");
    ok(!swapC.nonceUsed(alice, b), "b untouched");
  }

  function test_wordBoundaries() public {
    uint256[] memory ns = new uint256[](3);
    (ns[0], ns[1], ns[2]) = (255, 256, type(uint256).max);
    vm.prank(alice);
    swapC.cancel(ns);
    ok(swapC.nonceUsed(alice, 255) && swapC.nonceUsed(alice, 256) && swapC.nonceUsed(alice, type(uint256).max), "marked");
    ok(!swapC.nonceUsed(alice, 254) && !swapC.nonceUsed(alice, 257) && !swapC.nonceUsed(alice, 0), "neighbours untouched");
  }
}
