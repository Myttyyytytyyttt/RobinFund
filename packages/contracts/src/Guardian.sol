// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

interface IFundPausable {
    function setGuardianPaused(bool v) external;
}

/// @title Guardian — gobernanza con dos velocidades (SPEC §2, §12)
/// @notice Un multisig (el `owner`, p. ej. un Safe) controla el Guardian. Dos velocidades:
///  · RÁPIDA (emergencia, sin timelock): pausar depósitos/trading de un fondo — es un freno de mano,
///    debe ser inmediato. NUNCA afecta a retiros (el Fund lo garantiza, D12).
///  · LENTA (timelock `DELAY`): cualquier llamada de gestión de configuración — típicamente ser el
///    owner del `TokenRegistry`/`AdapterRegistry` y listar/suspender activos o adapters. Un cambio
///    de configuración se encola y solo se ejecuta pasado `DELAY`, dando aviso on-chain.
/// El Guardian ostenta la ownership de los registries (via su transferencia 2-pasos).
contract Guardian {
    uint256 public immutable DELAY; // p. ej. 2 días
    address public owner; // multisig
    address public pendingOwner;

    mapping(bytes32 => uint256) public queuedAt; // id → timestamp de encolado (0 = no encolada)

    event Queued(bytes32 indexed id, address target, uint256 value, bytes data, uint256 executableAt);
    event Executed(bytes32 indexed id, address target, uint256 value, bytes data);
    event Cancelled(bytes32 indexed id);
    event FundPauseSet(address indexed fund, bool paused);
    event OwnershipTransferStarted(address indexed to);
    event OwnershipTransferred(address indexed to);

    error NotOwner();
    error ZeroAddress();
    error AlreadyQueued();
    error NotQueued();
    error TimelockActive(uint256 executableAt);
    error CallFailed();

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    constructor(address owner_, uint256 delay_) {
        if (owner_ == address(0)) revert ZeroAddress();
        owner = owner_;
        DELAY = delay_;
    }

    // ---------- Vía rápida: freno de emergencia ----------

    function pauseFund(address fund) external onlyOwner {
        IFundPausable(fund).setGuardianPaused(true);
        emit FundPauseSet(fund, true);
    }

    function unpauseFund(address fund) external onlyOwner {
        IFundPausable(fund).setGuardianPaused(false);
        emit FundPauseSet(fund, false);
    }

    // ---------- Vía lenta: timelock para configuración ----------

    function queue(address target, uint256 value, bytes calldata data) external onlyOwner returns (bytes32 id) {
        id = keccak256(abi.encode(target, value, data));
        if (queuedAt[id] != 0) revert AlreadyQueued();
        queuedAt[id] = block.timestamp;
        emit Queued(id, target, value, data, block.timestamp + DELAY);
    }

    function execute(address target, uint256 value, bytes calldata data)
        external
        payable
        onlyOwner
        returns (bytes memory ret)
    {
        bytes32 id = keccak256(abi.encode(target, value, data));
        uint256 qat = queuedAt[id];
        if (qat == 0) revert NotQueued();
        if (block.timestamp < qat + DELAY) revert TimelockActive(qat + DELAY);
        queuedAt[id] = 0;
        (bool ok, bytes memory r) = target.call{value: value}(data);
        if (!ok) revert CallFailed();
        emit Executed(id, target, value, data);
        return r;
    }

    function cancel(address target, uint256 value, bytes calldata data) external onlyOwner {
        bytes32 id = keccak256(abi.encode(target, value, data));
        if (queuedAt[id] == 0) revert NotQueued();
        queuedAt[id] = 0;
        emit Cancelled(id);
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

    receive() external payable {}
}
