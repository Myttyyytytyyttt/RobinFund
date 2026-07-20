/**
 * Política de admisión (SPEC §10.1, Condición 28 del prospecto RHJ) — PURA y testeable.
 *
 * Quien custodia Stock Tokens "for the account or benefit of another person" declara que ese
 * tercero NO es Prohibited Investor. La política mínima que eso impone:
 *  · no US persons
 *  · no jurisdicciones restringidas (lista configurable)
 *  · una sola dirección activa por persona verificada (unicidad, la aplica el signer off-chain)
 *  · no atestar direcciones que RHJ ya tiene bloqueadas (señal de compliance del emisor)
 *
 * La VERIFICACIÓN de identidad (KYC real: quién es la persona, su jurisdicción, si es US person)
 * es del proveedor de arriba (Privy/KYC en la capa 3); aquí decidimos con sus outputs declarados.
 */
import { type Address } from "viem";

export interface AdmissionRequest {
  personId: string; // ID opaco del proveedor de verificación — NUNCA PII
  address: Address;
  usPerson: boolean;
  jurisdiction: string; // ISO 3166-1 alpha-2, p.ej. "ES"
}

export interface PolicyContext {
  blockedJurisdictions: readonly string[];
  rhjBlocked: boolean; // ACCESS registry isBlocked(address)
  /** dirección activa que el store ya tiene para esta persona (null si ninguna) */
  existingAddressOfPerson: Address | null;
  /** persona a la que el store ya tiene ligada esta dirección (null si ninguna) */
  existingPersonOfAddress: string | null;
}

export type PolicyDecision = { ok: true } | { ok: false; reason: string };

/** Charset seguro para el ID opaco del proveedor (Privy DID, ID KYC): sin claves peligrosas. */
const PERSON_ID_RE = /^[A-Za-z0-9_.:\-]{1,128}$/;
const FORBIDDEN_PERSON_IDS = new Set(["__proto__", "constructor", "prototype"]);

export function decideAdmission(req: AdmissionRequest, ctx: PolicyContext): PolicyDecision {
  if (!PERSON_ID_RE.test(req.personId) || FORBIDDEN_PERSON_IDS.has(req.personId)) {
    return { ok: false, reason: "personId inválido (charset o longitud)" };
  }
  if (req.usPerson) {
    return { ok: false, reason: "US person: Prohibited Investor (Condición 28)" };
  }
  const j = req.jurisdiction.toUpperCase();
  if (!/^[A-Z]{2}$/.test(j)) {
    return { ok: false, reason: `jurisdicción inválida: ${req.jurisdiction}` };
  }
  if (ctx.blockedJurisdictions.map((x) => x.toUpperCase()).includes(j)) {
    return { ok: false, reason: `jurisdicción restringida: ${j}` };
  }
  if (ctx.rhjBlocked) {
    return { ok: false, reason: "dirección bloqueada por RHJ en el ACCESS registry" };
  }
  // NOTA: una persona localmente revocada SÍ puede pasar por aquí — la admisión es admin-gated y
  // ES el camino de re-verificación/re-habilitación (el contrato lo soporta: attest con el nonce
  // nuevo limpia revokedAt). Lo que una revocación bloquea es la RENOVACIÓN pública (decideRenewal).
  const addr = req.address.toLowerCase();
  if (ctx.existingPersonOfAddress && ctx.existingPersonOfAddress !== req.personId) {
    return { ok: false, reason: "dirección ya ligada a otra persona" };
  }
  if (ctx.existingAddressOfPerson && ctx.existingAddressOfPerson.toLowerCase() !== addr) {
    return {
      ok: false,
      reason: "la persona ya tiene otra dirección activa: revocarla antes de admitir una nueva (unicidad §10.1)",
    };
  }
  return { ok: true };
}

/**
 * Renovación: la dirección ya está admitida; re-chequeos SIN re-declarar KYC. La renovación es
 * pública, así que NO puede confiar solo en estado local mutable: `revokedOnChain` viene del
 * `revokedAt` del gate (una renovación firmaría el nonce post-revocación y attest() LIMPIA la
 * revocación — el signer desharía su propia revocación; hallazgo HIGH de la revisión adversarial).
 * `withinRenewalWindow` acota la renovación al tramo final del TTL: sin ventana, renovar en bucle
 * convierte el TTL de 90d en elegibilidad perpetua sin re-verificación.
 */
export function decideRenewal(ctx: {
  addressAdmitted: boolean;
  personLocallyRevoked: boolean;
  rhjBlocked: boolean;
  revokedOnChain: boolean;
  withinRenewalWindow: boolean;
}): PolicyDecision {
  if (!ctx.addressAdmitted) return { ok: false, reason: "dirección no admitida: usa el flujo de admisión" };
  if (ctx.personLocallyRevoked) return { ok: false, reason: "persona revocada: requiere re-admisión" };
  if (ctx.revokedOnChain) {
    return { ok: false, reason: "revocada on-chain: solo el flujo admin de re-admisión puede re-habilitar" };
  }
  if (ctx.rhjBlocked) return { ok: false, reason: "dirección bloqueada por RHJ en el ACCESS registry" };
  if (!ctx.withinRenewalWindow) return { ok: false, reason: "aún no renovable: la atestación vigente no está cerca de expirar" };
  return { ok: true };
}

/**
 * Lista de jurisdicciones restringidas de la SPEC §10.1 (lista RHJ, Condición 28) — es parte de la
 * spec, NO configuración: el env solo puede AÑADIR, nunca quitar. (CA/UK/CH tienen restricciones
 * adicionales de oferta en el prospecto, no bloqueo total — decisión del operador añadirlas.)
 */
export const DEFAULT_BLOCKED_JURISDICTIONS = [
  "US", // United States (Condición 28)
  "CU", // Cuba
  "BY", // Bielorrusia
  "IR", // Irán
  "KP", // Corea del Norte
  "RU", // Rusia
  "SY", // Siria
  "UA", // Ucrania
  "SS", // Sudán del Sur
  "SD", // Sudán
  "MM", // Myanmar
  "VE", // Venezuela
] as const;
