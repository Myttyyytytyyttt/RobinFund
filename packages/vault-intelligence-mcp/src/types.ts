import type { Address, Hex } from "viem";

export interface Provenance {
  deploymentId: string;
  chainId: number;
  blockNumber: bigint;
  blockHash: Hex | null;
  blockTimestamp: Date;
  chainHeadBlock: bigint;
  blockLag: bigint;
  indexingErrors: false;
  observedAt: Date;
  ageSeconds: number;
}

export interface PolicyView {
  policyHash: Hex;
  maxTradeBps: number;
  maxConcentrationBps: number;
  dailyTurnoverBps: number;
  maxSlippageBps: number;
  maxTradesPerDay: number;
  minTradeInterval: number;
  maxIntentLifetime: number;
}

export interface VaultState {
  address: Address;
  controller: Address | null;
  controllerEnabled: boolean;
  controllerPaused: boolean;
  agentId: Hex | null;
  agentStatus: number | null;
  backedUntil: Date | null;
  managerType: "human" | "agent";
  state: number;
  navWad: bigint;
  navValid: boolean;
  navUpdatedAt: Date | null;
  navObservedAt: Date;
  totalShares: bigint;
  lastPeWad: bigint;
  lifetimeDeposited6: bigint;
  lifetimeWithdrawn6: bigint;
  policy: PolicyView | null;
  turnoverTodayWad: bigint;
  tradesToday: number;
  lastTradeAt: Date | null;
  holdings: Array<{
    token: Address;
    balance: bigint;
    valueWad: bigint;
    valid: boolean;
    observedAt: Date;
  }>;
  recentTrades: Array<{
    transactionHash: Hex;
    tokenIn: Address;
    tokenOut: Address;
    spent: bigint;
    received: bigint;
    spentValueWad: bigint;
    receivedValueWad: bigint;
    timestamp: Date;
  }>;
}

export interface IntelligenceSource {
  listVaults(limit: number): Promise<{ data: VaultState[]; provenance: Provenance }>;
  vault(address: Address): Promise<{ data: VaultState; provenance: Provenance }>;
}
