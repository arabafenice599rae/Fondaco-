// SPDX-License-Identifier: MIT
pragma solidity 0.8.23;

import { CommonBase } from "forge-std/Base.sol";
import { StdCheats } from "forge-std/StdCheats.sol";
import { StdUtils } from "forge-std/StdUtils.sol";
import { ISwapERC20, IERC20 } from "../utils/Interfaces.sol";

/// Random actions against the UNMODIFIED SwapERC20 fixture, with ghost accounting the invariants compare against.
/// The handler deployed the contract, so it is the owner (setProtocolFee).
contract Handler is CommonBase, StdCheats, StdUtils {
  ISwapERC20 public swapC;
  address public immutable feeWallet;
  address[] public tokens;
  uint256[] internal signerPks;
  uint256[] internal delegatePks;
  address[] internal takers;

  // ghosts
  mapping(address => uint256) public ghostFees; // token => sum of floor(signerAmount * fee / 10000) over successful fills
  struct Used { address signatory; uint256 nonce; }
  Used[] internal used;
  mapping(bytes32 => bool) internal seenUsed;
  mapping(bytes4 => uint256) public calls;
  uint256 public fills;
  uint256 public failedFills;
  mapping(bytes4 => uint256) public failReasons;
  bytes4[] public failKinds;

  /// @param creationCode fixture bytecode + constructor args: deployed from here, so the handler is the owner
  constructor(bytes memory creationCode, address fw, address[] memory toks) {
    address deployed;
    assembly { deployed := create(0, add(creationCode, 0x20), mload(creationCode)) }
    require(deployed != address(0), "deploy fixture");
    swapC = ISwapERC20(deployed);
    feeWallet = fw;
    tokens = toks;
    for (uint256 i = 1; i <= 3; i++) {
      signerPks.push(0x5000 + i);
      delegatePks.push(0xD000 + i);
      takers.push(address(uint160(0x7A0000 + i)));
    }
  }

  // ------------------------------------------------------------ helpers
  function usedCount() external view returns (uint256) { return used.length; }
  function usedAt(uint256 i) external view returns (address, uint256) { return (used[i].signatory, used[i].nonce); }

  function _markIfUsed(address signatory, uint256 nonce) internal {
    if (!swapC.nonceUsed(signatory, nonce)) return;
    bytes32 k = keccak256(abi.encode(signatory, nonce));
    if (seenUsed[k]) return;
    seenUsed[k] = true;
    used.push(Used(signatory, nonce));
  }

  function _digest(Leg memory l, address senderWallet, uint256 expiry) internal view returns (bytes32) {
    bytes32 h = keccak256(abi.encode(swapC.ORDER_TYPEHASH(), l.nonce, expiry, l.signer, l.sToken, l.sAmt, swapC.protocolFee(), senderWallet, l.rToken, l.rAmt));
    return keccak256(abi.encodePacked("\x19\x01", swapC.DOMAIN_SEPARATOR(), h));
  }

  function _approve(address owner_, address token, address spender, uint256 amount) internal {
    vm.prank(owner_);
    (bool ok,) = token.call(abi.encodeWithSignature("approve(address,uint256)", spender, amount));
    ok; // USDT reverts when changing a non-zero allowance to another non-zero value: that is part of the randomness
  }

  struct Leg { uint256 si; address signer; address taker; address sToken; address rToken; uint256 sAmt; uint256 rAmt; uint256 nonce; }

  /// the fuzzer favours edge values (0, 1, max): spread every seed before slicing it into choices
  function _mix(uint256 seed) internal pure returns (uint256) { return uint256(keccak256(abi.encode(seed))); }

  function _leg(uint256 seed, uint256 sAmt, uint256 rAmt, uint256 nonce) internal view returns (Leg memory l) {
    l.si = seed % signerPks.length;
    l.signer = vm.addr(signerPks[l.si]);
    l.taker = takers[(seed >> 8) % takers.length];
    uint256 a = (seed >> 16) % tokens.length;
    uint256 b = (a + 1 + ((seed >> 24) % (tokens.length - 1))) % tokens.length;
    l.sToken = tokens[a];
    l.rToken = tokens[b];
    l.sAmt = _bound(sAmt, 1, 1e24);
    l.rAmt = _bound(rAmt, 1, 1e24);
    l.nonce = _bound(nonce, 0, 600); // small range: reuse and word boundaries happen
  }

  /// signs with the signer's own key or with its delegate key (only one of them is valid at a time)
  function _sig(Leg memory l, uint256 seed, address senderWallet, uint256 expiry) internal view returns (uint8 v, bytes32 r, bytes32 s) {
    bool delegated = swapC.authorized(l.signer) != address(0);
    bool right = (seed >> 32) % 5 != 0; // 80%: the key that is valid right now; 20%: the other one (must fail)
    uint256 pk = delegated == right ? delegatePks[l.si] : signerPks[l.si];
    (v, r, s) = vm.sign(pk, _digest(l, senderWallet, expiry));
  }

  function _fund(Leg memory l, uint256 seed) internal {
    uint256 fee = (l.sAmt * swapC.protocolFee()) / 10000;
    // mostly funded, sometimes not (exercises SignerBalanceLow / TransferFromFailed paths)
    if ((seed >> 40) % 5 != 0) deal(l.sToken, l.signer, IERC20(l.sToken).balanceOf(l.signer) + l.sAmt + fee);
    if ((seed >> 44) % 4 != 0) _approve(l.signer, l.sToken, address(swapC), 0);
    _approve(l.signer, l.sToken, address(swapC), type(uint256).max);
    deal(l.rToken, l.taker, l.rAmt);
    _approve(l.taker, l.rToken, address(swapC), 0);
    _approve(l.taker, l.rToken, address(swapC), type(uint256).max);
  }

  function _signatory(address signer) internal view returns (address) {
    address d = swapC.authorized(signer);
    return d == address(0) ? signer : d;
  }

  function _fail(bytes memory err) internal {
    bytes4 k = err.length >= 4 ? bytes4(err) : bytes4(0);
    if (failReasons[k]++ == 0) failKinds.push(k);
  }
  function failKindsCount() external view returns (uint256) { return failKinds.length; }

  function _afterFill(bool ok, Leg memory l, address signatory, uint256 feeAtFill) internal {
    if (ok) {
      fills++;
      ghostFees[l.sToken] += (l.sAmt * feeAtFill) / 10000;
    } else failedFills++;
    _markIfUsed(signatory, l.nonce);
    _markIfUsed(l.signer, l.nonce);
  }

  // ------------------------------------------------------------ actions
  function fillPublic(uint256 seed, uint256 sAmt, uint256 rAmt, uint256 nonce) external {
    seed = _mix(seed);
    calls[this.fillPublic.selector]++;
    Leg memory l = _leg(seed, sAmt, rAmt, nonce);
    _fund(l, seed);
    uint256 expiry = block.timestamp + 3600;
    (uint8 v, bytes32 r, bytes32 s) = _sig(l, seed, address(0), expiry);
    address signatory = _signatory(l.signer);
    uint256 fee = swapC.protocolFee();
    vm.prank(l.taker);
    try swapC.swapAnySender(l.taker, l.nonce, expiry, l.signer, l.sToken, l.sAmt, l.rToken, l.rAmt, v, r, s) { _afterFill(true, l, signatory, fee); }
    catch (bytes memory err) { _fail(err); _afterFill(false, l, signatory, fee); }
  }

  function fillPrivate(uint256 seed, uint256 sAmt, uint256 rAmt, uint256 nonce) external {
    seed = _mix(seed);
    calls[this.fillPrivate.selector]++;
    Leg memory l = _leg(seed, sAmt, rAmt, nonce);
    _fund(l, seed);
    uint256 expiry = block.timestamp + 3600;
    (uint8 v, bytes32 r, bytes32 s) = _sig(l, seed, l.taker, expiry);
    address signatory = _signatory(l.signer);
    uint256 fee = swapC.protocolFee();
    vm.prank(l.taker);
    try swapC.swap(l.taker, l.nonce, expiry, l.signer, l.sToken, l.sAmt, l.rToken, l.rAmt, v, r, s) { _afterFill(true, l, signatory, fee); }
    catch (bytes memory err) { _fail(err); _afterFill(false, l, signatory, fee); }
  }

  function cancel(uint256 seed, uint256 n1, uint256 n2) external {
    seed = _mix(seed);
    calls[this.cancel.selector]++;
    address who = (seed >> 8) % 2 == 0 ? vm.addr(signerPks[seed % 3]) : vm.addr(delegatePks[seed % 3]);
    uint256[] memory ns = new uint256[](2);
    ns[0] = _bound(n1, 0, 600);
    ns[1] = _bound(n2, 0, 600);
    vm.prank(who);
    swapC.cancel(ns);
    _markIfUsed(who, ns[0]);
    _markIfUsed(who, ns[1]);
  }

  function setProtocolFee(uint256 fee) external {
    calls[this.setProtocolFee.selector]++;
    swapC.setProtocolFee(bound(fee, 0, 9999));
  }

  function authorize(uint256 seed) external {
    calls[this.authorize.selector]++;
    uint256 i = seed % 3;
    vm.prank(vm.addr(signerPks[i]));
    swapC.authorize(vm.addr(delegatePks[i]));
  }

  function revoke(uint256 seed) external {
    calls[this.revoke.selector]++;
    vm.prank(vm.addr(signerPks[seed % 3]));
    swapC.revoke();
  }

  /// signer moves funds away (never to the fee wallet, never to the contract)
  function transfer(uint256 seed, uint256 amount) external {
    seed = _mix(seed);
    calls[this.transfer.selector]++;
    address from = vm.addr(signerPks[seed % 3]);
    address token = tokens[(seed >> 8) % tokens.length];
    address to = takers[(seed >> 16) % takers.length];
    uint256 bal = IERC20(token).balanceOf(from);
    if (bal == 0) return;
    vm.prank(from);
    (bool ok,) = token.call(abi.encodeWithSignature("transfer(address,uint256)", to, _bound(amount, 1, bal)));
    ok;
  }

  /// signer changes its allowance to the contract (possibly below what its orders need)
  function approve(uint256 seed, uint256 amount) external {
    seed = _mix(seed);
    calls[this.approve.selector]++;
    address from = vm.addr(signerPks[seed % 3]);
    address token = tokens[(seed >> 8) % tokens.length];
    _approve(from, token, address(swapC), 0);
    _approve(from, token, address(swapC), _bound(amount, 0, 1e25));
  }
}
