import type { Address, Hex } from "viem";

export interface Provenance {
  deploymentId: string;
  blockNumber: bigint;
  blockTimestamp: Date;
  chainHeadBlock: bigint;
  observedAt: Date;
}

export interface PolicyView {
  maxTradeBps: number;
  maxConcentrationBps: number;
  dailyTurnoverBps: number;
  maxSlippageBps: number;
  maxTradesPerDay: number;
  minTradeInterval: number;
}

export interface VaultState {
  address: Address;
  controller: Address | null;
  agentId: Hex | null;
  managerType: "human" | "agent";
  state: number;
  navWad: bigint;
  totalShares: bigint;
  lastPeWad: bigint;
  lifetimeDeposited6: bigint;
  lifetimeWithdrawn6: bigint;
  policy: PolicyView | null;
  turnoverTodayWad: bigint;
  tradesToday: number;
  lastTradeAt: Date | null;
  holdings: Array<{ token: Address; balance: bigint; valueWad: bigint }>;
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
  liquidity(tokenIn: Address, tokenOut: Address): Promise<{ data: Record<string, unknown> | null; provenance: Provenance }>;
}
