// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IEligibilityGate} from "./interfaces/IEligibilityGate.sol";

/// @title EligibilityGate — atestaciones de elegibilidad EIP-712 (SPEC §10)
/// @notice El compliance signer off-chain firma `Attestation(account, expiry, nonce)` tras verificar
/// no-US-person + jurisdicción permitida. Cualquiera puede enviar la firma para registrarla on-chain
/// (una sola vez, TTL 90d). El signer puede revocar. Unicidad por persona la aplica el signer off-chain
/// (una dirección activa por individuo verificado, §10.1). El Fund consume `isEligible`/`ineligibleSince`.
contract EligibilityGate is IEligibilityGate {
    bytes32 public constant ATTESTATION_TYPEHASH =
        keccak256("Attestation(address account,uint48 expiry,uint256 nonce)");
    bytes32 private immutable _CACHED_DOMAIN_SEPARATOR;
    uint256 private immutable _CACHED_CHAIN_ID;

    address public signer; // compliance signer (→ rotable por el owner)
    address public owner;
    address public pendingOwner;

    mapping(address => uint48) public expiryOf; // 0 = nunca atestado
    mapping(address => uint48) public revokedAt; // 0 = no revocado
    mapping(address => uint256) public nonceOf; // anti-replay por cuenta

    event Attested(address indexed account, uint48 expiry);
    event Revoked(address indexed account, uint48 at);
    event SignerChanged(address signer);
    event OwnershipTransferStarted(address indexed to);
    event OwnershipTransferred(address indexed to);

    error NotOwner();
    error NotSigner();
    error ZeroAddress();
    error BadSignature();
    error Expired();
    error BadNonce();

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    constructor(address signer_) {
        if (signer_ == address(0)) revert ZeroAddress();
        owner = msg.sender;
        signer = signer_;
        _CACHED_CHAIN_ID = block.chainid;
        _CACHED_DOMAIN_SEPARATOR = _buildDomainSeparator();
    }

    /// @dev Cachea el separator pero lo recomputa si la chain forkeó (patrón OZ, G3): evita replay
    /// cross-fork de atestaciones manteniendo el camino común barato.
    function DOMAIN_SEPARATOR() public view returns (bytes32) {
        return block.chainid == _CACHED_CHAIN_ID ? _CACHED_DOMAIN_SEPARATOR : _buildDomainSeparator();
    }

    function _buildDomainSeparator() internal view returns (bytes32) {
        return keccak256(
            abi.encode(
                keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
                keccak256("RobinFund EligibilityGate"),
                keccak256("1"),
                block.chainid,
                address(this)
            )
        );
    }

    // ---------- Atestación ----------

    /// @notice Registra una atestación firmada por el signer. Permissionless (cualquiera la envía);
    /// la firma es la autorización. `expiry` debe ser futuro; `nonce` debe ser el esperado (monótono).
    function attest(address account, uint48 expiry, uint256 nonce, bytes calldata signature) external {
        if (expiry <= block.timestamp) revert Expired();
        if (nonce != nonceOf[account]) revert BadNonce();

        bytes32 structHash = keccak256(abi.encode(ATTESTATION_TYPEHASH, account, expiry, nonce));
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", DOMAIN_SEPARATOR(), structHash));
        if (_recover(digest, signature) != signer) revert BadSignature();

        nonceOf[account] = nonce + 1;
        expiryOf[account] = expiry;
        revokedAt[account] = 0; // una re-atestación limpia una revocación previa
        emit Attested(account, expiry);
    }

    /// @notice El signer revoca una atestación (compromiso, cambio de estatus del titular).
    /// AVANZA el nonce (G1): toda firma pre-emitida al nonce viejo queda inválida, así que re-habilitar
    /// exige que el signer firme el nonce NUEVO *después* de la revocación — una re-atestación con una
    /// firma anterior a la revocación (renovación pre-firmada, atestación inicial no enviada) ya no
    /// puede deshacer la revocación. Sin esto, cualquier firma viva evadía el control de compliance.
    function revoke(address account) external {
        if (msg.sender != signer) revert NotSigner();
        revokedAt[account] = uint48(block.timestamp);
        nonceOf[account] += 1;
        emit Revoked(account, uint48(block.timestamp));
    }

    // ---------- Vistas (consumidas por el Fund) ----------

    function isEligible(address account) external view returns (bool) {
        return revokedAt[account] == 0 && expiryOf[account] > block.timestamp;
    }

    /// @notice Timestamp desde el que la cuenta es inelegible (para la gracia de §10.2); 0 si elegible
    /// o si nunca fue atestada (no puede tener shares).
    function ineligibleSince(address account) external view returns (uint48) {
        if (revokedAt[account] != 0) return revokedAt[account];
        uint48 exp = expiryOf[account];
        if (exp != 0 && exp <= block.timestamp) return exp;
        return 0;
    }

    // ---------- Gobernanza ----------

    function setSigner(address signer_) external onlyOwner {
        if (signer_ == address(0)) revert ZeroAddress();
        signer = signer_;
        emit SignerChanged(signer_);
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

    // ---------- Interno ----------

    function _recover(bytes32 digest, bytes calldata sig) internal pure returns (address) {
        if (sig.length != 65) revert BadSignature();
        bytes32 r;
        bytes32 s;
        uint8 v;
        assembly {
            r := calldataload(sig.offset)
            s := calldataload(add(sig.offset, 32))
            v := byte(0, calldataload(add(sig.offset, 64)))
        }
        // rechazar s alto (malleability, EIP-2)
        if (uint256(s) > 0x7FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF5D576E7357A4501DDFE92F46681B20A0) {
            revert BadSignature();
        }
        address rec = ecrecover(digest, v, r, s);
        if (rec == address(0)) revert BadSignature();
        return rec;
    }
}
