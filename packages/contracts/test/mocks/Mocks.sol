// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

/// @notice Mock del access-controls registry de RHJ — también hace de beacon (como el real, verificado).
contract MockAccessRegistry {
    mapping(address => bool) internal _blocked;
    bool internal _paused;
    address public implementation;
    bool public revertAll; // simula un registry migrado/roto (F1 PoC 5)

    constructor() {
        implementation = address(0xBEEF);
    }

    function isBlocked(address a) external view returns (bool) {
        require(!revertAll, "registry roto");
        return _blocked[a];
    }

    function paused() external view returns (bool) {
        require(!revertAll, "registry roto");
        return _paused;
    }

    function pausedRaw() external view returns (bool) {
        return _paused;
    }

    function setBlocked(address a, bool v) external {
        _blocked[a] = v;
    }

    function setPaused(bool v) external {
        _paused = v;
    }

    function setImplementation(address i) external {
        implementation = i;
    }

    function setRevertAll(bool v) external {
        revertAll = v;
    }
}

/// @notice Mock de Stock Token RHJ: ERC20 mínimo + superficie ERC-8056/pausas verificada en Fase 0.
/// Interruptores de revert y modo "decoupled" para aislar cada check de NAVLib (revisión F3/F8).
contract MockStockToken {
    string public symbol;
    uint8 public constant decimals = 18;
    uint256 public totalSupply;
    mapping(address => uint256) internal _bal;
    mapping(address => mapping(address => uint256)) public allowance;

    MockAccessRegistry public immutable registry;
    uint256 public uiMultiplier = 1e18;
    bool public tokenPausedFlag;
    bool public oraclePausedFlag;
    bool public decoupledPaused; // si true, paused() NO incluye tokenPaused (aísla el check F3)
    bool public revertPaused; // upgrade hostil: paused() revierte (F1 PoC 1)
    bool public revertBalanceOf;

    constructor(string memory sym, MockAccessRegistry reg) {
        symbol = sym;
        registry = reg;
    }

    // --- Superficie RHJ ---
    function ACCESS_CONTROLLED_REGISTRY() external view returns (address) {
        return address(registry);
    }

    function paused() public view returns (bool) {
        require(!revertPaused, "upgrade hostil");
        if (decoupledPaused) return registry.pausedRaw();
        return tokenPausedFlag || registry.pausedRaw();
    }

    function tokenPaused() external view returns (bool) {
        require(!revertPaused, "upgrade hostil");
        return tokenPausedFlag;
    }

    function oraclePaused() external view returns (bool) {
        require(!revertPaused, "upgrade hostil");
        return oraclePausedFlag;
    }

    function setTokenPaused(bool v) external {
        tokenPausedFlag = v;
    }

    function setOraclePaused(bool v) external {
        oraclePausedFlag = v;
    }

    function setDecoupledPaused(bool v) external {
        decoupledPaused = v;
    }

    function setRevertPaused(bool v) external {
        revertPaused = v;
    }

    function setRevertBalanceOf(bool v) external {
        revertBalanceOf = v;
    }

    function setUiMultiplier(uint256 m) external {
        uiMultiplier = m;
    }

    // --- ERC20 mínimo ---
    function balanceOf(address a) external view returns (uint256) {
        require(!revertBalanceOf, "upgrade hostil");
        return _bal[a];
    }

    function mint(address to, uint256 amt) external {
        _bal[to] += amt;
        totalSupply += amt;
    }

    function transfer(address to, uint256 amt) external returns (bool) {
        _bal[msg.sender] -= amt;
        _bal[to] += amt;
        return true;
    }

    function approve(address s, uint256 amt) external returns (bool) {
        allowance[msg.sender][s] = amt;
        return true;
    }

    function transferFrom(address f, address t, uint256 amt) external returns (bool) {
        allowance[f][msg.sender] -= amt;
        _bal[f] -= amt;
        _bal[t] += amt;
        return true;
    }
}

/// @notice Mock ERC20 6 decimales (USDG).
contract MockUSDG {
    string public constant symbol = "USDG";
    uint8 public constant decimals = 6;
    uint256 public totalSupply;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    function mint(address to, uint256 amt) external {
        balanceOf[to] += amt;
        totalSupply += amt;
    }

    function transfer(address to, uint256 amt) external returns (bool) {
        balanceOf[msg.sender] -= amt;
        balanceOf[to] += amt;
        return true;
    }

    function approve(address s, uint256 amt) external returns (bool) {
        allowance[msg.sender][s] = amt;
        return true;
    }

    function transferFrom(address f, address t, uint256 amt) external returns (bool) {
        allowance[f][msg.sender] -= amt;
        balanceOf[f] -= amt;
        balanceOf[t] += amt;
        return true;
    }
}

/// @notice Mock de feed Chainlink 8 dec con precio/timestamp controlables e interruptor de revert.
contract MockFeed {
    uint8 public constant decimals = 8;
    int256 public answer;
    uint256 public updatedAt;
    uint80 public roundId = 1;
    bool public revertOn; // feed deprecado (F1 PoC 3)

    constructor(int256 a) {
        answer = a;
        updatedAt = block.timestamp;
    }

    function set(int256 a, uint256 ts) external {
        answer = a;
        updatedAt = ts;
        roundId++;
    }

    function setRevert(bool v) external {
        revertOn = v;
    }

    function latestRoundData() external view returns (uint80, int256, uint256, uint256, uint80) {
        require(!revertOn, "feed deprecado");
        return (roundId, answer, updatedAt, updatedAt, roundId);
    }
}
