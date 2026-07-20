import { describe, it, expect } from "vitest";
import { planActions, type PlanInput } from "./runner.js";
import type { FundSnapshot } from "./fundReader.js";

const snap: FundSnapshot = {
  navWad: 10000n * 10n ** 18n,
  navValid: true,
  totalSupply: 10000n * 10n ** 18n,
  niAggregateWad: 10000n * 10n ** 18n,
  stakeAvailableWad: 2000n * 10n ** 18n,
  currentPeriod: 1n,
  settlementDue: 1000n,
  state: 0,
  frozen: false,
  guardianPaused: false,
  periodSeconds: BigInt(30 * 24 * 3600),
  withdrawCooldownSeconds: BigInt(24 * 3600),
  feeSplitter: "0x0000000000000000000000000000000000000001",
  shareToken: "0x0000000000000000000000000000000000000002",
};

const base: PlanInput = {
  snap,
  queues: { deposits: 0n, withdrawals: 0n },
  action: { kind: "wait", reason: "no due" },
  grossClaimsWad: 0n,
  blocked: false,
  headWithdrawInKindReady: false,
};

describe("planActions", () => {
  it("sin nada que hacer → sin intents", () => {
    expect(planActions(base)).toEqual([]);
  });

  it("settlement con NAV válido → executeBatch (settlea y procesa colas en una tx)", () => {
    const out = planActions({
      ...base,
      action: { kind: "settle", grossClaimsWad: 5n, reason: "due" },
    });
    expect(out).toEqual([{ fn: "executeBatch", args: [5n] }]);
  });

  it("settlement degradado (NAV inválido) → settle DIRECTO, nunca executeBatch", () => {
    // executeBatch settlearía y luego revertiría NavInvalid al procesar colas → deshace el settle
    const out = planActions({
      ...base,
      snap: { ...snap, navValid: false },
      action: { kind: "settle", grossClaimsWad: 7n, reason: "degradado" },
    });
    expect(out).toEqual([{ fn: "settle", args: [7n] }]);
  });

  it("colas pendientes sin settlement → executeBatch con el gross corriente", () => {
    const out = planActions({ ...base, queues: { deposits: 2n, withdrawals: 0n }, grossClaimsWad: 3n });
    expect(out).toEqual([{ fn: "executeBatch", args: [3n] }]);
  });

  it("colas con NAV inválido y cabeza in-kind lista → válvula executeInKindWithdrawals", () => {
    const out = planActions({
      ...base,
      snap: { ...snap, navValid: false },
      queues: { deposits: 0n, withdrawals: 1n },
      headWithdrawInKindReady: true,
    });
    expect(out).toEqual([{ fn: "executeInKindWithdrawals", args: [] }]);
  });

  it("colas con NAV inválido y cabeza cash → NO manda nada (el cash espera al NAV)", () => {
    const out = planActions({
      ...base,
      snap: { ...snap, navValid: false },
      queues: { deposits: 0n, withdrawals: 1n },
      headWithdrawInKindReady: false,
    });
    expect(out).toEqual([]);
  });

  it("fondo bloqueado por RHJ y no Frozen → declareFrozen primero", () => {
    const out = planActions({
      ...base,
      blocked: true,
      queues: { deposits: 1n, withdrawals: 0n },
    });
    expect(out[0]).toEqual({ fn: "declareFrozen", args: [] });
  });

  it("fondo ya Frozen → no re-declara", () => {
    const out = planActions({ ...base, snap: { ...snap, frozen: true }, blocked: true });
    expect(out.find((i) => i.fn === "declareFrozen")).toBeUndefined();
  });

  it("fondo Closed con colas → no executeBatch por colas", () => {
    // en Closed no hay depósitos y los retiros pendientes salen por el flujo de cierre
    const out = planActions({
      ...base,
      snap: { ...snap, state: 3 },
      queues: { deposits: 0n, withdrawals: 1n },
    });
    expect(out).toEqual([]);
  });
});
