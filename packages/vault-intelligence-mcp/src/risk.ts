import type { Address } from "viem";
import type { VaultState } from "./types.js";

const BPS = 10_000n;
const MAX_SNAPSHOT_AGE_MS = 300_000;

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
  now = new Date(),
): RebalanceSimulation {
  const policy = vault.policy;
  const navAgeMs = Math.max(0, now.getTime() - vault.navObservedAt.getTime());
  const staleHoldings = vault.holdings.filter((holding) =>
    holding.balance > 0n
    && Math.max(0, now.getTime() - holding.observedAt.getTime()) > MAX_SNAPSHOT_AGE_MS
  );
  const baseChecks = [
    {
      name: "agent_manager",
      approved: vault.managerType === "agent" && vault.controller != null && vault.agentId != null,
      observed: vault.managerType,
      limit: "bound agent controller",
    },
    {
      name: "vault_state",
      approved: vault.state === 0,
      observed: String(vault.state),
      limit: "0 (Active)",
    },
    {
      name: "nav_valid",
      approved: vault.navValid && vault.navWad > 0n,
      observed: `${vault.navValid ? "valid" : "invalid"}:${vault.navWad.toString()}`,
      limit: "valid positive NAV",
    },
    {
      name: "nav_fresh",
      approved: navAgeMs <= MAX_SNAPSHOT_AGE_MS,
      observed: `${Math.floor(navAgeMs / 1_000)}s`,
      limit: `${MAX_SNAPSHOT_AGE_MS / 1_000}s`,
    },
    {
      name: "controller_active",
      approved: vault.controllerEnabled && !vault.controllerPaused,
      observed: `enabled=${vault.controllerEnabled},paused=${vault.controllerPaused}`,
      limit: "enabled=true,paused=false",
    },
    {
      name: "world_backing",
      approved: vault.agentStatus === 1 && vault.backedUntil != null && vault.backedUntil > now,
      observed: `status=${vault.agentStatus ?? "missing"},until=${vault.backedUntil?.toISOString() ?? "missing"}`,
      limit: `active after ${now.toISOString()}`,
    },
    {
      name: "holdings_valid",
      approved: vault.holdings.every((holding) => holding.balance === 0n || holding.valid),
      observed: String(vault.holdings.filter((holding) => holding.balance > 0n && !holding.valid).length),
      limit: "0 invalid non-zero holdings",
    },
    {
      name: "holdings_fresh",
      approved: staleHoldings.length === 0,
      observed: String(staleHoldings.length),
      limit: "0 stale non-zero holdings",
    },
    {
      name: "policy",
      approved: policy != null,
      observed: policy == null ? "missing" : "active",
      limit: "active agent policy",
    },
  ];

  if (!policy || vault.navWad <= 0n) {
    return {
      approved: false,
      checks: baseChecks,
      projectedNavWad: vault.navWad,
      projectedOutputConcentrationBps: 0,
      projectedTurnoverWad: vault.turnoverTodayWad,
    };
  }

  const elapsed = vault.lastTradeAt == null
    ? Number.POSITIVE_INFINITY
    : Math.floor((now.getTime() - vault.lastTradeAt.getTime()) / 1_000);
  baseChecks.push({
    name: "trade_interval",
    approved: elapsed >= policy.minTradeInterval,
    observed: Number.isFinite(elapsed) ? `${elapsed}s` : "no previous trade",
    limit: `${policy.minTradeInterval}s`,
  });

  const adverse = input.spentValueWad > input.receivedValueWad
    ? input.spentValueWad - input.receivedValueWad
    : 0n;
  const projectedNav = vault.navWad > adverse ? vault.navWad - adverse : 0n;
  const currentOutput = vault.holdings.find(
    (holding) => holding.token.toLowerCase() === input.tokenOut.toLowerCase(),
  )?.valueWad ?? 0n;
  const projectedOutput = currentOutput + input.receivedValueWad;
  const tradeBps = Number(input.spentValueWad * BPS / vault.navWad);
  const slippageBps = input.spentValueWad === 0n
    ? 10_000
    : Number(adverse * BPS / input.spentValueWad);
  const concentrationBps = input.tokenOut.toLowerCase() === input.stablecoin.toLowerCase()
    || projectedNav === 0n
    ? 0
    : Number(projectedOutput * BPS / projectedNav);
  const turnover = vault.turnoverTodayWad + input.spentValueWad;
  const turnoverBps = projectedNav === 0n ? 10_000 : Number(turnover * BPS / projectedNav);
  const checks = [
    ...baseChecks,
    {
      name: "trade_size",
      approved: tradeBps <= policy.maxTradeBps,
      observed: `${tradeBps} bps`,
      limit: `${policy.maxTradeBps} bps`,
    },
    {
      name: "slippage",
      approved: slippageBps <= Math.min(input.maxSlippageBps, policy.maxSlippageBps),
      observed: `${slippageBps} bps`,
      limit: `${Math.min(input.maxSlippageBps, policy.maxSlippageBps)} bps`,
    },
    {
      name: "concentration",
      approved: concentrationBps <= policy.maxConcentrationBps,
      observed: `${concentrationBps} bps`,
      limit: `${policy.maxConcentrationBps} bps`,
    },
    {
      name: "turnover",
      approved: turnoverBps <= policy.dailyTurnoverBps,
      observed: `${turnoverBps} bps`,
      limit: `${policy.dailyTurnoverBps} bps`,
    },
    {
      name: "trade_count",
      approved: vault.tradesToday < policy.maxTradesPerDay,
      observed: String(vault.tradesToday),
      limit: String(policy.maxTradesPerDay),
    },
  ];
  return {
    approved: checks.every((check) => check.approved),
    checks,
    projectedNavWad: projectedNav,
    projectedOutputConcentrationBps: concentrationBps,
    projectedTurnoverWad: turnover,
  };
}
