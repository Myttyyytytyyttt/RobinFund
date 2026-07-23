import type { Address } from "viem";
import type { VaultState } from "./types.js";

const BPS = 10_000n;

export interface RebalanceSimulation {
  approved: boolean;
  checks: Array<{ name: string; approved: boolean; observed: string; limit: string }>;
  projectedNavWad: bigint;
  projectedOutputConcentrationBps: number;
  projectedTurnoverWad: bigint;
}

export function simulateRebalance(
  vault: VaultState,
  input: {
    tokenOut: Address;
    spentValueWad: bigint;
    receivedValueWad: bigint;
    stablecoin: Address;
    maxSlippageBps: number;
  },
): RebalanceSimulation {
  if (!vault.policy || vault.navWad <= 0n) {
    return {
      approved: false,
      checks: [{ name: "policy", approved: false, observed: "missing", limit: "active agent policy" }],
      projectedNavWad: vault.navWad,
      projectedOutputConcentrationBps: 0,
      projectedTurnoverWad: vault.turnoverTodayWad,
    };
  }
  const adverse = input.spentValueWad > input.receivedValueWad ? input.spentValueWad - input.receivedValueWad : 0n;
  const projectedNav = vault.navWad > adverse ? vault.navWad - adverse : 0n;
  const currentOutput = vault.holdings.find((holding) => holding.token.toLowerCase() === input.tokenOut.toLowerCase())?.valueWad ?? 0n;
  const projectedOutput = currentOutput + input.receivedValueWad;
  const tradeBps = Number(input.spentValueWad * BPS / vault.navWad);
  const slippageBps = input.spentValueWad === 0n ? 10_000 : Number(adverse * BPS / input.spentValueWad);
  const concentrationBps = input.tokenOut.toLowerCase() === input.stablecoin.toLowerCase() || projectedNav === 0n
    ? 0
    : Number(projectedOutput * BPS / projectedNav);
  const turnover = vault.turnoverTodayWad + input.spentValueWad;
  const turnoverBps = projectedNav === 0n ? 10_000 : Number(turnover * BPS / projectedNav);
  const checks = [
    { name: "trade_size", approved: tradeBps <= vault.policy.maxTradeBps, observed: `${tradeBps} bps`, limit: `${vault.policy.maxTradeBps} bps` },
    { name: "slippage", approved: slippageBps <= Math.min(input.maxSlippageBps, vault.policy.maxSlippageBps), observed: `${slippageBps} bps`, limit: `${Math.min(input.maxSlippageBps, vault.policy.maxSlippageBps)} bps` },
    { name: "concentration", approved: concentrationBps <= vault.policy.maxConcentrationBps, observed: `${concentrationBps} bps`, limit: `${vault.policy.maxConcentrationBps} bps` },
    { name: "turnover", approved: turnoverBps <= vault.policy.dailyTurnoverBps, observed: `${turnoverBps} bps`, limit: `${vault.policy.dailyTurnoverBps} bps` },
    { name: "trade_count", approved: vault.tradesToday < vault.policy.maxTradesPerDay, observed: String(vault.tradesToday), limit: String(vault.policy.maxTradesPerDay) },
  ];
  return {
    approved: checks.every((check) => check.approved),
    checks,
    projectedNavWad: projectedNav,
    projectedOutputConcentrationBps: concentrationBps,
    projectedTurnoverWad: turnover,
  };
}
