// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

/// @title FundShare — shares del fondo, NO transferibles (SPEC D7)
/// @notice Solo mint/burn por el Fund vía colas a NAV. La no-transferibilidad es la garantía
/// práctica de la Condición 28 del prospecto RHJ (sin fuga del gating de elegibilidad) y
/// mata la reventa de acceso social. `balanceOf` es la fuente del gating social (§11).
contract FundShare {
    string public name;
    string public symbol;
    uint8 public constant decimals = 18;

    address public immutable FUND;
    uint256 public totalSupply;
    mapping(address => uint256) public balanceOf;

    event Transfer(address indexed from, address indexed to, uint256 value); // solo mint/burn (from/to = 0)

    error NotFund();
    error NonTransferable();

    modifier onlyFund() {
        if (msg.sender != FUND) revert NotFund();
        _;
    }

    constructor(string memory name_, string memory symbol_, address fund_) {
        name = name_;
        symbol = symbol_;
        FUND = fund_;
    }

    function mint(address to, uint256 amount) external onlyFund {
        totalSupply += amount;
        balanceOf[to] += amount;
        emit Transfer(address(0), to, amount);
    }

    function burn(address from, uint256 amount) external onlyFund {
        balanceOf[from] -= amount;
        totalSupply -= amount;
        emit Transfer(from, address(0), amount);
    }

    // --- ERC-20 deshabilitado deliberadamente (D7) ---

    function transfer(address, uint256) external pure returns (bool) {
        revert NonTransferable();
    }

    function transferFrom(address, address, uint256) external pure returns (bool) {
        revert NonTransferable();
    }

    function approve(address, uint256) external pure returns (bool) {
        revert NonTransferable();
    }

    function allowance(address, address) external pure returns (uint256) {
        return 0;
    }
}
