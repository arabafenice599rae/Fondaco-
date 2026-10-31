// SPDX-License-Identifier: MIT
pragma solidity 0.8.23;

import { Base } from "./utils/Base.sol";
import { ISwapERC20, IERC20 } from "./utils/Interfaces.sol";

/// TEST-ONLY smart wallet (EIP-1271): its owner approves order digests, and can withdraw an approval at any time,
/// like a Safe whose owners change. Not production code.
contract MockSmartWallet {
  address public immutable owner;
  mapping(bytes32 => bool) public approved;
  constructor(address o) { owner = o; }
  function setApproved(bytes32 h, bool v) external { require(msg.sender == owner, "owner"); approved[h] = v; }
  function exec(address to, bytes calldata data) external { require(msg.sender == owner, "owner"); (bool s,) = to.call(data); require(s, "exec"); }
  function isValidSignature(bytes32 h, bytes calldata sig) external view returns (bytes4) {
    return approved[h] && sig.length == 65 ? bytes4(0x1626ba7e) : bytes4(0xffffffff);
  }
}

/// Case (f): an EIP-1271 wallet that accepts a signature and then withdraws it. The contract re-asks the wallet at
/// every check()/swap, so the book must re-check contract signers on every revalidation (it does: contract_signer orders
/// go through check() in each snapshot).
contract ERC1271Test is Base {
  function test_acceptThenRevoke() public {
    MockSmartWallet w = new MockSmartWallet(address(this));
    Order memory o = order(address(w), 1, USDC, 1000e6, WETH, 4e17);
    (o.v, o.r, o.s) = (27, bytes32(uint256(1)), bytes32(uint256(2))); // 65-byte placeholder: validity comes from the wallet
    bytes32 h = digest(o);

    uint256 fee = (o.signerAmount * FEE) / 10000;
    setBalance(USDC, address(w), o.signerAmount + fee);
    w.exec(USDC, abi.encodeWithSignature("approve(address,uint256)", address(swapC), type(uint256).max));
    setBalance(WETH, bob, o.senderAmount);
    approve(bob, WETH, address(swapC), type(uint256).max);

    ok(hasError(checkErrors(o), "SignatureInvalid"), "not approved yet -> invalid");
    w.setApproved(h, true);
    eq(checkErrors(o).length, 0, "approved by the wallet -> valid");
    w.setApproved(h, false);
    ok(hasError(checkErrors(o), "SignatureInvalid"), "approval withdrawn -> invalid again");
    vm.expectRevert(ISwapERC20.SignatureInvalid.selector);
    fillAny(bob, bob, o);

    w.setApproved(h, true);
    fillAny(bob, bob, o);
    eq(IERC20(WETH).balanceOf(address(w)), o.senderAmount, "smart wallet received senderAmount");
    eq(IERC20(USDC).balanceOf(feeWallet), fee, "fee paid by the smart wallet signer");
  }
}
