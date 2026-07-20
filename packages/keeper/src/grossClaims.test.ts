import { describe, it, expect } from "vitest";
import {
  WAD,
  lpVestedLoss,
  computeGrossClaims,
  sharePriceWad,
  previewSettlement,
  type LpState,
  type SettlementMark,
} from "./grossClaims.js";

const usd = (n: number) => BigInt(Math.round(n * 1e18)); // WAD helper

describe("lpVestedLoss", () => {
  // Escenario base: LP con NI=10.000, 10.000 shares (entró a 1.0), Pe=0.80 → pérdida 2.000.
  const period = 30n * 24n * 3600n;

  it("cobertura completa (vesteado ≥ período): pérdida entera", () => {
    const lp: LpState = { niWad: usd(10000), shares: usd(10000), vestTime: 0n };
    const mark: SettlementMark = { peWad: usd(0.8), markTime: period, periodSeconds: period };
    // value = 10000*0.8 = 8000; loss = 2000; age = period → coverage = 1.0
    expect(lpVestedLoss(lp, mark)).toBe(usd(2000));
  });

  it("cobertura parcial (mitad del período): media pérdida", () => {
    const lp: LpState = { niWad: usd(10000), shares: usd(10000), vestTime: period / 2n };
    const mark: SettlementMark = { peWad: usd(0.8), markTime: period, periodSeconds: period };
    // age = period/2 → coverage = 0.5 → 2000 * 0.5 = 1000
    expect(lpVestedLoss(lp, mark)).toBe(usd(1000));
  });

  it("sin pérdida: NI ≤ valor de marca → 0", () => {
    const lp: LpState = { niWad: usd(10000), shares: usd(10000), vestTime: 0n };
    const mark: SettlementMark = { peWad: usd(1.2), markTime: period, periodSeconds: period }; // ganancia
    expect(lpVestedLoss(lp, mark)).toBe(0n);
  });

  it("entrante en el dip (NI ≈ shares×Pe): claim ≈ 0 (anti-cosecha del stake)", () => {
    // Depositó cuando el precio ya estaba en 0.80: NI = 8000, 10000 shares. value=8000, loss=0.
    const lp: LpState = { niWad: usd(8000), shares: usd(10000), vestTime: 0n };
    const mark: SettlementMark = { peWad: usd(0.8), markTime: period, periodSeconds: period };
    expect(lpVestedLoss(lp, mark)).toBe(0n);
  });

  it("NI negativo (ganancia realizada, cuenta salida): 0", () => {
    const lp: LpState = { niWad: -usd(1000), shares: 0n, vestTime: 0n };
    const mark: SettlementMark = { peWad: usd(0.8), markTime: period, periodSeconds: period };
    expect(lpVestedLoss(lp, mark)).toBe(0n);
  });

  it("vestTime en el futuro respecto a la marca: age=0 → coverage 0 → claim 0", () => {
    const lp: LpState = { niWad: usd(10000), shares: usd(10000), vestTime: period + 100n };
    const mark: SettlementMark = { peWad: usd(0.8), markTime: period, periodSeconds: period };
    expect(lpVestedLoss(lp, mark)).toBe(0n);
  });
});

describe("computeGrossClaims", () => {
  const period = 30n * 24n * 3600n;
  const mark: SettlementMark = { peWad: usd(0.8), markTime: period, periodSeconds: period };

  it("suma sobre varios LPs; los que no pierden no aportan", () => {
    const lps: LpState[] = [
      { niWad: usd(10000), shares: usd(10000), vestTime: 0n }, // pierde 2000
      { niWad: usd(5000), shares: usd(10000), vestTime: 0n }, // NI<value(8000) → 0
      { niWad: usd(4000), shares: usd(4000), vestTime: 0n }, // value=3200, loss=800
    ];
    expect(computeGrossClaims(lps, mark)).toBe(usd(2800));
  });

  it("gross vacío = 0", () => {
    expect(computeGrossClaims([], mark)).toBe(0n);
  });
});

describe("sharePriceWad", () => {
  it("precio seed 1.0 con supply 0 (offset virtual)", () => {
    // (0 + 1e6)*1e18/(0 + 1e6) = 1e18
    expect(sharePriceWad(0n, 0n)).toBe(WAD);
  });
  it("NAV 8000 / supply 10000 ≈ 0.8", () => {
    const p = sharePriceWad(usd(8000), usd(10000));
    // ≈ 0.8e18 con ruido despreciable del offset
    expect(p).toBeGreaterThan(usd(0.79999));
    expect(p).toBeLessThan(usd(0.80001));
  });
});

describe("previewSettlement (funding keeper-independiente + λ)", () => {
  it("stake cubre el neto → λ=1", () => {
    // NI_agg=10000, supplyLP=10000, Pe=0.8 → lpValue=8000, netted=2000; stake=2000; gross=2000
    const r = previewSettlement({
      grossClaimsWad: usd(2000),
      niAggregateWad: usd(10000),
      supplyLpWad: usd(10000),
      peWad: usd(0.8),
      stakeAvailableWad: usd(2000),
      frozen: false,
    });
    expect(r.fundingWad).toBe(usd(2000));
    expect(r.lambdaWad).toBe(WAD);
  });

  it("keeper sobre-declara grossClaims → λ<1 pero funding NO cambia (S3)", () => {
    const r = previewSettlement({
      grossClaimsWad: usd(4000), // inflado ×2
      niAggregateWad: usd(10000),
      supplyLpWad: usd(10000),
      peWad: usd(0.8),
      stakeAvailableWad: usd(2000),
      frozen: false,
    });
    expect(r.fundingWad).toBe(usd(2000)); // funding = min(stake, netted), inmutable
    expect(r.lambdaWad).toBe(WAD / 2n); // λ = 2000/4000 = 0.5
  });

  it("Frozen: first-loss suspendido → funding 0", () => {
    const r = previewSettlement({
      grossClaimsWad: usd(2000),
      niAggregateWad: usd(10000),
      supplyLpWad: usd(10000),
      peWad: usd(0.8),
      stakeAvailableWad: usd(2000),
      frozen: true,
    });
    expect(r.fundingWad).toBe(0n);
    expect(r.lambdaWad).toBe(0n);
  });

  it("stake < neteado: funding tope al stake, λ capado a 1", () => {
    const r = previewSettlement({
      grossClaimsWad: usd(2000),
      niAggregateWad: usd(10000),
      supplyLpWad: usd(10000),
      peWad: usd(0.8),
      stakeAvailableWad: usd(500), // stake pequeño
      frozen: false,
    });
    expect(r.fundingWad).toBe(usd(500));
    expect(r.lambdaWad).toBe(WAD / 4n); // λ = min(1, 500/2000) = 0.25
  });

  it("gross=0 → λ=0 (nadie cobra aunque haya funding)", () => {
    const r = previewSettlement({
      grossClaimsWad: 0n,
      niAggregateWad: usd(10000),
      supplyLpWad: usd(10000),
      peWad: usd(0.8),
      stakeAvailableWad: usd(2000),
      frozen: false,
    });
    expect(r.fundingWad).toBe(usd(2000)); // el stake responde
    expect(r.lambdaWad).toBe(0n); // pero sin reparto hasta que el keeper publique bien
  });
});
