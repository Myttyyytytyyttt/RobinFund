// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {AgentRegistry} from "./AgentRegistry.sol";
import {AdapterRegistry} from "../AdapterRegistry.sol";
import {FeeSplitter} from "../FeeSplitter.sol";
import {StakeEscrow} from "../StakeEscrow.sol";
import {TokenRegistry} from "../TokenRegistry.sol";
import {IERC20} from "../interfaces/IERC20.sol";
import {IAgentExecutionAdapter} from "../interfaces/IAgentExecutionAdapter.sol";
import {NAVLib} from "../libraries/NAVLib.sol";
import {SafeTransferLib} from "../libraries/SafeTransferLib.sol";

interface IAgentManagedFund {
    function MANAGER() external view returns (address);
    function REGISTRY() external view returns (TokenRegistry);
    function USDG() external view returns (IERC20);
    function ADAPTERS() external view returns (AdapterRegistry);
    function FEE_SPLITTER() external view returns (address);
    function stakeEscrow() external view returns (StakeEscrow);
    function nav() external view returns (NAVLib.Snapshot memory);
    function execute(uint256 adapterId, address tokenIn, address tokenOut, uint256 amountIn, bytes calldata data)
        external;
    function requestWinding() external;
    function close() external;
    function finalizeClosure(uint64[] calldata periodsToSweep) external;
}

