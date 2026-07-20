import { describe, it, expect } from "vitest";
import { shouldForceRedeem } from "./monitors.js";

describe("shouldForceRedeem", () => {
  const grace = BigInt(30 * 24 * 3600);
  it("elegible (ineligibleSince=0): nunca", () => {
    expect(shouldForceRedeem(0n, 999999999n)).toBe(false);
  });
  it("inelegible pero dentro de la gracia: no", () => {
    expect(shouldForceRedeem(1000n, 1000n + grace - 1n)).toBe(false);
  });
  it("inelegible pasada la gracia: sí", () => {
    expect(shouldForceRedeem(1000n, 1000n + grace)).toBe(true);
  });
});
