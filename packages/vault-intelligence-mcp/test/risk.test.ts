import type { Address, Hex } from "viem";
import { describe, expect, it } from "vitest";
import { simulateRebalance } from "../src/risk.js";
import type { VaultState } from "../src/types.js";

const stock = "0x1111111111111111111111111111111111111111" as Address;
const stablecoin = "0x2222222222222222222222222222222222222222" as Address;
const vault: VaultState = {
  address: "0x3333333333333333333333333333333333333333",
  controller: "0x4444444444444444444444444444444444444444",
  controllerEnabled: true,
  controllerPaused: false,
  agentId: `0x${"55".repeat(32)}` as Hex,
  agentStatus: 1,
  backedUntil: new Date("2100-01-01T00:00:00.000Z"),
  managerType: "agent",
  state: 0,
  navWad: 100_000n,
  navValid: true,
  navUpdatedAt: new Date(),
  navObservedAt: new Date(),
  totalShares: 100_000n,
  lastPeWad: 1_000_000_000_000_000_000n,
  lifetimeDeposited6: 100n,
  lifetimeWithdrawn6: 0n,
  policy: {
    policyHash: `0x${"66".repeat(32)}` as Hex,
    maxTradeBps: 1_000,
    maxConcentrationBps: 3_500,
    dailyTurnoverBps: 5_000,
    maxSlippageBps: 75,
    maxTradesPerDay: 24,
    minTradeInterval: 300,
    maxIntentLifetime: 600,
  },
  turnoverTodayWad: 5_000n,
  tradesToday: 2,
  lastTradeAt: null,
  holdings: [{ token: stock, balance: 20n, valueWad: 20_000n, valid: true, observedAt: new Date() }],
  recentTrades: [],
};

describe("read-only risk simulation", () => {
  it("approves a trade inside every policy boundary", () => {
    const result = simulateRebalance(vault, { tokenOut: stock, spentValueWad: 5_000n, receivedValueWad: 4_975n, stablecoin, maxSlippageBps: 75 });
    expect(result.approved).toBe(true);
    expect(result.checks.every((check) => check.approved)).toBe(true);
  });

  it("rejects max trade size", () => {
    const result = simulateRebalance(vault, { tokenOut: stock, spentValueWad: 20_000n, receivedValueWad: 20_000n, stablecoin, maxSlippageBps: 75 });
    expect(result.checks.find((check) => check.name === "trade_size")?.approved).toBe(false);
  });

  it("rejects actual slippage", () => {
    const result = simulateRebalance(vault, { tokenOut: stock, spentValueWad: 5_000n, receivedValueWad: 4_000n, stablecoin, maxSlippageBps: 75 });
    expect(result.checks.find((check) => check.name === "slippage")?.approved).toBe(false);
  });

  it("exempts USDG from concentration", () => {
    const result = simulateRebalance(vault, { tokenOut: stablecoin, spentValueWad: 5_000n, receivedValueWad: 5_000n, stablecoin, maxSlippageBps: 75 });
    expect(result.projectedOutputConcentrationBps).toBe(0);
  });

  it("fails closed when the policy is absent", () => {
    const result = simulateRebalance({ ...vault, policy: null }, { tokenOut: stock, spentValueWad: 1n, receivedValueWad: 1n, stablecoin, maxSlippageBps: 75 });
    expect(result.approved).toBe(false);
  });

  it("fails closed when NAV is invalid", () => {
    const result = simulateRebalance({ ...vault, navValid: false }, { tokenOut: stock, spentValueWad: 1n, receivedValueWad: 1n, stablecoin, maxSlippageBps: 75 });
    expect(result.checks.find((check) => check.name === "nav_valid")?.approved).toBe(false);
    expect(result.approved).toBe(false);
  });

  it("fails closed when NAV or non-zero holdings are stale", () => {
    const stale = new Date(Date.now() - 301_000);
    const result = simulateRebalance({
      ...vault,
      navObservedAt: stale,
      holdings: [{ ...vault.holdings[0]!, observedAt: stale }],
    }, { tokenOut: stock, spentValueWad: 1n, receivedValueWad: 1n, stablecoin, maxSlippageBps: 75 });
    expect(result.checks.find((check) => check.name === "nav_fresh")?.approved).toBe(false);
    expect(result.checks.find((check) => check.name === "holdings_fresh")?.approved).toBe(false);
    expect(result.approved).toBe(false);
  });

  it("fails closed when World backing has expired", () => {
    const result = simulateRebalance({ ...vault, backedUntil: new Date(0) }, { tokenOut: stock, spentValueWad: 1n, receivedValueWad: 1n, stablecoin, maxSlippageBps: 75 });
    expect(result.checks.find((check) => check.name === "world_backing")?.approved).toBe(false);
    expect(result.approved).toBe(false);
  });
});
