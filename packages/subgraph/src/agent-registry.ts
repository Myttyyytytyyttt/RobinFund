import { BigInt } from "@graphprotocol/graph-ts";
import {
  AgentRegistered,
  ControllerSet,
  MetadataUpdated,
  SignerRotated,
  StatusChanged,
  WorldBackingAccepted,
} from "../generated/AgentRegistry/AgentRegistry";
import { AgentVaultController as ControllerTemplate } from "../generated/templates";
import { AgentVaultController } from "../generated/templates/AgentVaultController/AgentVaultController";
import { Agent, AgentController, Policy } from "../generated/schema";

export function handleAgentRegistered(event: AgentRegistered): void {
  const id = event.params.agentId.toHexString();
  const agent = new Agent(id);
  agent.agentId = event.params.agentId;
  agent.sponsor = event.params.sponsor;
  agent.signer = event.params.signer;
  agent.metadataURI = event.params.metadataURI;
  agent.status = 0;
  agent.createdAt = event.block.timestamp;
  agent.updatedAt = event.block.timestamp;
  agent.save();
}

export function handleWorldBackingAccepted(event: WorldBackingAccepted): void {
  const agent = Agent.load(event.params.agentId.toHexString());
  if (agent == null) return;
  agent.backingHash = event.params.backingHash;
  agent.agentBookBlock = event.params.agentBookBlock;
  agent.backedUntil = event.params.validUntil;
  agent.status = 1;
  agent.updatedAt = event.block.timestamp;
  agent.save();
}

export function handleSignerRotated(event: SignerRotated): void {
  const agent = Agent.load(event.params.agentId.toHexString());
  if (agent == null) return;
  agent.signer = event.params.newSigner;
  agent.backingHash = null;
  agent.agentBookBlock = null;
  agent.backedUntil = null;
  agent.status = 0;
  agent.updatedAt = event.block.timestamp;
  agent.save();
}

export function handleControllerSet(event: ControllerSet): void {
  const id = event.params.controller.toHexString();
  let controller = AgentController.load(id);
  if (controller == null) {
    controller = new AgentController(id);
    controller.address = event.params.controller;
    controller.agent = event.params.agentId.toHexString();
    controller.enabled = event.params.enabled;
    controller.templateStarted = false;
    controller.paused = false;
    controller.createdAt = event.block.timestamp;
  }
  if (event.params.enabled && !controller.templateStarted) {
    // The constructor's PolicyActivated log predates dynamic discovery. Snapshot the canonical
    // controller state here so the initial policy is never missing from the agent data plane.
    ControllerTemplate.create(event.params.controller);
    controller.templateStarted = true;
    const contract = AgentVaultController.bind(event.params.controller);
    const sponsor = contract.try_SPONSOR();
    if (!sponsor.reverted) controller.sponsor = sponsor.value;
    const hash = contract.try_policyHash();
    const current = contract.try_policy();
    if (!hash.reverted && !current.reverted) {
      const policyId = id + "-" + hash.value.toHexString();
      const policy = new Policy(policyId);
      policy.controller = event.params.controller;
      policy.policyHash = hash.value;
      policy.maxTradeBps = current.value.getMaxTradeBps();
      policy.maxConcentrationBps = current.value.getMaxConcentrationBps();
      policy.dailyTurnoverBps = current.value.getDailyTurnoverBps();
      policy.maxSlippageBps = current.value.getMaxSlippageBps();
      policy.maxTradesPerDay = current.value.getMaxTradesPerDay();
      policy.minTradeInterval = current.value.getMinTradeInterval().toI32();
      policy.maxIntentLifetime = current.value.getMaxIntentLifetime().toI32();
      policy.activatedAt = event.block.timestamp;
      policy.save();
      controller.policyHash = hash.value;
    }
  }
  controller.agent = event.params.agentId.toHexString();
  controller.enabled = event.params.enabled;
  controller.updatedAt = event.block.timestamp;
  controller.save();
}

export function handleMetadataUpdated(event: MetadataUpdated): void {
  const agent = Agent.load(event.params.agentId.toHexString());
  if (agent == null) return;
  agent.metadataURI = event.params.metadataURI;
  agent.updatedAt = event.block.timestamp;
  agent.save();
}

export function handleStatusChanged(event: StatusChanged): void {
  const agent = Agent.load(event.params.agentId.toHexString());
  if (agent == null) return;
  agent.status = event.params.status;
  if (event.params.status == 3) agent.backedUntil = BigInt.zero();
  agent.updatedAt = event.block.timestamp;
  agent.save();
}
