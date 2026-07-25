import { Address, BigInt, Bytes } from "@graphprotocol/graph-ts";
import {
  AgentVaultController,
  FundBound,
  Paused,
  PolicyActivated,
  PolicyCancelled,
  PolicyProposed,
  TradeExecuted,
} from "../generated/templates/AgentVaultController/AgentVaultController";
import { Fund } from "../generated/templates/AgentVaultController/Fund";
import { AgentFundSnapshot } from "../generated/templates";
import { Agent, AgentController, Holding, Policy, Trade, Vault } from "../generated/schema";

function controllerEntity(address: string): AgentController | null {
  return AgentController.load(address);
}

function holding(vault: Vault, tokenHex: string, tokenBytes: Bytes, timestamp: BigInt): Holding {
  const id = vault.id + "-" + tokenHex;
  let entity = Holding.load(id);
  if (entity == null) {
    entity = new Holding(id);
    entity.vault = vault.id;
    entity.token = tokenBytes;
    entity.balance = BigInt.zero();
    entity.valueWad = BigInt.zero();
    entity.valid = false;
    entity.observedAt = timestamp;
  }
  entity.valid = false;
  entity.observedAt = timestamp;
  entity.updatedAt = timestamp;
  return entity;
}

export function handleFundBound(event: FundBound): void {
  const id = event.address.toHexString();
  const controller = controllerEntity(id);
  if (controller == null) return;
  controller.fund = event.params.fund;
  controller.updatedAt = event.block.timestamp;
  controller.save();

  const vault = Vault.load(event.params.fund.toHexString());
  if (vault == null) return;
  vault.controller = event.address;
  vault.controllerRecord = controller.id;
  vault.managerType = "agent";
  vault.isAgent = true;
  const agent = Agent.load(controller.agent);
  if (agent != null) {
    vault.agentId = agent.agentId;
    vault.agent = agent.id;
  }
  const policyHash = controller.policyHash;
  if (policyHash) vault.policy = controller.id + "-" + policyHash.toHexString();
  vault.updatedAt = event.block.timestamp;
  vault.save();
  // Only AI-managed Funds receive a polling data source. Historical human
  // Funds remain event-only, avoiding one block handler per registry entry.
  AgentFundSnapshot.create(event.params.fund);
}

export function handleTradeExecuted(event: TradeExecuted): void {
  const controller = controllerEntity(event.address.toHexString());
  if (controller == null) return;
  const fund = controller.fund;
  if (!fund) return;
  const vault = Vault.load(fund.toHexString());
  if (vault == null) return;

  const input = holding(vault, event.params.tokenIn.toHexString(), event.params.tokenIn, event.block.timestamp);
  input.balance = input.balance.ge(event.params.spent) ? input.balance.minus(event.params.spent) : BigInt.zero();
  input.valueWad = input.valueWad.ge(event.params.spentValueWad)
    ? input.valueWad.minus(event.params.spentValueWad) : BigInt.zero();
  input.save();
  const output = holding(vault, event.params.tokenOut.toHexString(), event.params.tokenOut, event.block.timestamp);
  output.balance = output.balance.plus(event.params.received);
  output.valueWad = output.valueWad.plus(event.params.receivedValueWad);
  output.save();

  const id = event.transaction.hash.toHexString() + "-" + event.logIndex.toString();
  const trade = new Trade(id);
  trade.vault = vault.id;
  trade.controller = event.address;
  trade.agentId = vault.agentId;
  trade.nonce = event.params.nonce;
  trade.evidenceHash = event.params.evidenceHash;
  trade.relayer = event.params.relayer;
  trade.tokenIn = event.params.tokenIn;
  trade.tokenOut = event.params.tokenOut;
  trade.spent = event.params.spent;
  trade.received = event.params.received;
  trade.spentValueWad = event.params.spentValueWad;
  trade.receivedValueWad = event.params.receivedValueWad;
  trade.adverseWad = event.params.spentValueWad.gt(event.params.receivedValueWad)
    ? event.params.spentValueWad.minus(event.params.receivedValueWad) : BigInt.zero();
  trade.transactionHash = event.transaction.hash;
  trade.blockNumber = event.block.number;
  trade.timestamp = event.block.timestamp;
  trade.save();

  const contract = AgentVaultController.bind(event.address);
  const turnover = contract.try_turnoverTodayWad();
  if (!turnover.reverted) vault.turnoverTodayWad = turnover.value;
  const count = contract.try_tradesToday();
  if (!count.reverted) vault.tradesToday = count.value;
  const last = contract.try_lastTradeAt();
  if (!last.reverted) vault.lastTradeAt = last.value;
  const nav = Fund.bind(Address.fromBytes(fund)).try_nav();
  vault.navObservedAt = event.block.timestamp;
  if (nav.reverted || !nav.value.valid) {
    vault.navValid = false;
  } else {
    vault.navWad = nav.value.navWad;
    vault.navValid = true;
    vault.navUpdatedAt = event.block.timestamp;
  }
  vault.updatedAt = event.block.timestamp;
  vault.save();
}

export function handlePaused(event: Paused): void {
  const controller = controllerEntity(event.address.toHexString());
  if (controller == null) return;
  controller.paused = event.params.paused;
  controller.updatedAt = event.block.timestamp;
  controller.save();
}

export function handlePolicyProposed(event: PolicyProposed): void {
  const controller = controllerEntity(event.address.toHexString());
  if (controller == null) return;
  controller.pendingPolicyHash = event.params.policyHash;
  controller.pendingPolicyEta = event.params.executableAt;
  controller.updatedAt = event.block.timestamp;
  controller.save();
}

export function handlePolicyCancelled(event: PolicyCancelled): void {
  const controller = controllerEntity(event.address.toHexString());
  if (controller == null) return;
  controller.pendingPolicyHash = null;
  controller.pendingPolicyEta = null;
  controller.updatedAt = event.block.timestamp;
  controller.save();
}

export function handlePolicyActivated(event: PolicyActivated): void {
  const controller = controllerEntity(event.address.toHexString());
  if (controller == null) return;
  const contract = AgentVaultController.bind(event.address);
  const current = contract.try_policy();
  if (current.reverted) return;
  const policyId = event.address.toHexString() + "-" + event.params.policyHash.toHexString();
  const policy = new Policy(policyId);
  policy.controller = event.address;
  policy.policyHash = event.params.policyHash;
  policy.maxTradeBps = current.value.getMaxTradeBps();
  policy.maxConcentrationBps = current.value.getMaxConcentrationBps();
  policy.dailyTurnoverBps = current.value.getDailyTurnoverBps();
  policy.maxSlippageBps = current.value.getMaxSlippageBps();
  policy.maxTradesPerDay = current.value.getMaxTradesPerDay();
  policy.minTradeInterval = current.value.getMinTradeInterval().toI32();
  policy.maxIntentLifetime = current.value.getMaxIntentLifetime().toI32();
  policy.activatedAt = event.block.timestamp;
  policy.save();

  controller.policyHash = event.params.policyHash;
  controller.pendingPolicyHash = null;
  controller.pendingPolicyEta = null;
  controller.updatedAt = event.block.timestamp;
  controller.save();
  const fund = controller.fund;
  if (fund) {
    const vault = Vault.load(fund.toHexString());
    if (vault != null) {
      vault.policy = policyId;
      vault.updatedAt = event.block.timestamp;
      vault.save();
    }
  }
}
