// SPDX-License-Identifier: MIT
pragma solidity 0.8.23;

/// The subset of SwapERC20 (AirSwap tag v4.3) used by the tests. Signatures checked against fixtures/SwapERC20.json (a mismatch reverts).
interface ISwapERC20 {
  error ChainIdChanged();
  error InvalidFee();
  error InvalidFeeLight();
  error InvalidFeeWallet();
  error InvalidStaking();
  error NonceAlreadyUsed(uint256);
  error OrderExpired();
  error SignatureInvalid();
  error SignatoryInvalid();
  error Unauthorized();
  event SwapERC20(uint256 indexed nonce, address indexed signerWallet);
  event Cancel(uint256 indexed nonce, address indexed signerWallet);

  function swap(address recipient, uint256 nonce, uint256 expiry, address signerWallet, address signerToken, uint256 signerAmount,
    address senderToken, uint256 senderAmount, uint8 v, bytes32 r, bytes32 s) external;
  function swapAnySender(address recipient, uint256 nonce, uint256 expiry, address signerWallet, address signerToken, uint256 signerAmount,
    address senderToken, uint256 senderAmount, uint8 v, bytes32 r, bytes32 s) external;
  function swapLight(uint256 nonce, uint256 expiry, address signerWallet, address signerToken, uint256 signerAmount,
    address senderToken, uint256 senderAmount, uint8 v, bytes32 r, bytes32 s) external;
  function check(address senderWallet, uint256 nonce, uint256 expiry, address signerWallet, address signerToken, uint256 signerAmount,
    address senderToken, uint256 senderAmount, uint8 v, bytes32 r, bytes32 s) external view returns (bytes32[] memory);
  function cancel(uint256[] calldata nonces) external;
  function nonceUsed(address signer, uint256 nonce) external view returns (bool);
  function authorize(address signatory) external;
  function revoke() external;
  function authorized(address) external view returns (address);
  function setProtocolFee(uint256) external;
  function setProtocolFeeLight(uint256) external;
  function setProtocolFeeWallet(address) external;
  function setStaking(address) external;
  function DOMAIN_CHAIN_ID() external view returns (uint256);
  function protocolFee() external view returns (uint256);
  function protocolFeeWallet() external view returns (address);
  function owner() external view returns (address);
  function DOMAIN_SEPARATOR() external view returns (bytes32);
  function ORDER_TYPEHASH() external view returns (bytes32);
}

interface IERC20 {
  function balanceOf(address) external view returns (uint256);
  function allowance(address, address) external view returns (uint256);
}
