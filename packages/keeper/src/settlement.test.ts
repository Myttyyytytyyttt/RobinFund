import { describe, it, expect } from "vitest";
import { decideSettle } from "./settlement.js";
import type { FundSnapshot } from "./fundReader.js";

const base: FundSnapshot = {
  navWad: 10000n * 10n ** 18n,
  navValid: true,
  totalSupply: 10000n * 10n ** 18n,
  niAggregateWad: 10000n * 10n ** 18n,
  stakeAvailableWad: 2000n * 10n ** 18n,
  currentPeriod: 0n,
  settlementDue: 1000n,
  state: 0,
  frozen: false,
  guardianPaused: false,
  periodSeconds: BigInt(30 * 24 * 3600),
  withdrawCooldownSeconds: BigInt(24 * 3600),
  feeSplitter: "0x0000000000000000000000000000000000000001",
  shareToken: "0x0000000000000000000000000000000000000002",
};

describe("decideSettle", () => {
  it("espera si no está due", () => {
    const a = decideSettle(base, 500n, 0n);
    expect(a.kind).toBe("wait");
  });

  it("settlea si due + NAV válido", () => {
    const a = decideSettle(base, 1001n, 2000n * 10n ** 18n);
    expect(a.kind).toBe("settle");
    if (a.kind === "settle") expect(a.grossClaimsWad).toBe(2000n * 10n ** 18n);
  });

  it("espera si due pero NAV inválido y ventana degradada no abierta", () => {
    const a = decideSettle({ ...base, navValid: false }, 1001n, 0n);
    expect(a.kind).toBe("wait");
  });

  it("settlea degradado tras 7d sin ventana válida", () => {
    const sevenDays = BigInt(7 * 24 * 3600);
    const a = decideSettle({ ...base, navValid: false }, 1000n + sevenDays, 0n);
    expect(a.kind).toBe("settle");
    if (a.kind === "settle") expect(a.reason).toContain("degradado");
  });

  it("no settlea un fondo Closed", () => {
    const a = decideSettle({ ...base, state: 3 }, 999999n, 0n);
    expect(a.kind).toBe("wait");
  });
});
