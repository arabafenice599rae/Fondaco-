// SPDX-License-Identifier: MIT
pragma solidity 0.8.23;

import { Base } from "./utils/Base.sol";
import { ISwapERC20, IERC20 } from "./utils/Interfaces.sol";

/// Invariant (c): protocolFee is part of the signed hash. Changing it invalidates every existing signature
/// (the book's invalid_fee), new signatures at the new fee are valid, and setting the fee back makes the old
/// signatures valid again (the book's revive).
contract FeeChangeTest is Base {
  function test_feeChangeInvalidatesThenRevives() public {
    Order memory old = sign(alicePk, order(alice, 1, WETH, 1e18, USDC, 2500e6)); // signed at 30
    fund(old, bob);
    eq(checkErrors(old).length, 0, "valid at the signed fee");

    swapC.setProtocolFee(50);
    ok(hasError(checkErrors(old), "SignatureInvalid"), "check(): SignatureInvalid after the fee change");
    vm.expectRevert(ISwapERC20.SignatureInvalid.selector);
    fillAny(bob, bob, old);

    // a new signature at the new fee is valid, and pays the new fee
    Order memory fresh = sign(alicePk, order(alice, 2, WETH, 1e18, USDC, 2500e6)); // protocolFee() is now 50
    eq(fresh.protocolFee, 50, "signed at the new fee");
    fund(fresh, bob);
    eq(checkErrors(fresh).length, 0, "new signature valid");
    uint256 f0 = IERC20(WETH).balanceOf(feeWallet);
    fillAny(bob, bob, fresh);
    eq(IERC20(WETH).balanceOf(feeWallet) - f0, (1e18 * 50) / 10000, "fee charged at the new rate");

    // fee back to the signed value: the old signature is valid again (revive), and pays 30
    swapC.setProtocolFee(30);
    fund(old, bob);
    eq(checkErrors(old).length, 0, "old signature valid again after revert of the fee");
    uint256 f1 = IERC20(WETH).balanceOf(feeWallet);
    fillAny(bob, bob, old);
    eq(IERC20(WETH).balanceOf(feeWallet) - f1, (1e18 * 30) / 10000, "fee charged at the signed rate");
  }

  /// An order whose protocolFee field differs from the contract's fee never validates (the contract hashes its own fee).
  function testFuzz_signedFeeMustEqualContractFee(uint256 signedFee) public {
    signedFee = bound(signedFee, 0, 9999);
    vm.assume(signedFee != FEE);
    Order memory o = order(alice, 3, WETH, 1e18, USDC, 2500e6);
    o.protocolFee = signedFee;
    o = sign(alicePk, o);
    fund(o, bob);
    ok(hasError(checkErrors(o), "SignatureInvalid"), "mismatching fee field -> SignatureInvalid");
  }

  function test_onlyOwnerSetsFee() public {
    vm.prank(alice);
    vm.expectRevert(ISwapERC20.Unauthorized.selector);
    swapC.setProtocolFee(40);
  }
}
