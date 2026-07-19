// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

/// @notice Mock del access-controls registry de RHJ — también hace de beacon (como el real).
contract MockAccessRegistry {
    mapping(address => bool) public isBlocked;
    bool public paused;
    address public implementation;

    constructor() {
        implementation = address(0xBEEF);
    }

    function setBlocked(address a, bool v) external {
        isBlocked[a] = v;
    }

    function setPaused(bool v) external {
        paused = v;
    }

    function setImplementation(address i) external {
        implementation = i;
    }
}

/// @notice Mock de Stock Token RHJ: ERC20 mínimo + superficie ERC-8056/pausas verificada en Fase 0.
contract MockStockToken {
    string public symbol;
    uint8 public constant decimals = 18;
    uint256 public totalSupply;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    MockAccessRegistry public immutable registry;
    uint256 public uiMultiplier = 1e18;
    bool public tokenPaused;
    bool public oraclePaused;

    constructor(string memory sym, MockAccessRegistry reg) {
        symbol = sym;
        registry = reg;
    }

    // Superficie RHJ
    function ACCESS_CONTROLLED_REGISTRY() external view returns (address) {
        return address(registry);
    }

    function paused() public view returns (bool) {
        return tokenPaused || registry.paused();
    }

    function setTokenPaused(bool v) external {
        tokenPaused = v;
    }

    function setOraclePaused(bool v) external {
        oraclePaused = v;
    }

    function setUiMultiplier(uint256 m) external {
        uiMultiplier = m;
    }

    // ERC20 mínimo (con chequeo de blocked como el real)
    function mint(address to, uint256 amt) external {
        balanceOf[to] += amt;
        totalSupply += amt;
    }

    function transfer(address to, uint256 amt) external returns (bool) {
        require(!paused() && !registry.isBlocked(msg.sender) && !registry.isBlocked(to), "blocked/paused");
        balanceOf[msg.sender] -= amt;
        balanceOf[to] += amt;
        return true;
    }

    function approve(address s, uint256 amt) external returns (bool) {
        allowance[msg.sender][s] = amt;
        return true;
    }

    function transferFrom(address f, address t, uint256 amt) external returns (bool) {
        require(!paused() && !registry.isBlocked(f) && !registry.isBlocked(t), "blocked/paused");
        allowance[f][msg.sender] -= amt;
        balanceOf[f] -= amt;
        balanceOf[t] += amt;
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

/// @notice Mock de feed Chainlink 8 dec con precio y timestamp controlables.
contract MockFeed {
    uint8 public constant decimals = 8;
    int256 public answer;
    uint256 public updatedAt;
    uint80 public roundId = 1;

    constructor(int256 a) {
        answer = a;
        updatedAt = block.timestamp;
    }

    function set(int256 a, uint256 ts) external {
        answer = a;
        updatedAt = ts;
        roundId++;
    }

    function latestRoundData() external view returns (uint80, int256, uint256, uint256, uint80) {
        return (roundId, answer, updatedAt, updatedAt, roundId);
    }
}
