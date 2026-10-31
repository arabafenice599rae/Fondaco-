// SPDX-License-Identifier: MIT
pragma solidity 0.8.23;

import { Vm } from "./Vm.sol";
import { ISwapERC20, IERC20 } from "./Interfaces.sol";

/// Shared setup: checks the fork block, deploys the fixture bytecode (unmodified), signs orders, funds wallets.
abstract contract Base {
  Vm internal constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));

  address internal constant USDC = 0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48;
  address internal constant USDT = 0xdAC17F958D2ee523a2206206994597C13D831ec7;
  address internal constant WETH = 0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2;
  uint256 internal constant FEE = 30;
  uint256 internal constant SECP256K1_N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141;

  ISwapERC20 internal swapC;
  address internal feeWallet = address(0xFee0000000000000000000000000000000000001);
  uint256 internal alicePk = 0xA11CE;
  uint256 internal bobPk = 0xB0B;
  address internal alice;
  address internal bob;

  struct Order {
    uint256 nonce; uint256 expiry; address signerWallet; address signerToken; uint256 signerAmount; uint256 protocolFee;
    address senderWallet; address senderToken; uint256 senderAmount; uint8 v; bytes32 r; bytes32 s;
  }

  error Mismatch(string what, uint256 got, uint256 want);
  error Failed(string what);

  function setUp() public virtual {
    string memory cfg = vm.readFile("../../fork.config.json");
    uint256 forkBlock = vm.parseJsonUint(cfg, ".forkBlock");
    // the runner forks anvil (itself pinned at forkBlock); forge's fork starts at the head of that node
    if (block.number < forkBlock) revert Mismatch("fork block", block.number, forkBlock);
    if (block.chainid != 1) revert Mismatch("chain id", block.chainid, 1);

    string memory art = vm.readFile("./fixtures/SwapERC20.json");
    bytes memory code = abi.encodePacked(vm.parseJsonBytes(art, ".bytecode"), abi.encode(FEE, FEE, feeWallet, uint256(0), uint256(0)));
    address deployed;
    assembly { deployed := create(0, add(code, 0x20), mload(code)) }
    if (deployed == address(0)) revert Failed("deploy fixture");
    swapC = ISwapERC20(deployed);
    alice = vm.addr(alicePk);
    bob = vm.addr(bobPk);
    vm.label(deployed, "SwapERC20");
    vm.label(alice, "alice");
    vm.label(bob, "bob");

    // independent recomputation of the EIP-712 domain: name SWAP_ERC20, version 4.3
    bytes32 expected = keccak256(abi.encode(
      keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
      keccak256("SWAP_ERC20"), keccak256("4.3"), block.chainid, deployed));
    if (swapC.DOMAIN_SEPARATOR() != expected) revert Failed("DOMAIN_SEPARATOR");
    if (swapC.ORDER_TYPEHASH() != keccak256("OrderERC20(uint256 nonce,uint256 expiry,address signerWallet,address signerToken,uint256 signerAmount,uint256 protocolFee,address senderWallet,address senderToken,uint256 senderAmount)")) revert Failed("ORDER_TYPEHASH");
  }

  // ------------------------------------------------------------ helpers
  function bound(uint256 x, uint256 lo, uint256 hi) internal pure returns (uint256) {
    if (hi <= lo) return lo;
    return lo + (x % (hi - lo + 1));
  }

  function eq(uint256 got, uint256 want, string memory what) internal pure { if (got != want) revert Mismatch(what, got, want); }
  function ok(bool c, string memory what) internal pure { if (!c) revert Failed(what); }

  function balanceSlot(address token) internal pure returns (uint256) {
    if (token == USDC) return 9;
    if (token == USDT) return 2;
    if (token == WETH) return 3;
    revert Failed("unknown token layout");
  }

  /// Set an exact balance by writing the token's balance mapping (USDC v2.2 keeps a blacklist flag in the top bit: amounts < 2^255).
  function setBalance(address token, address holder, uint256 amount) internal {
    vm.store(token, keccak256(abi.encode(holder, balanceSlot(token))), bytes32(amount));
    eq(IERC20(token).balanceOf(holder), amount, "balance write");
  }

  /// approve() through a low-level call: USDT returns no value.
  function approve(address owner_, address token, address spender, uint256 amount) internal {
    vm.prank(owner_);
    (bool success,) = token.call(abi.encodeWithSignature("approve(address,uint256)", spender, amount));
    ok(success, "approve");
  }

  function digest(Order memory o) internal view returns (bytes32) {
    bytes32 structHash = keccak256(abi.encode(swapC.ORDER_TYPEHASH(), o.nonce, o.expiry, o.signerWallet, o.signerToken, o.signerAmount,
      o.protocolFee, o.senderWallet, o.senderToken, o.senderAmount));
    return keccak256(abi.encodePacked("\x19\x01", swapC.DOMAIN_SEPARATOR(), structHash));
  }

  function order(address signerWallet, uint256 nonce, address signerToken, uint256 signerAmount, address senderToken, uint256 senderAmount)
    internal view returns (Order memory o)
  {
    o = Order(nonce, block.timestamp + 3600, signerWallet, signerToken, signerAmount, swapC.protocolFee(), address(0), senderToken, senderAmount, 0, 0, 0);
  }

  function sign(uint256 pk, Order memory o) internal view returns (Order memory) {
    (o.v, o.r, o.s) = vm.sign(pk, digest(o));
    return o;
  }

  function fillAny(address taker, address recipient, Order memory o) internal {
    vm.prank(taker);
    swapC.swapAnySender(recipient, o.nonce, o.expiry, o.signerWallet, o.signerToken, o.signerAmount, o.senderToken, o.senderAmount, o.v, o.r, o.s);
  }

  function checkErrors(Order memory o) internal view returns (bytes32[] memory) {
    return swapC.check(o.senderWallet, o.nonce, o.expiry, o.signerWallet, o.signerToken, o.signerAmount, o.senderToken, o.senderAmount, o.v, o.r, o.s);
  }

  function hasError(bytes32[] memory errs, bytes32 name) internal pure returns (bool) {
    for (uint256 i; i < errs.length; i++) if (errs[i] == name) return true;
    return false;
  }

  /// Fund and approve the signer for signerAmount + fee, the taker for senderAmount.
  function fund(Order memory o, address taker) internal {
    uint256 fee = (o.signerAmount * swapC.protocolFee()) / 10000;
    setBalance(o.signerToken, o.signerWallet, o.signerAmount + fee);
    approve(o.signerWallet, o.signerToken, address(swapC), type(uint256).max);
    setBalance(o.senderToken, taker, o.senderAmount);
    approve(taker, o.senderToken, address(swapC), type(uint256).max);
  }
}
