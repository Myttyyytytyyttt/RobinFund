import { Address, BigInt, Bytes, dataSource, ethereum, store } from "@graphprotocol/graph-ts";
import {
  AssetRegistered,
  DepositExecuted,
  EntryFeeCharged,
  Fund,
  InKindSlice,
  PerfFeeCrystallized,
  Settled,
  StateChanged,
  Traded,
  WindingRequested,
  WithdrawExecuted,
} from "../generated/templates/Fund/Fund";
import {
  Holding,
  PendingEntryFee,
  PendingInKindExit,
  Settlement,
  Trade,
  Vault,
} from "../generated/schema";

const USDG_TO_WAD = BigInt.fromString("1000000000000");
const WAD = BigInt.fromString("1000000000000000000");

function vaultFor(address: Address): Vault | null {
  return Vault.load(address.toHexString());
}

function holding(vault: Vault, token: Address, timestamp: BigInt): Holding {
  const id = vault.id + "-" + token.toHexString();
  let entity = Holding.load(id);
  if (entity == null) {
    entity = new Holding(id);
    entity.vault = vault.id;
    entity.token = token;
    entity.balance = BigInt.zero();
    entity.valueWad = BigInt.zero();
  }
  entity.updatedAt = timestamp;
  return entity;
}

function usdg(vault: Vault, fundAddress: Address): Address {
  const result = Fund.bind(fundAddress).try_USDG();
  if (result.reverted) return Address.zero();
  vault.usdG = result.value;
  return result.value;
}

function subtractFloor(value: BigInt, amount: BigInt): BigInt {
  return value.ge(amount) ? value.minus(amount) : BigInt.zero();
}

export function handleEntryFeeCharged(event: EntryFeeCharged): void {
  const id = event.address.toHexString() + "-" + event.params.orderId.toString();
  const pending = new PendingEntryFee(id);
  pending.fee6 = event.params.fee6;
  pending.save();
}

export function handleDepositExecuted(event: DepositExecuted): void {
  const vault = vaultFor(event.address);
  if (vault == null) return;
  const pendingId = event.address.toHexString() + "-" + event.params.orderId.toString();
  const fee = PendingEntryFee.load(pendingId);
  let fee6 = BigInt.zero();
  if (fee != null) fee6 = fee.fee6;
  const net6 = subtractFloor(event.params.amount6, fee6);
  if (fee != null) store.remove("PendingEntryFee", pendingId);
  const token = usdg(vault, event.address);
  if (!token.equals(Address.zero())) {
    const entity = holding(vault, token, event.block.timestamp);
    entity.balance = entity.balance.plus(net6);
    entity.valueWad = entity.valueWad.plus(net6.times(USDG_TO_WAD));
    entity.save();
  }
  vault.totalShares = vault.totalShares.plus(event.params.sharesMinted);
  vault.lifetimeDeposited6 = vault.lifetimeDeposited6.plus(event.params.amount6);
  vault.navWad = vault.navWad.plus(net6.times(USDG_TO_WAD));
  vault.updatedAt = event.block.timestamp;
  vault.save();
}

export function handleInKindSlice(event: InKindSlice): void {
  const vault = vaultFor(event.address);
  if (vault == null) return;
  const entity = holding(vault, event.params.token, event.block.timestamp);
  entity.balance = subtractFloor(entity.balance, event.params.amount);
  entity.valueWad = subtractFloor(entity.valueWad, event.params.valueWad);
  entity.save();
  vault.navWad = subtractFloor(vault.navWad, event.params.valueWad);
  vault.updatedAt = event.block.timestamp;
  vault.save();

  const id = event.address.toHexString() + "-" + event.params.orderId.toString();
  let pending = PendingInKindExit.load(id);
  if (pending == null) {
    pending = new PendingInKindExit(id);
    pending.valueWad = BigInt.zero();
  }
  pending.valueWad = pending.valueWad.plus(event.params.valueWad);
  pending.save();
}

