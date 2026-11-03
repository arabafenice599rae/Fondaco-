// SPDX-License-Identifier: MIT
pragma solidity 0.8.23;

import { Base } from "./utils/Base.sol";
import { ISwapERC20 } from "./utils/Interfaces.sol";

/// Case (e): high-s malleable signatures. OBSERVED: SwapERC20 v4.3 (solady SignatureCheckerLib/ecrecover) ACCEPTS the
/// high-s twin (s' = n − s, v flipped). It is harmless on-chain because the order hash ignores the signature and the
/// nonce is consumed once: only one of the two copies can ever fill. Off-chain the book deduplicates by EIP-712 hash
/// (packages/book-server/test/signers.test.js S2).
contract MalleabilityTest is Base {
  function twin(Order memory o) internal pure returns (Order memory t) {
    t = o;
    t.s = bytes32(SECP256K1_N - uint256(o.s));
    t.v = o.v == 27 ? 28 : 27;
  }

  function test_highSAcceptedButSingleUse() public {
    Order memory o = sign(alicePk, order(alice, 1, WETH, 1e18, USDC, 2500e6));
    ok(uint256(o.s) <= SECP256K1_N / 2, "vm.sign produces low-s");
    Order memory t = twin(o);
    fund(o, bob);
    eq(checkErrors(t).length, 0, "check(): high-s twin accepted");
    fillAny(bob, bob, t); // the malleated copy fills
    ok(hasError(checkErrors(o), "NonceAlreadyUsed"), "original now reports NonceAlreadyUsed");
    setBalance(USDC, bob, 2500e6);
    vm.expectRevert(abi.encodeWithSelector(ISwapERC20.NonceAlreadyUsed.selector, 1));
    fillAny(bob, bob, o);
  }

  function testFuzz_twinSameFateAsOriginal(uint256 nonce, uint256 amount) public {
    amount = bound(amount, 1e6, 1e24);
    Order memory o = sign(alicePk, order(alice, nonce, WETH, amount, USDC, 1e6));
    fund(o, bob);
    eq(checkErrors(twin(o)).length, checkErrors(o).length, "twin validates exactly like the original");
  }
}
