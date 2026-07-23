// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {AgentRegistry} from "../../../src/agents/AgentRegistry.sol";

contract ControllerStub {}

contract AgentRegistryTest is Test {
    uint256 internal constant WORLD_PK = 0xA11CE;
    uint256 internal constant AGENT_PK = 0xB0B;
    uint256 internal constant NEXT_AGENT_PK = 0xC0DE;
    bytes32 internal constant AGENT_ID = keccak256("atlas.nuvem.agent");

    AgentRegistry internal registry;
    address internal sponsor = address(0x5A0A50);

    function setUp() public {
        vm.warp(1_800_000_000);
        registry = new AgentRegistry(vm.addr(WORLD_PK));
        vm.prank(sponsor);
        registry.register(AGENT_ID, vm.addr(AGENT_PK), "ipfs://agent-metadata");
    }

    function test_world_backing_activa_y_expira() public {
        _activate(vm.addr(AGENT_PK), block.timestamp + 7 days);
        assertTrue(registry.isActive(AGENT_ID));

        AgentRegistry.Agent memory agent = registry.getAgent(AGENT_ID);
        assertEq(agent.sponsor, sponsor);
        assertEq(agent.signer, vm.addr(AGENT_PK));
        assertEq(agent.agentBookBlock, 12_345);
        assertEq(agent.backingHash, keccak256("world-proof"));

        vm.warp(block.timestamp + 7 days + 1);
        assertFalse(registry.isActive(AGENT_ID));
    }

    function test_firma_world_falsa_y_replay_revierten() public {
        AgentRegistry.WorldBacking memory backing = _backing(vm.addr(AGENT_PK), block.timestamp + 1 days);
        bytes memory forged = _sign(AGENT_PK, registry.hashWorldBacking(backing));
        vm.expectRevert(AgentRegistry.BadSignature.selector);
        registry.activate(backing, forged);

        bytes memory valid = _sign(WORLD_PK, registry.hashWorldBacking(backing));
        registry.activate(backing, valid);
        vm.expectRevert(AgentRegistry.BadBacking.selector);
        registry.activate(backing, valid);
    }

    function test_rotacion_invalida_clave_y_backing_anteriores() public {
        _activate(vm.addr(AGENT_PK), block.timestamp + 30 days);
        AgentRegistry.WorldBacking memory stale = _backing(vm.addr(AGENT_PK), block.timestamp + 30 days);
        bytes memory staleSig = _sign(WORLD_PK, registry.hashWorldBacking(stale));

        vm.prank(sponsor);
        registry.rotateSigner(AGENT_ID, vm.addr(NEXT_AGENT_PK));
        assertFalse(registry.isActive(AGENT_ID));
        assertEq(registry.signerOf(AGENT_ID), vm.addr(NEXT_AGENT_PK));

        vm.expectRevert(AgentRegistry.BadBacking.selector);
        registry.activate(stale, staleSig);
        _activate(vm.addr(NEXT_AGENT_PK), block.timestamp + 30 days);
        assertTrue(registry.isActive(AGENT_ID));
    }

    function test_pausa_inmediata_y_resume_exige_backing_nuevo() public {
        _activate(vm.addr(AGENT_PK), block.timestamp + 30 days);
        vm.prank(sponsor);
        registry.pause(AGENT_ID);
        assertFalse(registry.isActive(AGENT_ID));

        vm.prank(sponsor);
        registry.resume(AGENT_ID);
        assertFalse(registry.isActive(AGENT_ID));
        _activate(vm.addr(AGENT_PK), block.timestamp + 30 days);
        assertTrue(registry.isActive(AGENT_ID));
    }

    function test_solo_sponsor_vincula_controller() public {
        address controller = address(new ControllerStub());
        vm.expectRevert(AgentRegistry.NotSponsor.selector);
        registry.setController(AGENT_ID, controller, true);

        vm.prank(sponsor);
        registry.setController(AGENT_ID, controller, true);
        assertTrue(registry.controllers(AGENT_ID, controller));
    }

    function _activate(address signer, uint256 validUntil) internal {
        AgentRegistry.WorldBacking memory backing = _backing(signer, validUntil);
        registry.activate(backing, _sign(WORLD_PK, registry.hashWorldBacking(backing)));
    }

    function _backing(address signer, uint256 validUntil)
        internal
        view
        returns (AgentRegistry.WorldBacking memory)
    {
        return AgentRegistry.WorldBacking({
            agentId: AGENT_ID,
            sponsor: sponsor,
            signer: signer,
            backingHash: keccak256("world-proof"),
            agentBookBlock: 12_345,
            validUntil: uint48(validUntil),
            nonce: registry.backingNonce(AGENT_ID)
        });
    }

    function _sign(uint256 privateKey, bytes32 digest) internal returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(privateKey, digest);
        return abi.encodePacked(r, s, v);
    }
}