export function handleWithdrawExecuted(event: WithdrawExecuted): void {
  const vault = vaultFor(event.address);
  if (vault == null) return;
  vault.totalShares = subtractFloor(vault.totalShares, event.params.shares);
  const paidWad = event.params.paid6.times(USDG_TO_WAD);
  vault.navWad = subtractFloor(vault.navWad, paidWad);
  const token = usdg(vault, event.address);
  if (!token.equals(Address.zero())) {
    const entity = holding(vault, token, event.block.timestamp);
    entity.balance = subtractFloor(entity.balance, event.params.paid6);
    entity.valueWad = subtractFloor(entity.valueWad, paidWad);
    entity.save();
  }
  const id = event.address.toHexString() + "-" + event.params.orderId.toString();
  const pending = PendingInKindExit.load(id);
  let inKind6 = BigInt.zero();
  if (pending != null) inKind6 = pending.valueWad.div(USDG_TO_WAD);
  if (pending != null) store.remove("PendingInKindExit", id);
  vault.lifetimeWithdrawn6 = vault.lifetimeWithdrawn6.plus(event.params.paid6).plus(inKind6);
  vault.updatedAt = event.block.timestamp;
  vault.save();
}

export function handlePerfFeeCrystallized(event: PerfFeeCrystallized): void {
  const vault = vaultFor(event.address);
  if (vault == null) return;
  vault.totalShares = vault.totalShares.plus(event.params.sharesMinted);
  vault.pendingPerfFeeShares = vault.pendingPerfFeeShares.plus(event.params.sharesMinted);
  vault.updatedAt = event.block.timestamp;
  vault.save();
}

export function handleSettled(event: Settled): void {
  const vault = vaultFor(event.address);
  if (vault == null) return;
  const preFeeSupply = subtractFloor(vault.totalShares, vault.pendingPerfFeeShares);
  const navWad = event.params.peWad.times(preFeeSupply).div(WAD);
  vault.navWad = navWad;
  vault.lastPeWad = event.params.peWad;
  vault.pendingPerfFeeShares = BigInt.zero();
  vault.turnoverTodayWad = BigInt.zero();
  vault.updatedAt = event.block.timestamp;
  vault.save();

  const id = event.address.toHexString() + "-" + event.params.period.toString();
  const settlement = new Settlement(id);
  settlement.vault = vault.id;
  settlement.period = event.params.period;
  settlement.peWad = event.params.peWad;
  settlement.navWad = navWad;
  settlement.fundingWad = event.params.fundingWad;
  settlement.lambdaWad = event.params.lambdaWad;
  settlement.degraded = event.params.degraded;
  settlement.transactionHash = event.transaction.hash;
  settlement.timestamp = event.block.timestamp;
  settlement.save();
}

export function handleAssetRegistered(event: AssetRegistered): void {
  const vault = vaultFor(event.address);
  if (vault == null) return;
  holding(vault, event.params.token, event.block.timestamp).save();
}

export function handleFundTraded(event: Traded): void {
  const vault = vaultFor(event.address);
  if (vault == null) return;
  if (vault.isAgent) return;
  const input = holding(vault, event.params.tokenIn, event.block.timestamp);
  input.balance = subtractFloor(input.balance, event.params.spent);
  input.save();
  const output = holding(vault, event.params.tokenOut, event.block.timestamp);
  output.balance = output.balance.plus(event.params.received);
  output.save();
  vault.navWad = subtractFloor(vault.navWad, event.params.adverseWad);
  vault.updatedAt = event.block.timestamp;
  vault.save();

  const id = event.transaction.hash.toHexString() + "-" + event.logIndex.toString();
  const trade = new Trade(id);
  trade.vault = vault.id;
  trade.adapterId = event.params.adapterId;
  trade.tokenIn = event.params.tokenIn;
  trade.tokenOut = event.params.tokenOut;
  trade.spent = event.params.spent;
  trade.received = event.params.received;
  trade.spentValueWad = BigInt.zero();
  trade.receivedValueWad = BigInt.zero();
  trade.adverseWad = event.params.adverseWad;
  trade.transactionHash = event.transaction.hash;
  trade.blockNumber = event.block.number;
  trade.timestamp = event.block.timestamp;
  trade.save();
}

export function handleWindingRequested(event: WindingRequested): void {
  const vault = vaultFor(event.address);
  if (vault == null) return;
  vault.state = 1;
  vault.updatedAt = event.block.timestamp;
  vault.save();
}

export function handleStateChanged(event: StateChanged): void {
  const vault = vaultFor(event.address);
  if (vault == null) return;
  vault.state = event.params.newState;
  vault.updatedAt = event.block.timestamp;
  vault.save();
}

export function handleBlock(block: ethereum.Block): void {
  const address = dataSource.address();
  const vault = vaultFor(address);
  if (vault == null) return;
  const snapshot = Fund.bind(address).try_nav();
  if (snapshot.reverted) return;
  if (snapshot.value.valid) vault.navWad = snapshot.value.navWad;
  vault.updatedAt = block.timestamp;
  vault.save();
}
