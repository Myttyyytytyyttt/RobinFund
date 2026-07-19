// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Fund} from "./Fund.sol";
import {TokenRegistry} from "./TokenRegistry.sol";
import {AdapterRegistry} from "./AdapterRegistry.sol";
import {IEligibilityGate} from "./interfaces/IEligibilityGate.sol";

/// @title FundFactory — despliega y registra fondos (SPEC §12)
/// @notice Un fondo lo crea cualquier manager ELEGIBLE (§10.1). La factory inyecta los parámetros
/// de protocolo compartidos (registries, gate, guardian, keeper, treasury) para que un manager no
/// pueda cablear un fondo con un keeper/treasury/guardian propios. Deploy directo con `new` (no
/// clones ERC-1167: el Fund despliega 4 sub-contratos en su constructor, incompatible con
/// minimal-proxy; el coste de deploy es aceptable y la divergencia con la spec está documentada).
contract FundFactory {
    TokenRegistry public immutable REGISTRY;
    AdapterRegistry public immutable ADAPTERS;
    IEligibilityGate public immutable GATE;
    address public immutable GUARDIAN;
    address public immutable KEEPER;
    address public immutable PROTOCOL_TREASURY;

    address[] public funds;
    mapping(address => bool) public isFund;
    mapping(address => address[]) public fundsByManager;

    event FundCreated(address indexed fund, address indexed manager, string symbol);

    error NotEligible();

    constructor(
        TokenRegistry registry_,
        AdapterRegistry adapters_,
        IEligibilityGate gate_,
        address guardian_,
        address keeper_,
        address treasury_
    ) {
        REGISTRY = registry_;
        ADAPTERS = adapters_;
        GATE = gate_;
        GUARDIAN = guardian_;
        KEEPER = keeper_;
        PROTOCOL_TREASURY = treasury_;
    }

    /// @notice Crea un fondo. `msg.sender` es el manager y debe estar atestado como elegible.
    function createFund(Fund.Config calldata cfg, string calldata name, string calldata symbol)
        external
        returns (address fundAddr)
    {
        if (!GATE.isEligible(msg.sender)) revert NotEligible();
        Fund fund = new Fund(
            REGISTRY, GATE, ADAPTERS, GUARDIAN, msg.sender, KEEPER, PROTOCOL_TREASURY, cfg, name, symbol
        );
        fundAddr = address(fund);
        funds.push(fundAddr);
        isFund[fundAddr] = true;
        fundsByManager[msg.sender].push(fundAddr);
        emit FundCreated(fundAddr, msg.sender, symbol);
    }

    function fundCount() external view returns (uint256) {
        return funds.length;
    }

    function managerFundCount(address manager) external view returns (uint256) {
        return fundsByManager[manager].length;
    }
}
