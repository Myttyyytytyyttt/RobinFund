import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ComplianceStore } from "./store.js";

const A = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8" as const;
const B = "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC" as const;

let dir: string;
let path: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "compliance-store-"));
  path = join(dir, "store.json");
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("ComplianceStore", () => {
  it("liga persona↔dirección y persiste a disco", () => {
    const s = new ComplianceStore(path);
    s.admit("kyc-1", A, "2026-07-20T00:00:00Z");
    expect(s.isAdmitted(A)).toBe(true);
    expect(s.personOf(A)).toBe("kyc-1");
    expect(s.activeAddressOf("kyc-1")).toBe(A);
    expect(existsSync(path)).toBe(true);

    // recarga desde disco
    const s2 = new ComplianceStore(path);
    expect(s2.isAdmitted(A)).toBe(true);
    expect(s2.personOf(A)).toBe("kyc-1");
  });

  it("lookup case-insensitive por dirección", () => {
    const s = new ComplianceStore(path);
    s.admit("kyc-1", A, "2026-07-20T00:00:00Z");
    expect(s.isAdmitted(A.toLowerCase() as typeof A)).toBe(true);
  });

  it("rechaza ligar la dirección a otra persona", () => {
    const s = new ComplianceStore(path);
    s.admit("kyc-1", A, "2026-07-20T00:00:00Z");
    expect(() => s.admit("kyc-2", A, "2026-07-20T00:00:00Z")).toThrow();
  });

  it("rechaza segunda dirección activa de la misma persona", () => {
    const s = new ComplianceStore(path);
    s.admit("kyc-1", A, "2026-07-20T00:00:00Z");
    expect(() => s.admit("kyc-1", B, "2026-07-20T00:00:00Z")).toThrow();
  });

  it("revoca por dirección y deja de estar admitida (el binding queda para auditoría)", () => {
    const s = new ComplianceStore(path);
    s.admit("kyc-1", A, "2026-07-20T00:00:00Z");
    expect(s.revokeByAddress(A, "2026-07-21T00:00:00Z")).toBe("kyc-1");
    expect(s.isAdmitted(A)).toBe(false);
    expect(s.activeAddressOf("kyc-1")).toBeNull();
    expect(s.personOf(A)).toBe("kyc-1"); // auditoría
  });

  it("tras revocar, la persona puede re-admitirse con OTRA dirección (rotación)", () => {
    const s = new ComplianceStore(path);
    s.admit("kyc-1", A, "2026-07-20T00:00:00Z");
    s.revokeByAddress(A, "2026-07-21T00:00:00Z");
    s.admit("kyc-1", B, "2026-07-22T00:00:00Z");
    expect(s.isAdmitted(B)).toBe(true);
    expect(s.isAdmitted(A)).toBe(false);
    expect(s.personOf(A)).toBeNull(); // el índice inverso viejo se soltó
    expect(s.activeAddressOf("kyc-1")).toBe(B);
  });

  it("revocar dirección desconocida devuelve null sin tocar nada", () => {
    const s = new ComplianceStore(path);
    expect(s.revokeByAddress(B, "2026-07-21T00:00:00Z")).toBeNull();
  });

  it("auditoría: revocación y rotación quedan en el rastro (nunca se borra historia)", () => {
    const s = new ComplianceStore(path);
    s.admit("kyc-1", A, "2026-07-20T00:00:00Z");
    s.revokeByAddress(A, "2026-07-21T00:00:00Z");
    s.admit("kyc-1", B, "2026-07-22T00:00:00Z"); // rotación: suelta el índice de A
    const audit = s.auditTrail();
    expect(audit).toHaveLength(2);
    expect(audit[0]).toMatchObject({ personId: "kyc-1", address: A, cause: "revocada" });
    expect(audit[1]).toMatchObject({ personId: "kyc-1", address: A, cause: "rotada" });
    // y sobrevive la recarga desde disco
    expect(new ComplianceStore(path).auditTrail()).toHaveLength(2);
  });

  it('claves del prototype ("__proto__"/"constructor") no devuelven basura en lookups', () => {
    const s = new ComplianceStore(path);
    expect(s.recordOf("__proto__")).toBeNull();
    expect(s.recordOf("constructor")).toBeNull();
    expect(s.activeAddressOf("__proto__")).toBeNull();
    // y tras recargar de disco (JSON.parse crea objetos con Object.prototype)
    s.admit("kyc-1", A, "2026-07-20T00:00:00Z");
    const s2 = new ComplianceStore(path);
    expect(s2.recordOf("constructor")).toBeNull();
  });
});
