// SPDX-License-Identifier: MIT
pragma solidity 0.8.23;

import { Base } from "./utils/Base.sol";
import { ISwapERC20 } from "./utils/Interfaces.sol";

/// v4.3 pins the chain at deployment (DOMAIN_CHAIN_ID) and refuses to execute anywhere else; check() reports it in its
/// first slot. The domain separator is fixed too, so on another chain the signature itself still verifies: only the
/// chain check stops the fill.
contract ChainIdTest is Base {
  function ready(uint256 nonce) internal returns (Order memory o) {
    o = sign(alicePk, order(alice, nonce, WETH, 1e18, USDC, 2500e6));
    fund(o, bob);
  }

  function test_domainChainIdIsDeploymentChain() public view {
    eq(swapC.DOMAIN_CHAIN_ID(), 1, "DOMAIN_CHAIN_ID = chain of deployment");
  }

  function test_otherChainSwapRevertsChainIdChanged() public {
    Order memory o = ready(1);
    vm.chainId(5);
    vm.expectRevert(ISwapERC20.ChainIdChanged.selector);
    fillAny(bob, bob, o);
    vm.expectRevert(ISwapERC20.ChainIdChanged.selector);
    vm.prank(bob);
    swapC.swap(bob, o.nonce, o.expiry, o.signerWallet, o.signerToken, o.signerAmount, o.senderToken, o.senderAmount, o.v, o.r, o.s);
  }

  function test_otherChainCheckReportsChainIdChangedOnly() public {
    Order memory o = ready(2);
    eq(checkErrors(o).length, 0, "valid on chain 1: no errors");
    vm.chainId(5);
    bytes32[] memory errs = checkErrors(o);
    eq(errs.length, 1, "one error on chain 5 (fixed domain separator: the signature still verifies)");
    ok(errs[0] == "ChainIdChanged", "check()[0] = ChainIdChanged");
    // back on the deployment chain the same order fills
    vm.chainId(1);
    fillAny(bob, bob, o);
    ok(swapC.nonceUsed(alice, 2), "filled on chain 1");
  }

  /// Documented behaviour of v4.3: swapLight() does NOT check DOMAIN_CHAIN_ID, and the domain separator is fixed, so on
  /// another chain (e.g. after a chain split) a swapLight order signed on chain 1 still executes. v5.0.0 recomputes the
  /// domain (solady _hashTypedData) and would reject it. FONDACO never calls swapLight (the taker uses swapAnySender).
  function test_swapLightIgnoresChainId() public {
    Order memory o = order(alice, 4, WETH, 1e18, USDC, 2500e6);
    o.senderWallet = bob; // swapLight signs msg.sender as senderWallet, with protocolFeeLight
    o = sign(alicePk, o);
    fund(o, bob);
    vm.chainId(5);
    vm.prank(bob);
    swapC.swapLight(o.nonce, o.expiry, o.signerWallet, o.signerToken, o.signerAmount, o.senderToken, o.senderAmount, o.v, o.r, o.s);
    ok(swapC.nonceUsed(alice, 4), "swapLight executed on chain 5");
  }

  /// check() allocates MAX_ERROR_COUNT = 8 slots (v5.0.0: 7, without ChainIdChanged). SignatureInvalid and
  /// NonceAlreadyUsed exclude each other, so the worst case fills 7 of them, in this order, without overflowing.
  function test_checkWorstCaseSevenErrorsInEightSlots() public {
    Order memory o = order(alice, 3, WETH, 1e18, USDC, 2500e6);
    o.senderWallet = bob; // a private order: the sender's funds are checked too
    o.expiry = block.timestamp - 1;
    o = sign(bobPk, o); // wrong signer
    setBalance(WETH, alice, 0);
    setBalance(USDC, bob, 0);
    vm.chainId(5);
    bytes32[] memory errs = checkErrors(o);
    eq(errs.length, 7, "7 errors");
    bytes32[7] memory want = [bytes32("ChainIdChanged"), "SignatureInvalid", "OrderExpired", "SenderAllowanceLow", "SenderBalanceLow", "SignerAllowanceLow", "SignerBalanceLow"];
    for (uint256 i; i < 7; i++) ok(errs[i] == want[i], string(abi.encodePacked("slot ", bytes1(uint8(48 + i)))));
    vm.chainId(1);
    eq(checkErrors(o).length, 6, "same order on chain 1: the 6 errors v5.0.0 could also report");
  }
}
