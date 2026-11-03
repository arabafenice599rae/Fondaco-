// SPDX-License-Identifier: MIT
pragma solidity 0.8.23;

/// Minimal cheatcode interface (subset of Foundry's Vm), written here to avoid vendoring third-party test libraries.
interface Vm {
  struct Log { bytes32[] topics; bytes data; address emitter; }
  function addr(uint256 privateKey) external pure returns (address);
  function sign(uint256 privateKey, bytes32 digest) external pure returns (uint8 v, bytes32 r, bytes32 s);
  function prank(address sender) external;
  function startPrank(address sender) external;
  function stopPrank() external;
  function store(address target, bytes32 slot, bytes32 value) external;
  function load(address target, bytes32 slot) external view returns (bytes32);
  function warp(uint256 timestamp) external;
  function chainId(uint256 newChainId) external;
  function readFile(string calldata path) external view returns (string memory);
  function parseJsonBytes(string calldata json, string calldata key) external pure returns (bytes memory);
  function parseJsonUint(string calldata json, string calldata key) external pure returns (uint256);
  function expectRevert(bytes calldata revertData) external;
  function expectRevert(bytes4 revertData) external;
  function assume(bool condition) external pure;
  function recordLogs() external;
  function getRecordedLogs() external returns (Log[] memory);
  function label(address account, string calldata newLabel) external;
}
