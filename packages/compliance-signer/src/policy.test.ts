import { describe, it, expect } from "vitest";
import {
  decideAdmission,
  decideRenewal,
  DEFAULT_BLOCKED_JURISDICTIONS,
  type AdmissionRequest,
  type PolicyContext,
} from "./policy.js";

const A = "0x00000000000000000000000000000000000000Aa" as const;
const B = "0x00000000000000000000000000000000000000Bb" as const;

const req: AdmissionRequest = { personId: "kyc-1", address: A, usPerson: false, jurisdiction: "ES" };
const ctx: PolicyContext = {
  blockedJurisdictions: ["US", "KP"],
  rhjBlocked: false,
  existingAddressOfPerson: null,
  existingPersonOfAddress: null,
};

describe("decideAdmission", () => {
  it("admite el caso limpio", () => {
    expect(decideAdmission(req, ctx)).toEqual({ ok: true });
  });

  it("rechaza US person (Condición 28)", () => {
    const d = decideAdmission({ ...req, usPerson: true }, ctx);
    expect(d.ok).toBe(false);
  });

  it("rechaza jurisdicción restringida, case-insensitive", () => {
    expect(decideAdmission({ ...req, jurisdiction: "kp" }, ctx).ok).toBe(false);
    expect(decideAdmission({ ...req, jurisdiction: "US" }, ctx).ok).toBe(false);
  });

  it("rechaza jurisdicción malformada", () => {
    expect(decideAdmission({ ...req, jurisdiction: "ESP" }, ctx).ok).toBe(false);
    expect(decideAdmission({ ...req, jurisdiction: "" }, ctx).ok).toBe(false);
  });

  it("rechaza dirección bloqueada por RHJ", () => {
    expect(decideAdmission(req, { ...ctx, rhjBlocked: true }).ok).toBe(false);
  });

  it("unicidad: la dirección ya es de otra persona → rechazo", () => {
    expect(decideAdmission(req, { ...ctx, existingPersonOfAddress: "kyc-2" }).ok).toBe(false);
  });

  it("unicidad: la persona ya tiene OTRA dirección activa → rechazo", () => {
    expect(decideAdmission(req, { ...ctx, existingAddressOfPerson: B }).ok).toBe(false);
  });

  it("re-admisión idempotente: misma persona, misma dirección → ok (renovación)", () => {
    const d = decideAdmission(req, {
      ...ctx,
      existingAddressOfPerson: A,
      existingPersonOfAddress: "kyc-1",
    });
    expect(d).toEqual({ ok: true });
  });

  it("rechaza personId vacío, gigante, con charset raro, o clave del prototype", () => {
    expect(decideAdmission({ ...req, personId: "" }, ctx).ok).toBe(false);
    expect(decideAdmission({ ...req, personId: "x".repeat(200) }, ctx).ok).toBe(false);
    expect(decideAdmission({ ...req, personId: "kyc 1" }, ctx).ok).toBe(false); // espacio
    expect(decideAdmission({ ...req, personId: "__proto__" }, ctx).ok).toBe(false);
    expect(decideAdmission({ ...req, personId: "constructor" }, ctx).ok).toBe(false);
    expect(decideAdmission({ ...req, personId: "did:privy:abc-123.x" }, ctx).ok).toBe(true); // DID real pasa
  });
});

describe("DEFAULT_BLOCKED_JURISDICTIONS", () => {
  it("cubre la lista fija de la SPEC §10.1 (lista RHJ, Condición 28)", () => {
    // US + Cuba, Bielorrusia, Irán, Corea del Norte, Rusia, Siria, Ucrania, Sudán del Sur,
    // Sudán, Myanmar, Venezuela — si esto falla, la spec y el código divergieron
    const spec = ["US", "CU", "BY", "IR", "KP", "RU", "SY", "UA", "SS", "SD", "MM", "VE"];
    for (const j of spec) expect(DEFAULT_BLOCKED_JURISDICTIONS).toContain(j);
  });
});

describe("decideRenewal", () => {
  const clean = {
    addressAdmitted: true,
    personLocallyRevoked: false,
    rhjBlocked: false,
    revokedOnChain: false,
    withinRenewalWindow: true,
  };
  it("renueva a un admitido limpio dentro de la ventana", () => {
    expect(decideRenewal(clean)).toEqual({ ok: true });
  });
  it("rechaza no admitido / revocado local / bloqueado RHJ", () => {
    expect(decideRenewal({ ...clean, addressAdmitted: false }).ok).toBe(false);
    expect(decideRenewal({ ...clean, personLocallyRevoked: true }).ok).toBe(false);
    expect(decideRenewal({ ...clean, rhjBlocked: true }).ok).toBe(false);
  });
  it("rechaza revocación ON-CHAIN aunque el store local diga activo (desync fail-closed)", () => {
    const d = decideRenewal({ ...clean, revokedOnChain: true });
    expect(d.ok).toBe(false);
    if (!d.ok) expect(d.reason).toContain("on-chain");
  });
  it("rechaza fuera de la ventana de renovación (el TTL es un ciclo de re-verificación)", () => {
    expect(decideRenewal({ ...clean, withinRenewalWindow: false }).ok).toBe(false);
  });
});
