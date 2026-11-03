// SPDX-License-Identifier: MIT
pragma solidity 0.8.23;

import { Base } from "./utils/Base.sol";
import { ISwapERC20 } from "./utils/Interfaces.sol";

/// Parameter validation of v4.3, by error name: constructor and owner setters (the test contract deployed the fixture,
/// so it is the owner). v5.0.0 renamed these errors (ProtocolFee*Invalid, StakingInvalid): see docs/AUDIT-DIFF.md.
contract ErrorsTest is Base {
  /// Deploy the fixture with these constructor arguments; returns the revert selector (0 if it deployed).
  function deployWith(uint256 fee, uint256 feeLight, address wallet) internal returns (bytes4 sel) {
    string memory art = vm.readFile("./fixtures/SwapERC20.json");
    bytes memory code = abi.encodePacked(vm.parseJsonBytes(art, ".bytecode"), abi.encode(fee, feeLight, wallet, uint256(0), uint256(0)));
    address d;
    bytes memory ret;
    assembly {
      d := create(0, add(code, 0x20), mload(code))
      let n := returndatasize()
      ret := mload(0x40)
      mstore(ret, n)
      returndatacopy(add(ret, 0x20), 0, n)
      mstore(0x40, add(add(ret, 0x20), n))
    }
    if (d != address(0)) return bytes4(0);
    ok(ret.length >= 4, "revert data");
    sel = bytes4(ret);
  }

  function test_constructorValidation() public {
    ok(deployWith(10000, 30, feeWallet) == ISwapERC20.InvalidFee.selector, "fee = divisor -> InvalidFee");
    ok(deployWith(30, 10000, feeWallet) == ISwapERC20.InvalidFeeLight.selector, "feeLight = divisor -> InvalidFeeLight");
    ok(deployWith(30, 30, address(0)) == ISwapERC20.InvalidFeeWallet.selector, "fee wallet 0 -> InvalidFeeWallet");
    ok(deployWith(9999, 9999, feeWallet) == bytes4(0), "9999 bps is accepted");
  }

  function test_setterValidation() public {
    vm.expectRevert(ISwapERC20.InvalidFee.selector);
    swapC.setProtocolFee(10000);
    vm.expectRevert(ISwapERC20.InvalidFeeLight.selector);
    swapC.setProtocolFeeLight(10000);
    vm.expectRevert(ISwapERC20.InvalidFeeWallet.selector);
    swapC.setProtocolFeeWallet(address(0));
    vm.expectRevert(ISwapERC20.InvalidStaking.selector);
    swapC.setStaking(address(0));
    swapC.setProtocolFee(9999);
    eq(swapC.protocolFee(), 9999, "valid fee set");
  }
}
