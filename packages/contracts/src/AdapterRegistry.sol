// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

/// @title AdapterRegistry — venues de trading whitelisteados (SPEC §8, §12)
/// @notice Owner-gated (→ Guardian con timelock en 1.5). Los adapters son código confiable en cuanto
/// a que no roban (el Fund igualmente mide deltas y aplica slippage), pero se whitelistean para no
/// permitir calldata arbitraria a contratos cualesquiera desde el Fund.
contract AdapterRegistry {
    address public owner;
    address public pendingOwner;

    mapping(uint256 => address) public adapters; // adapterId → adapter
    mapping(uint256 => bool) public enabled;
    uint256 public count;

    event AdapterAdded(uint256 indexed id, address adapter);
    event AdapterEnabled(uint256 indexed id, bool enabled);
    event OwnershipTransferStarted(address indexed to);
    event OwnershipTransferred(address indexed to);

    error NotOwner();
    error ZeroAddress();
    error UnknownAdapter();

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    constructor() {
        owner = msg.sender;
    }

    function add(address adapter) external onlyOwner returns (uint256 id) {
        if (adapter == address(0)) revert ZeroAddress();
        id = count++;
        adapters[id] = adapter;
        enabled[id] = true;
        emit AdapterAdded(id, adapter);
    }

    function setEnabled(uint256 id, bool v) external onlyOwner {
        if (adapters[id] == address(0)) revert UnknownAdapter();
        enabled[id] = v;
        emit AdapterEnabled(id, v);
    }

    /// @notice Devuelve el adapter si está habilitado, o revierte.
    function get(uint256 id) external view returns (address a) {
        a = adapters[id];
        if (a == address(0) || !enabled[id]) revert UnknownAdapter();
    }

    function transferOwnership(address to) external onlyOwner {
        pendingOwner = to;
        emit OwnershipTransferStarted(to);
    }

    function acceptOwnership() external {
        if (msg.sender != pendingOwner) revert NotOwner();
        owner = pendingOwner;
        pendingOwner = address(0);
        emit OwnershipTransferred(owner);
    }
}
