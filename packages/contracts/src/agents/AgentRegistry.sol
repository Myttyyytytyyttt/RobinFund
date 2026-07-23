// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

/// @title AgentRegistry
/// @notice Registro compartido de agentes que administran vaults de NuvemFund. El sponsor conserva
/// el control operativo; World backing solo activa la capacidad de operar públicamente.
contract AgentRegistry {
    enum Status {
        PendingBacking,
        Active,
        Paused,
        Retired
    }

    struct Agent {
        address sponsor;
        address signer;
        bytes32 backingHash;
        uint64 agentBookBlock;
        uint48 backedUntil;
        Status status;
        string metadataURI;
    }

    struct WorldBacking {
        bytes32 agentId;
        address sponsor;
        address signer;
        bytes32 backingHash;
        uint64 agentBookBlock;
        uint48 validUntil;
        uint256 nonce;
    }

    bytes32 public constant WORLD_BACKING_TYPEHASH = keccak256(
        "WorldBacking(bytes32 agentId,address sponsor,address signer,bytes32 backingHash,uint64 agentBookBlock,uint48 validUntil,uint256 nonce)"
    );
    bytes32 private constant DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");
    bytes32 private constant NAME_HASH = keccak256("Nuvem AgentRegistry");
    bytes32 private constant VERSION_HASH = keccak256("1");
    bytes32 private constant EIP1271_MAGICVALUE = 0x1626ba7e00000000000000000000000000000000000000000000000000000000;
    uint256 private constant SECP256K1N_HALF =
        0x7fffffffffffffffffffffffffffffff5d576e7357a4501ddfe92f46681b20a0;

    address public immutable WORLD_VERIFIER;
    mapping(bytes32 => Agent) private _agents;
    mapping(bytes32 => uint256) public backingNonce;
    mapping(bytes32 => mapping(address => bool)) public controllers;

    event AgentRegistered(bytes32 indexed agentId, address indexed sponsor, address indexed signer, string metadataURI);
    event WorldBackingAccepted(
        bytes32 indexed agentId, bytes32 indexed backingHash, uint64 agentBookBlock, uint48 validUntil
    );
    event SignerRotated(bytes32 indexed agentId, address indexed oldSigner, address indexed newSigner);
    event ControllerSet(bytes32 indexed agentId, address indexed controller, bool enabled);
    event MetadataUpdated(bytes32 indexed agentId, string metadataURI);
    event StatusChanged(bytes32 indexed agentId, Status status);

    error ZeroAddress();
    error BadAgentId();
    error AlreadyRegistered();
    error UnknownAgent();
    error NotSponsor();
    error BadStatus();
    error BadBacking();
    error BadSignature();
    error InvalidController();

    constructor(address worldVerifier_) {
        if (worldVerifier_ == address(0)) revert ZeroAddress();
        WORLD_VERIFIER = worldVerifier_;
    }

    function register(bytes32 agentId, address signer, string calldata metadataURI) external {
        if (agentId == bytes32(0)) revert BadAgentId();
        if (signer == address(0)) revert ZeroAddress();
        if (_agents[agentId].sponsor != address(0)) revert AlreadyRegistered();

        _agents[agentId] = Agent({
            sponsor: msg.sender,
            signer: signer,
            backingHash: bytes32(0),
            agentBookBlock: 0,
            backedUntil: 0,
            status: Status.PendingBacking,
            metadataURI: metadataURI
        });
        emit AgentRegistered(agentId, msg.sender, signer, metadataURI);
    }

    /// @notice Permissionless submission: la autorización proviene exclusivamente del verificador
    /// World de Nuvem y queda ligada a chainId, registry, sponsor, signer y nonce actuales.
    function activate(WorldBacking calldata backing, bytes calldata signature) external {
        Agent storage agent = _agent(backing.agentId);
        if (agent.status != Status.PendingBacking && agent.status != Status.Active) revert BadStatus();
        if (
            backing.sponsor != agent.sponsor || backing.signer != agent.signer || backing.backingHash == bytes32(0)
                || backing.agentBookBlock == 0 || backing.validUntil <= block.timestamp
                || backing.nonce != backingNonce[backing.agentId]
        ) revert BadBacking();

        bytes32 digest = _hashTypedData(_hashWorldBacking(backing));
        if (!_isValidSignatureNow(WORLD_VERIFIER, digest, signature)) revert BadSignature();

        backingNonce[backing.agentId] = backing.nonce + 1;
        agent.backingHash = backing.backingHash;
        agent.agentBookBlock = backing.agentBookBlock;
        agent.backedUntil = backing.validUntil;
        agent.status = Status.Active;
        emit WorldBackingAccepted(
            backing.agentId, backing.backingHash, backing.agentBookBlock, backing.validUntil
        );
        emit StatusChanged(backing.agentId, Status.Active);
    }

    /// @notice La clave vieja queda inválida inmediatamente. La nueva requiere un backing fresco
    /// porque la atestación World también está ligada al signer.
    function rotateSigner(bytes32 agentId, address newSigner) external {
        Agent storage agent = _onlySponsor(agentId);
        if (agent.status == Status.Retired) revert BadStatus();
        if (newSigner == address(0)) revert ZeroAddress();
        address oldSigner = agent.signer;
        if (newSigner == oldSigner) revert BadBacking();

        agent.signer = newSigner;
        agent.backingHash = bytes32(0);
        agent.agentBookBlock = 0;
        agent.backedUntil = 0;
        agent.status = Status.PendingBacking;
        backingNonce[agentId]++;
        emit SignerRotated(agentId, oldSigner, newSigner);
        emit StatusChanged(agentId, Status.PendingBacking);
    }

    function setController(bytes32 agentId, address controller, bool enabled) external {
        _onlySponsor(agentId);
        if (controller == address(0) || (enabled && controller.code.length == 0)) revert InvalidController();
        controllers[agentId][controller] = enabled;
        emit ControllerSet(agentId, controller, enabled);
    }

    function updateMetadata(bytes32 agentId, string calldata metadataURI) external {
        Agent storage agent = _onlySponsor(agentId);
        if (agent.status == Status.Retired) revert BadStatus();
        agent.metadataURI = metadataURI;
        emit MetadataUpdated(agentId, metadataURI);
    }

    function pause(bytes32 agentId) external {
        Agent storage agent = _onlySponsor(agentId);
        if (agent.status == Status.Retired) revert BadStatus();
        agent.status = Status.Paused;
        backingNonce[agentId]++;
        emit StatusChanged(agentId, Status.Paused);
    }

    /// @notice Reanudar vuelve a PendingBacking: una atestación obtenida antes de la pausa no sirve.
    function resume(bytes32 agentId) external {
        Agent storage agent = _onlySponsor(agentId);
        if (agent.status != Status.Paused) revert BadStatus();
        agent.backingHash = bytes32(0);
        agent.agentBookBlock = 0;
        agent.backedUntil = 0;
        agent.status = Status.PendingBacking;
        backingNonce[agentId]++;
        emit StatusChanged(agentId, Status.PendingBacking);
    }

    function retire(bytes32 agentId) external {
        Agent storage agent = _onlySponsor(agentId);
        if (agent.status == Status.Retired) revert BadStatus();
        agent.status = Status.Retired;
        agent.backedUntil = 0;
        backingNonce[agentId]++;
        emit StatusChanged(agentId, Status.Retired);
    }

    function getAgent(bytes32 agentId) external view returns (Agent memory) {
        return _agentView(agentId);
    }

    function sponsorOf(bytes32 agentId) external view returns (address) {
        return _agentView(agentId).sponsor;
    }

    function signerOf(bytes32 agentId) external view returns (address) {
        return _agentView(agentId).signer;
    }

    function isActive(bytes32 agentId) public view returns (bool) {
        Agent storage agent = _agents[agentId];
        return agent.sponsor != address(0) && agent.status == Status.Active && agent.backedUntil >= block.timestamp;
    }

    function hashWorldBacking(WorldBacking calldata backing) external view returns (bytes32) {
        return _hashTypedData(_hashWorldBacking(backing));
    }

    function domainSeparator() public view returns (bytes32) {
        return keccak256(abi.encode(DOMAIN_TYPEHASH, NAME_HASH, VERSION_HASH, block.chainid, address(this)));
    }

    function _hashWorldBacking(WorldBacking calldata backing) private pure returns (bytes32) {
        return keccak256(
            abi.encode(
                WORLD_BACKING_TYPEHASH,
                backing.agentId,
                backing.sponsor,
                backing.signer,
                backing.backingHash,
                backing.agentBookBlock,
                backing.validUntil,
                backing.nonce
            )
        );
    }

    function _hashTypedData(bytes32 structHash) private view returns (bytes32) {
        return keccak256(abi.encodePacked("\x19\x01", domainSeparator(), structHash));
    }

    function _onlySponsor(bytes32 agentId) private view returns (Agent storage agent) {
        agent = _agent(agentId);
        if (msg.sender != agent.sponsor) revert NotSponsor();
    }

    function _agent(bytes32 agentId) private view returns (Agent storage agent) {
        agent = _agents[agentId];
        if (agent.sponsor == address(0)) revert UnknownAgent();
    }

    function _agentView(bytes32 agentId) private view returns (Agent memory agent) {
        agent = _agents[agentId];
        if (agent.sponsor == address(0)) revert UnknownAgent();
    }

    function _isValidSignatureNow(address signer, bytes32 digest, bytes calldata signature)
        private
        view
        returns (bool)
    {
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
}
