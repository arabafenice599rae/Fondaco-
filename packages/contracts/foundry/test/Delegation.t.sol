// SPDX-License-Identifier: MIT
pragma solidity 0.8.23;

import { Base } from "./utils/Base.sol";
import { ISwapERC20 } from "./utils/Interfaces.sol";

/// Invariant (d): after authorize(delegate) the wallet's own signatures stop validating; after revoke() they are valid
/// AGAIN. Documented effects (why FONDACO rejects delegated signers and keeps invalid_signer terminal, decision A-02):
///  - while authorized, the delegate's signatures are valid for the wallet, and their nonces are consumed in the
///    DELEGATE's bitmap, which the wallet's own cancel() does not reach;
///  - after revoke(), any saved copy of an old wallet signature is fillable again until cancel() is called.
contract DelegationTest is Base {
  uint256 internal delegatePk = 0xDE1E6A7E;

  function test_authorizeInvalidatesRevokeRestores() public {
    address delegate = vm.addr(delegatePk);
    Order memory own = sign(alicePk, order(alice, 1, WETH, 1e18, USDC, 2500e6));
    fund(own, bob);
    eq(checkErrors(own).length, 0, "valid before authorize");

    vm.prank(alice);
    swapC.authorize(delegate);
    ok(swapC.authorized(alice) == delegate, "authorized");
    ok(hasError(checkErrors(own), "SignatureInvalid"), "own signature invalid while a delegate is set");
    vm.expectRevert(ISwapERC20.SignatureInvalid.selector);
    fillAny(bob, bob, own);

    // the delegate signs for alice; the nonce lands in the delegate's bitmap
    Order memory byDelegate = sign(delegatePk, order(alice, 2, WETH, 1e18, USDC, 2500e6));
    fund(byDelegate, bob);
    eq(checkErrors(byDelegate).length, 0, "delegate signature valid for alice");
    fillAny(bob, bob, byDelegate);
    ok(swapC.nonceUsed(delegate, 2) && !swapC.nonceUsed(alice, 2), "nonce consumed under the delegate, not under alice");

    vm.prank(alice);
    swapC.revoke();
    ok(swapC.authorized(alice) == address(0), "revoked");
    fund(own, bob); // the delegate's fill spent alice's funds: refund, so check() only looks at the signature
    eq(checkErrors(own).length, 0, "old own signature valid AGAIN after revoke");
    Order memory byDelegate2 = sign(delegatePk, order(alice, 3, WETH, 1e18, USDC, 2500e6));
    ok(hasError(checkErrors(byDelegate2), "SignatureInvalid"), "delegate signatures invalid after revoke");
    fillAny(bob, bob, own); // anyone with the saved signature can fill it
    ok(swapC.nonceUsed(alice, 1), "filled after revoke");
  }

  /// After revoke(), cancel() by the wallet is what ends the old signature.
  function test_revokeThenCancelKills() public {
    Order memory own = sign(alicePk, order(alice, 4, WETH, 1e18, USDC, 2500e6));
    fund(own, bob);
    vm.startPrank(alice);
    swapC.authorize(vm.addr(delegatePk));
    swapC.revoke();
    uint256[] memory ns = new uint256[](1);
    ns[0] = 4;
    swapC.cancel(ns);
    vm.stopPrank();
    vm.expectRevert(abi.encodeWithSelector(ISwapERC20.NonceAlreadyUsed.selector, 4));
    fillAny(bob, bob, own);
  }

  function test_authorizeZeroReverts() public {
    vm.prank(alice);
    vm.expectRevert(ISwapERC20.SignatoryInvalid.selector);
    swapC.authorize(address(0));
  }
}
