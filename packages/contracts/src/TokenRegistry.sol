// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IStockToken, IAccessControlledRegistry} from "./interfaces/IStockToken.sol";
import {IAggregatorV3, IBeacon} from "./interfaces/IAggregatorV3.sol";

/// @title TokenRegistry — universo de activos operables por los fondos (SPEC §5.2, §8, §12)
/// @notice Lista Stock Tokens con su feed Chainlink, `maxStaleness` calibrado al heartbeat real
/// (86400s + margen, chain 4663) y bandas de cordura de precio (revisión F2). La suspensión por
/// drift de beacon es permissionless (C29) — verificado en Fase 0/revisión: el
/// ACCESS_CONTROLLED_REGISTRY de los tokens ES su beacon ERC-1967 (slot comprobado on-chain).
/// Gobernanza: owner 2-pasos como interino de Fase 1; ownership → Guardian con timelock en 1.5 (F19).
contract TokenRegistry {
    struct Asset {
        address feed; // AggregatorV3, 8 decimales
        uint48 maxStaleness; // segundos; heartbeat + margen (acotado, F18)
        bool listed;
        bool suspended;
        address beacon; // ACCESS_CONTROLLED_REGISTRY del token (= beacon ERC-1967, verificado)
        address implAtListing; // implementación aprobada por el owner (commit explícito, F5)
        int256 minAnswer; // banda de cordura del feed (F2)
        int256 maxAnswer;
    }

    uint48 public constant MIN_STALENESS = 1 hours;
    uint48 public constant MAX_STALENESS_CAP = 30 days;

    address public owner;
    address public pendingOwner;

    address public immutable USDG;
    address public usdgFeed; // address(0) ⇒ modo degradado 1:1 (§5.5: el deploy DEBE configurarlo)
    uint48 public usdgMaxStaleness;
    int256 public usdgMinAnswer;
    int256 public usdgMaxAnswer;

    /// @notice Access-controls registry compartido de RHJ. Fijado al primer listado; los listados
    /// posteriores DEBEN coincidir (F6). Re-sincronizable desde el puntero vivo de un token (F11).
    IAccessControlledRegistry public accessRegistry;

    mapping(address => Asset) internal _assets;

    event Listed(address indexed token, address feed, uint48 maxStaleness, address implApproved);
    event FeedSet(address indexed token, address feed, uint48 maxStaleness, int256 minAnswer, int256 maxAnswer);
    event Delisted(address indexed token);
    event Suspended(address indexed token, bool byBeaconDrift, address newImpl);
    event Reapproved(address indexed token, address implApproved);
    event UsdgFeedSet(address feed, uint48 maxStaleness, int256 minAnswer, int256 maxAnswer);
    event AccessRegistryResynced(address registry);
    event OwnershipTransferStarted(address indexed to);
    event OwnershipTransferred(address indexed to);

    error NotOwner();
    error NotListed();
    error AlreadyListed();
    error BadFeed();
    error BadBounds();
    error BadStaleness();
    error NoDrift();
    error ImplMismatch(address current);
    error AccessRegistryMismatch(address tokenRegistry);

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    constructor(address usdg_) {
        owner = msg.sender;
        USDG = usdg_;
    }

    // --- Gestión ---

    /// @param expectedImpl la implementación exacta revisada por el owner: si el emisor upgradea
    /// entre la revisión y la tx, el listado revierte en vez de bendecir código sin revisar (F5).
    function list(
        address token,
        address feed,
        uint48 maxStaleness,
        int256 minAnswer,
        int256 maxAnswer,
        address expectedImpl
    ) external onlyOwner {
        if (_assets[token].listed) revert AlreadyListed();
        _validateFeed(feed, minAnswer, maxAnswer);
        _validateStaleness(maxStaleness);

        address beacon = IStockToken(token).ACCESS_CONTROLLED_REGISTRY();
        address impl = IBeacon(beacon).implementation();
        if (impl != expectedImpl) revert ImplMismatch(impl);

        if (address(accessRegistry) == address(0)) {
            accessRegistry = IAccessControlledRegistry(beacon);
        } else if (beacon != address(accessRegistry)) {
            revert AccessRegistryMismatch(beacon); // premisa de registry compartido, forzada (F6)
        }

        _assets[token] = Asset({
            feed: feed,
            maxStaleness: maxStaleness,
            listed: true,
            suspended: false,
            beacon: beacon,
            implAtListing: impl,
            minAnswer: minAnswer,
            maxAnswer: maxAnswer
        });
        emit Listed(token, feed, maxStaleness, impl);
    }

    /// @notice Palanca de remediación (F1): feed muerto/deprecado se sustituye sin re-listar.
    function setFeed(address token, address feed, uint48 maxStaleness, int256 minAnswer, int256 maxAnswer)
        external
        onlyOwner
    {
        if (!_assets[token].listed) revert NotListed();
        _validateFeed(feed, minAnswer, maxAnswer);
        _validateStaleness(maxStaleness);
        Asset storage a = _assets[token];
        a.feed = feed;
        a.maxStaleness = maxStaleness;
        a.minAnswer = minAnswer;
        a.maxAnswer = maxAnswer;
        emit FeedSet(token, feed, maxStaleness, minAnswer, maxAnswer);
    }

    function delist(address token) external onlyOwner {
        if (!_assets[token].listed) revert NotListed();
        delete _assets[token];
        emit Delisted(token);
    }

    function setUsdgFeed(address feed, uint48 maxStaleness, int256 minAnswer, int256 maxAnswer) external onlyOwner {
        if (feed != address(0)) {
            _validateFeed(feed, minAnswer, maxAnswer);
            _validateStaleness(maxStaleness);
        }
        usdgFeed = feed;
        usdgMaxStaleness = maxStaleness;
        usdgMinAnswer = minAnswer;
        usdgMaxAnswer = maxAnswer;
        emit UsdgFeedSet(feed, maxStaleness, minAnswer, maxAnswer);
    }

    function suspend(address token) external onlyOwner {
        if (!_assets[token].listed) revert NotListed();
        _assets[token].suspended = true;
        emit Suspended(token, false, address(0));
    }

    /// @notice Permissionless (C29): el emisor cambió la implementación del beacon ⇒ cualquiera suspende.
    function suspendOnBeaconDrift(address token) external {
        Asset storage a = _assets[token];
        if (!a.listed) revert NotListed();
        address current = IBeacon(a.beacon).implementation();
        if (current == a.implAtListing) revert NoDrift();
        a.suspended = true;
        emit Suspended(token, true, current);
    }

    /// @notice Re-aprobación tras revisar un upgrade. `expectedImpl` es el commit del owner (F5):
    /// si el emisor vuelve a upgradear antes de la tx, revierte en vez de bendecir sin revisar.
    function reapprove(address token, address expectedImpl) external onlyOwner {
        Asset storage a = _assets[token];
        if (!a.listed) revert NotListed();
        address current = IBeacon(a.beacon).implementation();
        if (current != expectedImpl) revert ImplMismatch(current);
        a.implAtListing = current;
        a.suspended = false;
        emit Reapproved(token, current);
    }

    /// @notice Re-sincroniza el access registry desde el puntero VIVO de un token listado (F11):
    /// si RHJ migra el registry, esto sigue al puntero on-chain en vez de quedarse con el snapshot.
    function resyncAccessRegistry(address token) external onlyOwner {
        Asset storage a = _assets[token];
        if (!a.listed) revert NotListed();
        address live = IStockToken(token).ACCESS_CONTROLLED_REGISTRY();
        accessRegistry = IAccessControlledRegistry(live);
        a.beacon = live;
        emit AccessRegistryResynced(live);
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

    function isActive(address token) public view returns (bool) {
        Asset storage a = _assets[token];
        return a.listed && !a.suspended;
    }

    // --- Interno ---

    function _validateFeed(address feed, int256 minAnswer, int256 maxAnswer) internal view {
        if (IAggregatorV3(feed).decimals() != 8) revert BadFeed();
        (, int256 answer,,,) = IAggregatorV3(feed).latestRoundData();
        if (answer <= 0) revert BadFeed();
        if (minAnswer <= 0 || maxAnswer <= minAnswer) revert BadBounds();
        if (answer < minAnswer || answer > maxAnswer) revert BadBounds(); // el precio actual debe caber en banda
    }

    function _validateStaleness(uint48 maxStaleness) internal pure {
        if (maxStaleness < MIN_STALENESS || maxStaleness > MAX_STALENESS_CAP) revert BadStaleness();
    }
}
