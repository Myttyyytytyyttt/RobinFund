import { Address, BigInt, dataSource, ethereum, store } from "@graphprotocol/graph-ts";
import { AggregatorV3 } from "../generated/templates/Fund/AggregatorV3";
import { ERC20 } from "../generated/templates/Fund/ERC20";
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
import { TokenRegistry } from "../generated/templates/Fund/TokenRegistry";
import {
  Holding,
  PendingEntryFee,
  PendingInKindExit,
  Settlement,
  Trade,
  Vault,
} from "../generated/schema";

const USDG_TO_WAD = BigInt.fromString("1000000000000");
const FEED_UNIT = BigInt.fromString("100000000");
const WAD = BigInt.fromString("1000000000000000000");
const MAX_ASSETS = 32;

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
    entity.valid = false;
    entity.observedAt = timestamp;
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

function syncNav(vault: Vault, fundAddress: Address, timestamp: BigInt): void {
  const snapshot = Fund.bind(fundAddress).try_nav();
  vault.navObservedAt = timestamp;
  if (snapshot.reverted || !snapshot.value.valid) {
    vault.navValid = false;
    return;
  }
  vault.navWad = snapshot.value.navWad;
  vault.navValid = true;
  vault.navUpdatedAt = timestamp;
}

function syncHolding(vault: Vault, fundAddress: Address, token: Address, timestamp: BigInt): void {
  const entity = holding(vault, token, timestamp);
  entity.observedAt = timestamp;
  entity.valid = false;

  const balance = ERC20.bind(token).try_balanceOf(fundAddress);
  if (balance.reverted) {
    entity.save();
    return;
  }
  entity.balance = balance.value;

  const stable = usdg(vault, fundAddress);
  if (!stable.equals(Address.zero()) && token.equals(stable)) {
    entity.valueWad = balance.value.times(USDG_TO_WAD);
    entity.valid = true;
    entity.save();
    return;
  }

  const registryAddress = Fund.bind(fundAddress).try_REGISTRY();
  if (registryAddress.reverted) {
    entity.save();
    return;
  }
  const asset = TokenRegistry.bind(registryAddress.value).try_getAsset(token);
  if (asset.reverted) {
    entity.save();
    return;
  }
  const config = asset.value;
  const feed = config.feed;
  if (feed.equals(Address.zero())) {
    entity.save();
    return;
  }
  const latest = AggregatorV3.bind(feed).try_latestRoundData();
  if (latest.reverted) {
    entity.save();
    return;
  }
  const answer = latest.value.getAnswer();
  const updatedAt = latest.value.getUpdatedAt();
  const inBand = answer.gt(BigInt.zero())
    && answer.ge(config.minAnswer)
    && answer.le(config.maxAnswer);
  if (inBand) entity.valueWad = balance.value.times(answer).div(FEED_UNIT);
  const fresh = updatedAt.le(timestamp)
    && timestamp.minus(updatedAt).le(config.maxStaleness);
  entity.valid = config.listed && !config.suspended && inBand && fresh;
  entity.save();
}

function syncAllHoldings(vault: Vault, fundAddress: Address, timestamp: BigInt): void {
  const stable = usdg(vault, fundAddress);
  if (!stable.equals(Address.zero())) syncHolding(vault, fundAddress, stable, timestamp);
  const contract = Fund.bind(fundAddress);
  const countResult = contract.try_assetCount();
  if (countResult.reverted) return;
  const count = countResult.value.toI32() < MAX_ASSETS ? countResult.value.toI32() : MAX_ASSETS;
  for (let index = 0; index < count; index++) {
    const token = contract.try_assets(BigInt.fromI32(index));
    if (!token.reverted) syncHolding(vault, fundAddress, token.value, timestamp);
  }
}

export function handleEntryFeeCharged(event: EntryFeeCharged): void {
  const id = event.address.toHexString() + "-" + event.params.orderId.toString();
  const pending = new PendingEntryFee(id);
  // The unallocated part of fee6 remains inside the Fund. Only these two
  // distributions must be removed from the Fund's USDG balance.
  pending.fee6 = event.params.toManager6.plus(event.params.toProtocol6);
  pending.save();
}

export function handleDepositExecuted(event: DepositExecuted): void {
  const vault = vaultFor(event.address);
  if (vault == null) return;
  const pendingId = event.address.toHexString() + "-" + event.params.orderId.toString();
  const fee = PendingEntryFee.load(pendingId);
  let externallyPaid6 = BigInt.zero();
  if (fee != null) externallyPaid6 = fee.fee6;
  if (fee != null) store.remove("PendingEntryFee", pendingId);
  const net6 = subtractFloor(event.params.amount6, externallyPaid6);

  vault.totalShares = vault.totalShares.plus(event.params.sharesMinted);
  vault.lifetimeDeposited6 = vault.lifetimeDeposited6.plus(event.params.amount6);
  vault.navWad = vault.navWad.plus(net6.times(USDG_TO_WAD));
  syncNav(vault, event.address, event.block.timestamp);
  const token = usdg(vault, event.address);
  if (!token.equals(Address.zero())) syncHolding(vault, event.address, token, event.block.timestamp);
  vault.updatedAt = event.block.timestamp;
  vault.save();
}

export function handleInKindSlice(event: InKindSlice): void {
  const vault = vaultFor(event.address);
  if (vault == null) return;
  vault.navWad = subtractFloor(vault.navWad, event.params.valueWad);
  syncNav(vault, event.address, event.block.timestamp);
  syncHolding(vault, event.address, event.params.token, event.block.timestamp);
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

  const id = event.address.toHexString() + "-" + event.params.orderId.toString();
  const pending = PendingInKindExit.load(id);
  let inKind6 = BigInt.zero();
  if (pending != null) inKind6 = pending.valueWad.div(USDG_TO_WAD);
  if (pending != null) store.remove("PendingInKindExit", id);
  vault.lifetimeWithdrawn6 = vault.lifetimeWithdrawn6.plus(event.params.paid6).plus(inKind6);

  syncNav(vault, event.address, event.block.timestamp);
  const token = usdg(vault, event.address);
  if (!token.equals(Address.zero())) syncHolding(vault, event.address, token, event.block.timestamp);
  vault.updatedAt = event.block.timestamp;
  vault.save();
}

export function handlePerfFeeCrystallized(event: PerfFeeCrystallized): void {
  const vault = vaultFor(event.address);
  if (vault == null) return;
  vault.totalShares = vault.totalShares.plus(event.params.sharesMinted);
  vault.pendingPerfFeeShares = vault.pendingPerfFeeShares.plus(event.params.sharesMinted);
  syncNav(vault, event.address, event.block.timestamp);
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
  syncNav(vault, event.address, event.block.timestamp);
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
  syncHolding(vault, event.address, event.params.token, event.block.timestamp);
  vault.updatedAt = event.block.timestamp;
  vault.save();
}

export function handleFundTraded(event: Traded): void {
  const vault = vaultFor(event.address);
  if (vault == null || vault.isAgent) return;
  syncNav(vault, event.address, event.block.timestamp);
  syncHolding(vault, event.address, event.params.tokenIn, event.block.timestamp);
  syncHolding(vault, event.address, event.params.tokenOut, event.block.timestamp);
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
  syncNav(vault, address, block.timestamp);
  syncAllHoldings(vault, address, block.timestamp);
  vault.updatedAt = block.timestamp;
  vault.save();
}
