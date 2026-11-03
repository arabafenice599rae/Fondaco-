// SPDX-License-Identifier: MIT
pragma solidity 0.8.23;

import { Test } from "forge-std/Test.sol";
import { StdInvariant } from "forge-std/StdInvariant.sol";
import { ISwapERC20, IERC20 } from "../utils/Interfaces.sol";
import { Handler } from "./Handler.sol";

/// Stateful invariants of SwapERC20 v4.3 (fixture bytecode) under random sequences of
/// public fills, private fills, cancels, fee changes, authorize, revoke, transfers and approvals:
///  1. fee wallet received exactly Σ floor(signerAmount · fee / 10000) over the fills that happened (per token)
///  2. the contract never holds tokens
///  3. a used nonce never becomes free again
contract SwapInvariantsTest is StdInvariant, Test {
  address internal constant USDC = 0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48;
  address internal constant USDT = 0xdAC17F958D2ee523a2206206994597C13D831ec7;
  address internal constant WETH = 0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2;
  address internal constant FEE_WALLET = 0xfEE0000000000000000000000000000000000002;

  Handler internal handler;
  ISwapERC20 internal swapC;
  address[] internal toks;
  mapping(address => uint256) internal fee0;

  function setUp() public {
    string memory cfg = vm.readFile("../../fork.config.json");
    assertGe(block.number, vm.parseJsonUint(cfg, ".forkBlock"), "fork block");
    toks.push(USDC);
    toks.push(USDT);
    toks.push(WETH);
    bytes memory code = abi.encodePacked(vm.parseJsonBytes(vm.readFile("./fixtures/SwapERC20.json"), ".bytecode"),
      abi.encode(uint256(30), uint256(30), FEE_WALLET, uint256(0), uint256(0)));
    handler = new Handler(code, FEE_WALLET, toks);
    swapC = handler.swapC();
    require(swapC.owner() == address(handler), "handler is owner");
    for (uint256 i; i < toks.length; i++) fee0[toks[i]] = IERC20(toks[i]).balanceOf(FEE_WALLET);

    bytes4[] memory sel = new bytes4[](8);
    sel[0] = Handler.fillPublic.selector;
    sel[1] = Handler.fillPrivate.selector;
    sel[2] = Handler.cancel.selector;
    sel[3] = Handler.setProtocolFee.selector;
    sel[4] = Handler.authorize.selector;
    sel[5] = Handler.revoke.selector;
    sel[6] = Handler.transfer.selector;
    sel[7] = Handler.approve.selector;
    targetSelector(FuzzSelector({ addr: address(handler), selectors: sel }));
    targetContract(address(handler));
  }

  function invariant_1_feeWalletEqualsSumOfFloorFees() public view {
    for (uint256 i; i < toks.length; i++) {
      assertEq(IERC20(toks[i]).balanceOf(FEE_WALLET) - fee0[toks[i]], handler.ghostFees(toks[i]), "fee wallet != sum of floor fees");
    }
  }

  function invariant_2_contractHoldsNoTokens() public view {
    for (uint256 i; i < toks.length; i++) assertEq(IERC20(toks[i]).balanceOf(address(swapC)), 0, "contract holds tokens");
  }

  function invariant_3_usedNonceNeverFreed() public view {
    uint256 n = handler.usedCount();
    for (uint256 i; i < n; i++) {
      (address who, uint256 nonce) = handler.usedAt(i);
      assertTrue(swapC.nonceUsed(who, nonce), "used nonce became free");
    }
  }

  /// Not an invariant: shows the run exercised successful and failed fills (printed with -vv).
  function afterInvariant() external {
    emit log_named_uint("fills", handler.fills());
    emit log_named_uint("failed fills", handler.failedFills());
    emit log_named_uint("used nonces tracked", handler.usedCount());
    for (uint256 i; i < handler.failKindsCount(); i++) {
      bytes4 k = handler.failKinds(i);
      emit log_named_bytes32("failure selector", bytes32(k));
      emit log_named_uint("  count", handler.failReasons(k));
    }
  }
}
