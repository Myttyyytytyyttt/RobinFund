// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IERC20} from "../interfaces/IERC20.sol";
import {IAggregatorV3} from "../interfaces/IAggregatorV3.sol";
import {ITradeAdapter} from "../interfaces/ITradeAdapter.sol";
import {SafeTransferLib} from "../libraries/SafeTransferLib.sol";

/// @notice Base común para contratos de prueba. Un error de configuración jamás puede llevar este
/// pack a Robinhood Chain mainnet (4663).
abstract contract TestnetOwned {
    address public owner;
    address public pendingOwner;

    error MainnetForbidden();
    error NotOwner();
    error ZeroAddress();

    event OwnershipTransferStarted(address indexed pendingOwner);
    event OwnershipTransferred(address indexed owner);

    constructor() {
        if (block.chainid == 4663) revert MainnetForbidden();
        owner = msg.sender;
    }

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    function transferOwnership(address to) external onlyOwner {
        if (to == address(0)) revert ZeroAddress();
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

/// @notice ERC-20 pequeño pero completo para activos sin valor de testnet.
abstract contract TestnetERC20 is TestnetOwned {
    string public name;
    string public symbol;
    uint8 public immutable decimals;
    uint256 public totalSupply;

    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    event Transfer(address indexed from, address indexed to, uint256 amount);
    event Approval(address indexed owner, address indexed spender, uint256 amount);

    error InsufficientBalance();
    error InsufficientAllowance();

    constructor(string memory name_, string memory symbol_, uint8 decimals_) {
        name = name_;
        symbol = symbol_;
        decimals = decimals_;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        _transfer(msg.sender, to, amount);
        return true;
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        emit Approval(msg.sender, spender, amount);
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        uint256 allowed = allowance[from][msg.sender];
        if (allowed < amount) revert InsufficientAllowance();
        if (allowed != type(uint256).max) allowance[from][msg.sender] = allowed - amount;
        _transfer(from, to, amount);
        return true;
    }

    function mint(address to, uint256 amount) external onlyOwner {
        _mint(to, amount);
    }

    function burn(uint256 amount) external {
        uint256 bal = balanceOf[msg.sender];
        if (bal < amount) revert InsufficientBalance();
        balanceOf[msg.sender] = bal - amount;
        totalSupply -= amount;
        emit Transfer(msg.sender, address(0), amount);
    }

    function _mint(address to, uint256 amount) internal {
        if (to == address(0)) revert ZeroAddress();
        balanceOf[to] += amount;
        totalSupply += amount;
        emit Transfer(address(0), to, amount);
    }

    function _transfer(address from, address to, uint256 amount) internal {
        if (to == address(0)) revert ZeroAddress();
        _beforeTransfer(from, to);
        uint256 bal = balanceOf[from];
        if (bal < amount) revert InsufficientBalance();
        balanceOf[from] = bal - amount;
        balanceOf[to] += amount;
        emit Transfer(from, to, amount);
    }

    function _beforeTransfer(address from, address to) internal view virtual {}
}

/// @title TestnetUSDG — USDG sin valor para Robinhood Chain testnet
contract TestnetUSDG is TestnetERC20 {
    uint256 public constant FAUCET_AMOUNT = 100_000e6;
    uint256 public constant FAUCET_COOLDOWN = 1 days;
    mapping(address => uint256) public nextFaucetAt;

    error FaucetCooldown(uint256 availableAt);

    constructor() TestnetERC20("NuvemFund Test USDG", "tUSDG", 6) {}

    /// @notice Faucet público porque el token carece de valor. Limitado por wallet para evitar ruido.
    function faucet() external returns (uint256 amount) {
        uint256 next = nextFaucetAt[msg.sender];
        if (block.timestamp < next) revert FaucetCooldown(next);
        nextFaucetAt[msg.sender] = block.timestamp + FAUCET_COOLDOWN;
        amount = FAUCET_AMOUNT;
        _mint(msg.sender, amount);
    }
}

/// @notice Marcador de implementación para ensayar el commit y drift del beacon de RHJ.
contract TestnetStockImplementationMarker {
    error MainnetForbidden();

    constructor() {
        if (block.chainid == 4663) revert MainnetForbidden();
    }
}

/// @title TestnetAccessRegistry — blacklist default-allow + beacon de prueba
contract TestnetAccessRegistry is TestnetOwned {
    mapping(address => bool) internal _blocked;
    bool public paused;
    address public implementation;

    event BlockedSet(address indexed account, bool blocked);
    event GlobalPauseSet(bool paused);
    event ImplementationSet(address indexed implementation);

    constructor(address implementation_) {
        if (implementation_ == address(0)) revert ZeroAddress();
        implementation = implementation_;
    }

    function isBlocked(address account) external view returns (bool) {
        return _blocked[account];
    }

    function setBlocked(address account, bool blocked) external onlyOwner {
        _blocked[account] = blocked;
        emit BlockedSet(account, blocked);
    }

    function setPaused(bool value) external onlyOwner {
        paused = value;
        emit GlobalPauseSet(value);
    }

    function setImplementation(address value) external onlyOwner {
        if (value == address(0)) revert ZeroAddress();
        implementation = value;
        emit ImplementationSet(value);
    }
}

/// @title TestnetStockToken — réplica funcional de la superficie Stock Token/ERC-8056 consumida
contract TestnetStockToken is TestnetERC20 {
    uint256 internal constant WAD = 1e18;

    TestnetAccessRegistry public immutable ACCESS_REGISTRY;
    uint256 public uiMultiplier = WAD;
    uint256 public newUIMultiplier = WAD;
    uint256 public effectiveAt;
    bool public tokenPaused;
    bool public oraclePaused;

    event TokenPauseSet(bool paused);
    event OraclePauseSet(bool paused);
    event UiMultiplierScheduled(uint256 multiplier, uint256 effectiveAt);
    event UiMultiplierApplied(uint256 multiplier);

    error TransfersPaused();
    error AddressBlocked(address account);
    error BadMultiplier();
    error MultiplierNotReady();

    constructor(string memory name_, string memory symbol_, TestnetAccessRegistry registry_)
        TestnetERC20(name_, symbol_, 18)
    {
        ACCESS_REGISTRY = registry_;
    }

    function ACCESS_CONTROLLED_REGISTRY() external view returns (address) {
        return address(ACCESS_REGISTRY);
    }

    function paused() external view returns (bool) {
        return tokenPaused || ACCESS_REGISTRY.paused();
    }

    function balanceOfUI(address account) external view returns (uint256) {
        return balanceOf[account] * uiMultiplier / WAD;
    }

    function totalSupplyUI() external view returns (uint256) {
        return totalSupply * uiMultiplier / WAD;
    }

    function setTokenPaused(bool value) external onlyOwner {
        tokenPaused = value;
        emit TokenPauseSet(value);
    }

    function setOraclePaused(bool value) external onlyOwner {
        oraclePaused = value;
        emit OraclePauseSet(value);
    }

    function scheduleUiMultiplier(uint256 value, uint256 at) external onlyOwner {
        if (value == 0 || at < block.timestamp) revert BadMultiplier();
        newUIMultiplier = value;
        effectiveAt = at;
        emit UiMultiplierScheduled(value, at);
    }

    function applyUiMultiplier() external {
        if (effectiveAt == 0 || block.timestamp < effectiveAt) revert MultiplierNotReady();
        uiMultiplier = newUIMultiplier;
        effectiveAt = 0;
        emit UiMultiplierApplied(uiMultiplier);
    }

    function _beforeTransfer(address from, address to) internal view override {
        if (tokenPaused || ACCESS_REGISTRY.paused()) revert TransfersPaused();
        if (ACCESS_REGISTRY.isBlocked(from)) revert AddressBlocked(from);
        if (ACCESS_REGISTRY.isBlocked(to)) revert AddressBlocked(to);
    }
}

/// @title TestnetPriceFeed — AggregatorV3 de 8 decimales con rondas actualizables
contract TestnetPriceFeed is TestnetOwned {
    uint8 public constant decimals = 8;
    string public description;
    uint256 public constant version = 1;
    uint80 public roundId = 1;
    int256 public answer;
    uint256 public updatedAt;

    event RoundPublished(uint80 indexed roundId, int256 answer, uint256 updatedAt);

    error BadAnswer();
    error FutureTimestamp();

    constructor(string memory description_, int256 answer_) {
        if (answer_ <= 0) revert BadAnswer();
        description = description_;
        answer = answer_;
        updatedAt = block.timestamp;
    }

    function setAnswer(int256 value) external onlyOwner {
        _set(value, block.timestamp);
    }

    function setAnswerAt(int256 value, uint256 timestamp) external onlyOwner {
        if (timestamp > block.timestamp) revert FutureTimestamp();
        _set(value, timestamp);
    }

    /// @notice Publica una ronda fresca al mismo precio. Útil para forward pricing en testnet.
    function poke() external {
        _set(answer, block.timestamp);
    }

    function latestRoundData() external view returns (uint80, int256, uint256, uint256, uint80) {
        return (roundId, answer, updatedAt, updatedAt, roundId);
    }

    function getRoundData(uint80 requested) external view returns (uint80, int256, uint256, uint256, uint80) {
        if (requested != roundId) return (requested, 0, 0, 0, 0);
        return (roundId, answer, updatedAt, updatedAt, roundId);
    }

    function _set(int256 value, uint256 timestamp) internal {
        if (value <= 0) revert BadAnswer();
        answer = value;
        updatedAt = timestamp;
        roundId++;
        emit RoundPublished(roundId, value, timestamp);
    }
}

/// @notice Liquidez sin valor separada del adapter. Solo el adapter configurado puede pagar swaps.
contract TestnetLiquidityVenue is TestnetOwned {
    using SafeTransferLib for IERC20;

    address public adapter;
    bool public adapterLocked;

    error NotAdapter();
    error AdapterLocked();

    event AdapterSet(address indexed adapter);

    function setAdapter(address value) external onlyOwner {
        if (adapterLocked) revert AdapterLocked();
        if (value == address(0)) revert ZeroAddress();
        adapter = value;
        adapterLocked = true;
        emit AdapterSet(value);
    }

    function pay(address token, address recipient, uint256 amount) external {
        if (msg.sender != adapter) revert NotAdapter();
        IERC20(token).safeTransfer(recipient, amount);
    }
}

interface IERC20Metadata is IERC20 {
    function decimals() external view returns (uint8);
}

/// @title TestnetTradeAdapter — venue determinista al precio de los feeds del pack
/// @notice El Fund mantiene toda la seguridad económica: mide deltas y aplica slippage. Este adapter
/// mueve el input al venue y nunca custodia reservas entre llamadas.
contract TestnetTradeAdapter is TestnetOwned, ITradeAdapter {
    using SafeTransferLib for IERC20;

    uint256 internal constant WAD = 1e18;
    uint256 internal constant FEED_UNIT = 1e8;

    struct AssetConfig {
        address feed;
        uint8 tokenDecimals;
        bool enabled;
    }

    TestnetLiquidityVenue public immutable VENUE;
    mapping(address => AssetConfig) public assets;

    event AssetConfigured(address indexed token, address indexed feed, uint8 tokenDecimals);
    event TestnetSwap(
        address indexed tokenIn, address indexed tokenOut, uint256 amountIn, uint256 amountOut, address recipient
    );

    error AssetDisabled(address token);
    error BadDecimals();
    error BadPrice();
    error SameToken();

    constructor(TestnetLiquidityVenue venue_) {
        VENUE = venue_;
    }

    function setAsset(address token, address feed) external onlyOwner {
        uint8 tokenDecimals = IERC20Metadata(token).decimals();
        if (tokenDecimals > 18 || IAggregatorV3(feed).decimals() != 8) revert BadDecimals();
        (, int256 px,,,) = IAggregatorV3(feed).latestRoundData();
        if (px <= 0) revert BadPrice();
        assets[token] = AssetConfig({feed: feed, tokenDecimals: tokenDecimals, enabled: true});
        emit AssetConfigured(token, feed, tokenDecimals);
    }

    function swap(address tokenIn, address tokenOut, uint256 amountIn, address recipient, bytes calldata)
        external
        override
    {
        if (tokenIn == tokenOut) revert SameToken();
        AssetConfig memory inCfg = assets[tokenIn];
        AssetConfig memory outCfg = assets[tokenOut];
        if (!inCfg.enabled) revert AssetDisabled(tokenIn);
        if (!outCfg.enabled) revert AssetDisabled(tokenOut);

        (, int256 inPx,,,) = IAggregatorV3(inCfg.feed).latestRoundData();
        (, int256 outPx,,,) = IAggregatorV3(outCfg.feed).latestRoundData();
        if (inPx <= 0 || outPx <= 0) revert BadPrice();

        uint256 inputWad = amountIn * (10 ** (18 - inCfg.tokenDecimals));
        uint256 valueWad = inputWad * uint256(inPx) / FEED_UNIT;
        uint256 outputWad = valueWad * FEED_UNIT / uint256(outPx);
        uint256 amountOut = outputWad / (10 ** (18 - outCfg.tokenDecimals));

        IERC20(tokenIn).safeTransfer(address(VENUE), amountIn);
        VENUE.pay(tokenOut, recipient, amountOut);
        emit TestnetSwap(tokenIn, tokenOut, amountIn, amountOut, recipient);
    }
}

