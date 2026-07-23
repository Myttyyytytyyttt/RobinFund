import { BigInt } from "@graphprotocol/graph-ts";
import { FundRegistered } from "../generated/FundRegistry/FundRegistry";
import { Fund as FundTemplate } from "../generated/templates";
import { Agent, AgentController, Vault } from "../generated/schema";

export function handleFundRegistered(event: FundRegistered): void {
  const id = event.params.fund.toHexString();
  let vault = Vault.load(id);
  if (vault == null) {
    vault = new Vault(id);
    vault.address = event.params.fund;
    vault.manager = event.params.manager;
    vault.managerType = "human";
    vault.isAgent = false;
    vault.state = 0;
    vault.navWad = BigInt.zero();
    vault.totalShares = BigInt.zero();
    vault.lastPeWad = BigInt.zero();
    vault.lifetimeDeposited6 = BigInt.zero();
    vault.lifetimeWithdrawn6 = BigInt.zero();
    vault.pendingPerfFeeShares = BigInt.zero();
    vault.turnoverTodayWad = BigInt.zero();
    vault.tradesToday = 0;
    vault.createdAt = event.block.timestamp;
    FundTemplate.create(event.params.fund);
  }
  const controller = AgentController.load(event.params.manager.toHexString());
  if (controller != null) {
    vault.managerType = "agent";
    vault.isAgent = true;
    vault.controller = event.params.manager;
    const agent = Agent.load(controller.agent);
    if (agent != null) vault.agentId = agent.agentId;
    controller.fund = event.params.fund;
    controller.updatedAt = event.block.timestamp;
    controller.save();
  }
  vault.updatedAt = event.block.timestamp;
  vault.save();
}