/// @title AgentVaultController
/// @notice Manager inmutable de un Fund. Convierte una intención firmada por el agente en una única
/// llamada a Fund.execute y aplica una segunda frontera de riesgo específica del vault.
contract AgentVaultController {
    using SafeTransferLib for IERC20;

    struct Policy {
        uint16 maxTradeBps;
        uint16 maxConcentrationBps;
        uint16 dailyTurnoverBps;
        uint16 maxSlippageBps;
        uint16 maxTradesPerDay;
        uint32 minTradeInterval;
        uint32 maxIntentLifetime;
    }

    struct TradeIntentV1 {
        bytes32 agentId;
        address fund;
        address tokenIn;
        address tokenOut;
        uint256 amountIn;
        uint256 minAmountOut;
        uint16 maxSlippageBps;
        bytes32 policyHash;
        bytes32 executionHash;
        bytes32 evidenceHash;
        uint256 nonce;
        uint48 validAfter;
        uint48 deadline;
    }

    bytes32 public constant TRADE_INTENT_TYPEHASH = keccak256(
        "TradeIntentV1(bytes32 agentId,address fund,address tokenIn,address tokenOut,uint256 amountIn,uint256 minAmountOut,uint16 maxSlippageBps,bytes32 policyHash,bytes32 executionHash,bytes32 evidenceHash,uint256 nonce,uint48 validAfter,uint48 deadline)"
    );
    bytes32 private constant DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");
    bytes32 private constant NAME_HASH = keccak256("Nuvem AgentVaultController");
    bytes32 private constant VERSION_HASH = keccak256("1");
    bytes32 private constant EIP1271_MAGICVALUE = 0x1626ba7e00000000000000000000000000000000000000000000000000000000;
    uint256 private constant SECP256K1N_HALF =
        0x7fffffffffffffffffffffffffffffff5d576e7357a4501ddfe92f46681b20a0;
    uint48 public constant POLICY_TIMELOCK = 24 hours;
    uint256 private constant BPS = 10_000;

    AgentRegistry public immutable AGENT_REGISTRY;
    TokenRegistry public immutable TOKEN_REGISTRY;
    IERC20 public immutable USDG;
    bytes32 public immutable AGENT_ID;
    address public immutable SPONSOR;
    uint256 public immutable TRADE_ADAPTER_ID;
    address public immutable TRADE_ADAPTER;

    address public FUND;
    Policy public policy;
    bytes32 public policyHash;
    bool public paused;
    uint256 public nextNonce;
    uint48 public dayStart;
    uint48 public lastTradeAt;
    uint16 public tradesToday;
    uint256 public turnoverTodayWad;

    mapping(address => bool) public allowedAsset;
    address[] private _allowedAssets;

    Policy private _pendingPolicy;
    address[] private _pendingAssets;
    bytes32 public pendingPolicyHash;
    uint48 public pendingPolicyEta;

    uint256 private _lock = 1;

    event FundBound(address indexed fund);
    event TradeExecuted(
        uint256 indexed nonce,
        bytes32 indexed evidenceHash,
        address indexed relayer,
        address tokenIn,
        address tokenOut,
        uint256 spent,
        uint256 received,
        uint256 spentValueWad,
        uint256 receivedValueWad
    );
    event Paused(bool paused);
    event PolicyProposed(bytes32 indexed policyHash, uint48 executableAt);
    event PolicyCancelled(bytes32 indexed policyHash);
    event PolicyActivated(bytes32 indexed policyHash);
    event SponsorSweep(address indexed token, uint256 amount);

    error ZeroAddress();
    error NotSponsor();
    error AlreadyBound();
    error FundNotBound();
    error BadFund();
    error BadPolicy();
    error BadAssets();
    error ControllerPaused();
    error AgentInactive();
    error InvalidIntent();
    error InvalidSignature();
    error InvalidNonce();
    error IntentExpired();
    error PolicyMismatch();
    error ExecutionMismatch();
    error NavInvalid();
    error TradeTooLarge();
    error ConcentrationExceeded();
    error TurnoverExceeded();
    error FrequencyExceeded();
    error SlippageExceeded();
    error TimelockActive();
    error NoPendingPolicy();
    error TransferFailed();
    error Reentrancy();

    modifier onlySponsor() {
        if (msg.sender != SPONSOR) revert NotSponsor();
        _;
    }

    modifier nonReentrant() {
        if (_lock != 1) revert Reentrancy();
        _lock = 2;
        _;
        _lock = 1;
    }

    constructor(
        AgentRegistry agentRegistry_,
        TokenRegistry tokenRegistry_,
        bytes32 agentId_,
        address sponsor_,
        uint256 tradeAdapterId_,
        address tradeAdapter_,
        Policy memory initialPolicy,
        address[] memory initialAssets
    ) {
        if (
            address(agentRegistry_) == address(0) || address(tokenRegistry_) == address(0)
                || agentId_ == bytes32(0) || sponsor_ == address(0) || tradeAdapter_ == address(0)
                || tradeAdapter_.code.length == 0
        ) revert ZeroAddress();
        if (agentRegistry_.sponsorOf(agentId_) != sponsor_) revert NotSponsor();
        _validatePolicy(initialPolicy);

        AGENT_REGISTRY = agentRegistry_;
        TOKEN_REGISTRY = tokenRegistry_;
        USDG = IERC20(tokenRegistry_.USDG());
        AGENT_ID = agentId_;
        SPONSOR = sponsor_;
        TRADE_ADAPTER_ID = tradeAdapterId_;
        TRADE_ADAPTER = tradeAdapter_;
        policy = initialPolicy;
        bytes32 assetsHash = _replaceAssets(initialAssets);
        policyHash = _computePolicyHash(initialPolicy, assetsHash);
        emit PolicyActivated(policyHash);
    }

    receive() external payable {}

    /// @notice Binding one-shot después del deploy directo del Fund (el controller ya fue usado
    /// como MANAGER en su constructor).
    function bindFund(address fund_) external onlySponsor {
        if (FUND != address(0)) revert AlreadyBound();
        if (fund_ == address(0) || fund_.code.length == 0) revert BadFund();
        IAgentManagedFund fund = IAgentManagedFund(fund_);
        if (
            fund.MANAGER() != address(this) || address(fund.REGISTRY()) != address(TOKEN_REGISTRY)
                || address(fund.USDG()) != address(USDG)
                || fund.ADAPTERS().get(TRADE_ADAPTER_ID) != TRADE_ADAPTER
                || !AGENT_REGISTRY.controllers(AGENT_ID, address(this))
        ) revert BadFund();
        FUND = fund_;
        emit FundBound(fund_);
    }

    /// @notice Cualquiera puede relayar; el permiso está en la firma EIP-712 y en la policy on-chain.
    function executeTrade(TradeIntentV1 calldata intent, bytes calldata adapterData, bytes calldata signature)
        external
        nonReentrant
    {
        address fundAddress = FUND;
        if (fundAddress == address(0)) revert FundNotBound();
        if (paused) revert ControllerPaused();
        if (
            !AGENT_REGISTRY.isActive(AGENT_ID) || !AGENT_REGISTRY.controllers(AGENT_ID, address(this))
        ) revert AgentInactive();
        if (
            intent.agentId != AGENT_ID || intent.fund != fundAddress || intent.tokenIn == intent.tokenOut
                || intent.amountIn == 0 || intent.minAmountOut == 0 || intent.evidenceHash == bytes32(0)
        ) revert InvalidIntent();
        if (intent.nonce != nextNonce) revert InvalidNonce();
        if (
            block.timestamp < intent.validAfter || block.timestamp > intent.deadline
                || intent.deadline <= intent.validAfter
                || intent.deadline - intent.validAfter > policy.maxIntentLifetime
        ) revert IntentExpired();
        if (intent.policyHash != policyHash) revert PolicyMismatch();
        if (intent.maxSlippageBps == 0 || intent.maxSlippageBps > policy.maxSlippageBps) {
            revert SlippageExceeded();
        }
        if (intent.tokenOut != address(USDG) && !allowedAsset[intent.tokenOut]) revert BadAssets();

        bytes32 executionHash = keccak256(abi.encode(TRADE_ADAPTER_ID, adapterData));
        if (intent.executionHash != executionHash) revert ExecutionMismatch();
        if (!_validAgentSignature(hashTradeIntent(intent), signature)) revert InvalidSignature();

        AdapterRegistry adapterRegistry = IAgentManagedFund(fundAddress).ADAPTERS();
        if (adapterRegistry.get(TRADE_ADAPTER_ID) != TRADE_ADAPTER) revert ExecutionMismatch();
        try IAgentExecutionAdapter(TRADE_ADAPTER).validateExecution(
            intent.tokenIn,
            intent.tokenOut,
            intent.amountIn,
            fundAddress,
            intent.minAmountOut,
            adapterData
        ) returns (bool validExecution) {
            if (!validExecution) revert ExecutionMismatch();
        } catch {
            revert ExecutionMismatch();
        }

        IAgentManagedFund fund = IAgentManagedFund(fundAddress);
        NAVLib.Snapshot memory preNav = fund.nav();
        if (!preNav.valid || preNav.navWad == 0) revert NavInvalid();
        (uint256 quotedSpendWad, bool spendValid) =
            NAVLib.tradeValueWad(TOKEN_REGISTRY, address(USDG), intent.tokenIn, intent.amountIn);
        if (!spendValid) revert NavInvalid();
        if (quotedSpendWad * BPS > preNav.navWad * policy.maxTradeBps) revert TradeTooLarge();

        _prepareDailyLimits(quotedSpendWad, preNav.navWad);

        uint256 inBefore = IERC20(intent.tokenIn).balanceOf(fundAddress);
        uint256 outBefore = IERC20(intent.tokenOut).balanceOf(fundAddress);
        nextNonce = intent.nonce + 1;

        fund.execute(TRADE_ADAPTER_ID, intent.tokenIn, intent.tokenOut, intent.amountIn, adapterData);

        uint256 inAfter = IERC20(intent.tokenIn).balanceOf(fundAddress);
        uint256 outAfter = IERC20(intent.tokenOut).balanceOf(fundAddress);
        if (inAfter > inBefore || outAfter < outBefore) revert InvalidIntent();
        uint256 spent = inBefore - inAfter;
        uint256 received = outAfter - outBefore;
        if (spent != intent.amountIn || received < intent.minAmountOut) revert InvalidIntent();

        NAVLib.Snapshot memory postNav = fund.nav();
        if (!postNav.valid || postNav.navWad == 0) revert NavInvalid();
        (uint256 spentValueWad, bool spentValid) =
            NAVLib.tradeValueWad(TOKEN_REGISTRY, address(USDG), intent.tokenIn, spent);
        (uint256 receivedValueWad, bool receivedValid) =
            NAVLib.tradeValueWad(TOKEN_REGISTRY, address(USDG), intent.tokenOut, received);
        if (!spentValid || !receivedValid) revert NavInvalid();
        uint256 adverseWad = spentValueWad > receivedValueWad ? spentValueWad - receivedValueWad : 0;
        if (adverseWad * BPS > spentValueWad * intent.maxSlippageBps) revert SlippageExceeded();

        if (intent.tokenOut != address(USDG)) {
            (uint256 concentrationWad, bool concentrationValid) = NAVLib.tradeValueWad(
                TOKEN_REGISTRY,
                address(USDG),
                intent.tokenOut,
                IERC20(intent.tokenOut).balanceOf(fundAddress)
            );
            if (!concentrationValid) revert NavInvalid();
            if (concentrationWad * BPS > postNav.navWad * policy.maxConcentrationBps) {
                revert ConcentrationExceeded();
            }
        }

        // `spent == amountIn`, por lo que la pre-validación y la contabilidad final comparten valor.
        turnoverTodayWad += spentValueWad;
        tradesToday++;
        lastTradeAt = uint48(block.timestamp);
        emit TradeExecuted(
            intent.nonce,
            intent.evidenceHash,
            msg.sender,
            intent.tokenIn,
            intent.tokenOut,
            spent,
            received,
            spentValueWad,
            receivedValueWad
        );
    }

    function proposePolicy(Policy calldata nextPolicy, address[] calldata nextAssets) external onlySponsor {
        _validatePolicy(nextPolicy);
        bytes32 assetsHash = _validateAssets(nextAssets);
        delete _pendingAssets;
        for (uint256 i; i < nextAssets.length; ++i) _pendingAssets.push(nextAssets[i]);
        _pendingPolicy = nextPolicy;
        pendingPolicyHash = _computePolicyHash(nextPolicy, assetsHash);
        pendingPolicyEta = uint48(block.timestamp) + POLICY_TIMELOCK;
        emit PolicyProposed(pendingPolicyHash, pendingPolicyEta);
    }

    function activatePolicy() external {
        bytes32 nextHash = pendingPolicyHash;
        if (nextHash == bytes32(0)) revert NoPendingPolicy();
        if (block.timestamp < pendingPolicyEta) revert TimelockActive();
        address[] memory nextAssets = _pendingAssets;
        bytes32 assetsHash = _replaceAssets(nextAssets);
        policy = _pendingPolicy;
        policyHash = _computePolicyHash(_pendingPolicy, assetsHash);
        if (policyHash != nextHash) revert PolicyMismatch();
        delete _pendingAssets;
        delete _pendingPolicy;
        pendingPolicyHash = bytes32(0);
        pendingPolicyEta = 0;
        emit PolicyActivated(policyHash);
    }

    function cancelPolicy() external onlySponsor {
        bytes32 cancelled = pendingPolicyHash;
        if (cancelled == bytes32(0)) revert NoPendingPolicy();
        delete _pendingAssets;
        delete _pendingPolicy;
        pendingPolicyHash = bytes32(0);
        pendingPolicyEta = 0;
        emit PolicyCancelled(cancelled);
    }

    function setPaused(bool value) external onlySponsor {
        paused = value;
        emit Paused(value);
    }

    function requestStakeWithdrawal(uint256 amount) external onlySponsor nonReentrant {
        _fund().stakeEscrow().requestWithdraw(amount);
    }

    function cancelStakeWithdrawal() external onlySponsor nonReentrant {
        _fund().stakeEscrow().cancelWithdraw();
    }

    function requestWinding() external onlySponsor nonReentrant {
        paused = true;
        _fund().requestWinding();
        emit Paused(true);
    }

    function close() external onlySponsor nonReentrant {
        paused = true;
        _fund().close();
        emit Paused(true);
    }

    function finalizeClosure(uint64[] calldata periodsToSweep) external onlySponsor nonReentrant {
        _fund().finalizeClosure(periodsToSweep);
        _sweepToken(address(USDG));
    }

    function redeemManagerFees(bool inKind) external nonReentrant returns (uint256 shares) {
        shares = FeeSplitter(_fund().FEE_SPLITTER()).redeem(inKind);
    }

    function distributeManagerFeeToken(address token) external nonReentrant {
        FeeSplitter(_fund().FEE_SPLITTER()).distributeToken(token);
        _sweepToken(token);
    }

    /// @notice Permissionless y con destinatario fijo: nunca permite redirigir ingresos del manager.
    function sweepToSponsor(address token) external nonReentrant {
        _sweepToken(token);
    }

    function sweepNativeToSponsor() external nonReentrant {
        uint256 amount = address(this).balance;
        (bool ok,) = SPONSOR.call{value: amount}("");
        if (!ok) revert TransferFailed();
        emit SponsorSweep(address(0), amount);
    }

    function allowedAssets() external view returns (address[] memory) {
        return _allowedAssets;
    }

    function pendingAssets() external view returns (address[] memory) {
        return _pendingAssets;
    }

    function hashTradeIntent(TradeIntentV1 calldata intent) public view returns (bytes32) {
        bytes32 structHash = keccak256(
            abi.encode(
                TRADE_INTENT_TYPEHASH,
                intent.agentId,
                intent.fund,
                intent.tokenIn,
                intent.tokenOut,
                intent.amountIn,
                intent.minAmountOut,
                intent.maxSlippageBps,
                intent.policyHash,
                intent.executionHash,
                intent.evidenceHash,
                intent.nonce,
                intent.validAfter,
                intent.deadline
            )
        );
        return keccak256(abi.encodePacked("\x19\x01", domainSeparator(), structHash));
    }

    function domainSeparator() public view returns (bytes32) {
        return keccak256(abi.encode(DOMAIN_TYPEHASH, NAME_HASH, VERSION_HASH, block.chainid, address(this)));
    }

    function _prepareDailyLimits(uint256 tradeWad, uint256 navWad) private {
        uint48 start = dayStart;
        if (start == 0 || block.timestamp >= start + 1 days) {
            dayStart = uint48(block.timestamp);
            tradesToday = 0;
            turnoverTodayWad = 0;
        }
        if (tradesToday >= policy.maxTradesPerDay) revert FrequencyExceeded();
        if (lastTradeAt != 0 && block.timestamp < lastTradeAt + policy.minTradeInterval) {
            revert FrequencyExceeded();
        }
        if ((turnoverTodayWad + tradeWad) * BPS > navWad * policy.dailyTurnoverBps) {
            revert TurnoverExceeded();
        }
    }

    function _replaceAssets(address[] memory nextAssets) private returns (bytes32 assetsHash) {
        assetsHash = _validateAssets(nextAssets);
        for (uint256 i; i < _allowedAssets.length; ++i) allowedAsset[_allowedAssets[i]] = false;
        delete _allowedAssets;
        for (uint256 i; i < nextAssets.length; ++i) {
            allowedAsset[nextAssets[i]] = true;
            _allowedAssets.push(nextAssets[i]);
        }
    }

    function _validateAssets(address[] memory assets_) private view returns (bytes32) {
        if (assets_.length == 0 || assets_.length > 32) revert BadAssets();
        for (uint256 i; i < assets_.length; ++i) {
            if (
                assets_[i] == address(0) || assets_[i] == address(USDG)
                    || (i != 0 && assets_[i] <= assets_[i - 1]) || !TOKEN_REGISTRY.isActive(assets_[i])
            ) revert BadAssets();
        }
        return keccak256(abi.encode(assets_));
    }

    function _validatePolicy(Policy memory value) private pure {
        if (
            value.maxTradeBps < 100 || value.maxTradeBps > 2000 || value.maxConcentrationBps < 1000
                || value.maxConcentrationBps > 5000 || value.dailyTurnoverBps < 500
                || value.dailyTurnoverBps > 10_000 || value.maxSlippageBps < 10
                || value.maxSlippageBps > 100 || value.maxTradesPerDay == 0
                || value.maxTradesPerDay > 200 || value.minTradeInterval < 60
                || value.minTradeInterval > 3600 || value.maxIntentLifetime == 0
                || value.maxIntentLifetime > 5 minutes
        ) revert BadPolicy();
    }

    function _computePolicyHash(Policy memory value, bytes32 assetsHash) private view returns (bytes32) {
        return keccak256(abi.encode(value, assetsHash, TRADE_ADAPTER_ID, TRADE_ADAPTER));
    }

    function _validAgentSignature(bytes32 digest, bytes calldata signature) private view returns (bool) {
        address signer = AGENT_REGISTRY.signerOf(AGENT_ID);
        if (signer.code.length != 0) {
            (bool ok, bytes memory result) = signer.staticcall(
                abi.encodeWithSelector(0x1626ba7e, digest, signature)
            );
            return ok && result.length >= 32 && bytes32(result) == EIP1271_MAGICVALUE;
        }
        if (signature.length != 65) return false;
        bytes32 r;
        bytes32 s;
        uint8 v;
        assembly ("memory-safe") {
            r := calldataload(signature.offset)
            s := calldataload(add(signature.offset, 32))
            v := byte(0, calldataload(add(signature.offset, 64)))
        }
        if (uint256(s) > SECP256K1N_HALF || (v != 27 && v != 28)) return false;
        return ecrecover(digest, v, r, s) == signer;
    }

    function _fund() private view returns (IAgentManagedFund fund) {
        address fundAddress = FUND;
        if (fundAddress == address(0)) revert FundNotBound();
        fund = IAgentManagedFund(fundAddress);
    }

    function _sweepToken(address token) private {
        uint256 amount = IERC20(token).balanceOf(address(this));
        if (amount != 0) IERC20(token).safeTransfer(SPONSOR, amount);
        emit SponsorSweep(token, amount);
    }
}
