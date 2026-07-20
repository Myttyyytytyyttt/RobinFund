// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

/// @title FundRegistry — índice on-chain de fondos desplegados (SPEC §12)
/// @notice El keeper y el frontend enumeran los fondos desde aquí. Los fondos NO se despliegan desde
/// un contrato: `new Fund(...)` embebe el creation code del Fund (~38KB) en el runtime del que lo
/// llame, superando el límite EIP-170 (24.5KB). Por eso en v1 el operador despliega cada Fund en una
/// tx directa (initcode 38KB < 49KB EIP-3860) y lo registra aquí. El gate de elegibilidad del manager
/// vive en el propio constructor del Fund. (v2: factory permissionless con clones ERC-1167 + initialize.)
contract FundRegistry {
    address public owner; // operador que despliega y registra fondos (→ Guardian)
    address public pendingOwner;

    address[] public funds;
    mapping(address => bool) public isFund;
    mapping(address => address[]) public fundsByManager;

    event FundRegistered(address indexed fund, address indexed manager);
    event OwnershipTransferStarted(address indexed to);
    event OwnershipTransferred(address indexed to);

    error NotOwner();
    error ZeroAddress();
    error AlreadyRegistered();

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    constructor() {
        owner = msg.sender;
    }

    function register(address fund, address manager) external onlyOwner {
        if (fund == address(0) || manager == address(0)) revert ZeroAddress();
        if (isFund[fund]) revert AlreadyRegistered();
        isFund[fund] = true;
        funds.push(fund);
        fundsByManager[manager].push(fund);
        emit FundRegistered(fund, manager);
    }

    function fundCount() external view returns (uint256) {
        return funds.length;
    }

    function managerFundCount(address manager) external view returns (uint256) {
        return fundsByManager[manager].length;
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
