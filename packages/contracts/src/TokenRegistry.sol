// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IStockToken, IAccessControlledRegistry} from "./interfaces/IStockToken.sol";
import {IAggregatorV3, IBeacon} from "./interfaces/IAggregatorV3.sol";
import {IERC20} from "./interfaces/IERC20.sol";

/// @title TokenRegistry — universo de activos operables por los fondos (SPEC §5.2, §8, §12)
/// @notice Lista Stock Tokens con su feed Chainlink y `maxStaleness` calibrado al heartbeat real
/// (86400s + margen en chain 4663, verificado en Fase 0). La suspensión por drift de beacon es
/// permissionless: si el emisor cambia la implementación de los tokens, cualquiera puede suspender
/// el activo hasta re-aprobación del owner (SPEC C29).
contract TokenRegistry {
    struct Asset {
        address feed; // AggregatorV3, 8 decimales
        uint48 maxStaleness; // segundos; heartbeat + margen
        bool listed;
        bool suspended;
        address beacon; // ACCESS_CONTROLLED_REGISTRY del token (tambien es su beacon)
        address implAtListing; // implementación del beacon al listar/re-aprobar
    }

    address public owner;
    address public pendingOwner;

    address public immutable USDG;
    address public usdgFeed; // opcional: si es address(0), USDG se valora 1:1
    uint48 public usdgMaxStaleness;

    /// @notice Access-controls registry de RHJ, para `isBlocked(fund)` — fijado al primer listado.
    IAccessControlledRegistry public accessRegistry;

    mapping(address => Asset) internal _assets;

    event Listed(address indexed token, address feed, uint48 maxStaleness, address implAtListing);
    event Suspended(address indexed token, bool byBeaconDrift, address newImpl);
    event Reapproved(address indexed token, address implAtListing);
    event UsdgFeedSet(address feed, uint48 maxStaleness);
    event OwnershipTransferStarted(address indexed to);
    event OwnershipTransferred(address indexed to);

    error NotOwner();
    error NotListed();
    error AlreadyListed();
    error BadFeed();
    error NoDrift();

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    constructor(address usdg_) {
        owner = msg.sender;
        USDG = usdg_;
    }

    // --- Gestión (owner → Guardian con timelock en Fase 1.5) ---

    function list(address token, address feed, uint48 maxStaleness) external onlyOwner {
        if (_assets[token].listed) revert AlreadyListed();
        _validateFeed(feed);

        address beacon = IStockToken(token).ACCESS_CONTROLLED_REGISTRY();
        address impl = IBeacon(beacon).implementation();
        if (address(accessRegistry) == address(0)) {
            accessRegistry = IAccessControlledRegistry(beacon);
        }

        _assets[token] = Asset({
            feed: feed,
            maxStaleness: maxStaleness,
            listed: true,
            suspended: false,
            beacon: beacon,
            implAtListing: impl
        });
        emit Listed(token, feed, maxStaleness, impl);
    }

    function setUsdgFeed(address feed, uint48 maxStaleness) external onlyOwner {
        if (feed != address(0)) _validateFeed(feed);
        usdgFeed = feed;
        usdgMaxStaleness = maxStaleness;
        emit UsdgFeedSet(feed, maxStaleness);
    }

    function suspend(address token) external onlyOwner {
        if (!_assets[token].listed) revert NotListed();
        _assets[token].suspended = true;
        emit Suspended(token, false, address(0));
    }

    /// @notice Permissionless (SPEC C29): si el emisor cambió la implementación del beacon,
    /// cualquiera puede suspender el activo — condición verificable on-chain, sin confiar en el keeper.
    function suspendOnBeaconDrift(address token) external {
        Asset storage a = _assets[token];
        if (!a.listed) revert NotListed();
        address current = IBeacon(a.beacon).implementation();
        if (current == a.implAtListing) revert NoDrift();
        a.suspended = true;
        emit Suspended(token, true, current);
    }

    /// @notice Re-aprobación tras revisar un upgrade del emisor (via timelock del Guardian en v1).
    function reapprove(address token) external onlyOwner {
        Asset storage a = _assets[token];
        if (!a.listed) revert NotListed();
        a.implAtListing = IBeacon(a.beacon).implementation();
        a.suspended = false;
        emit Reapproved(token, a.implAtListing);
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

    // --- Vistas ---

    function getAsset(address token) external view returns (Asset memory) {
        return _assets[token];
    }

    /// @notice Activo operable: listado y no suspendido.
    function isActive(address token) public view returns (bool) {
        Asset storage a = _assets[token];
        return a.listed && !a.suspended;
    }

    function feedOf(address token) external view returns (address, uint48) {
        Asset storage a = _assets[token];
        return (a.feed, a.maxStaleness);
    }

    // --- Interno ---

    function _validateFeed(address feed) internal view {
        if (IAggregatorV3(feed).decimals() != 8) revert BadFeed();
        (, int256 answer,,,) = IAggregatorV3(feed).latestRoundData();
        if (answer <= 0) revert BadFeed();
    }
}
