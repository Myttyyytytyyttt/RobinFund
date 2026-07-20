/**
 * Store de unicidad persona↔dirección (§10.1) — JSON en disco con escritura atómica.
 *
 * v1 deliberadamente simple: un archivo, un proceso. La interfaz (load/save + operaciones) permite
 * cambiarlo por Postgres cuando haya más de una réplica. El personId es un ID OPACO del proveedor
 * de verificación (Privy DID, ID de KYC) — nunca PII; este archivo no debe contener datos
 * personales, solo el binding persona-opaca → dirección.
 */
import { readFileSync, writeFileSync, renameSync, existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { getAddress, type Address } from "viem";

export interface PersonRecord {
  address: Address;
  admittedAt: string; // ISO
  revoked: boolean;
  revokedAt?: string;
}

/** Entrada del rastro de auditoría: todo binding que deja de estar activo queda registrado. */
export interface AuditEntry {
  personId: string;
  address: Address;
  admittedAt: string;
  releasedAt: string;
  cause: "revocada" | "rotada";
}

interface StoreData {
  version: 1;
  persons: Record<string, PersonRecord>;
  /** índice inverso: dirección (lowercase) → personId */
  addresses: Record<string, string>;
  /** append-only: bindings pasados (auditoría de compliance) */
  audit: AuditEntry[];
}

/** Copia con prototipo nulo: un lookup de "__proto__"/"constructor" devuelve undefined, no basura. */
function nullProto<T>(obj: Record<string, T> | undefined): Record<string, T> {
  return Object.assign(Object.create(null) as Record<string, T>, obj ?? {});
}

export class ComplianceStore {
  private data: StoreData;

  constructor(private readonly path: string) {
    if (existsSync(path)) {
      const raw = JSON.parse(readFileSync(path, "utf8")) as StoreData;
      if (raw.version !== 1) throw new Error(`versión de store desconocida: ${String(raw.version)}`);
      this.data = {
        version: 1,
        persons: nullProto(raw.persons),
        addresses: nullProto(raw.addresses),
        audit: raw.audit ?? [],
      };
    } else {
      this.data = { version: 1, persons: nullProto({}), addresses: nullProto({}), audit: [] };
    }
  }

  private save(): void {
    mkdirSync(dirname(this.path), { recursive: true });
    const tmp = `${this.path}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.data, null, 2), "utf8");
    renameSync(tmp, this.path); // atómico en el mismo volumen (Windows: MoveFileEx REPLACE_EXISTING)
  }

  personOf(address: Address): string | null {
    return this.data.addresses[address.toLowerCase()] ?? null;
  }

  recordOf(personId: string): PersonRecord | null {
    return this.data.persons[personId] ?? null;
  }

  /** Dirección ACTIVA (no revocada) de una persona. */
  activeAddressOf(personId: string): Address | null {
    const rec = this.data.persons[personId];
    return rec && !rec.revoked ? rec.address : null;
  }

  isAdmitted(address: Address): boolean {
    const personId = this.personOf(address);
    if (!personId) return false;
    const rec = this.data.persons[personId];
    return !!rec && !rec.revoked && rec.address.toLowerCase() === address.toLowerCase();
  }

  /** Liga persona↔dirección (idempotente si ya es el mismo binding; re-admite si estaba revocada). */
  admit(personId: string, address: Address, nowIso: string): void {
    const addr = getAddress(address);
    const key = addr.toLowerCase();
    const boundPerson = this.data.addresses[key];
    if (boundPerson && boundPerson !== personId) {
      throw new Error("dirección ya ligada a otra persona"); // la política ya lo rechaza; defensa extra
    }
    const existing = this.data.persons[personId];
    if (existing && !existing.revoked && existing.address.toLowerCase() !== key) {
      throw new Error("la persona ya tiene otra dirección activa");
    }
    // si la persona tenía OTRA dirección (revocada), soltar el índice inverso viejo — dejando
    // el binding pasado en el rastro de auditoría (nunca se borra historia de compliance)
    if (existing && existing.address.toLowerCase() !== key) {
      delete this.data.addresses[existing.address.toLowerCase()];
      this.data.audit.push({
        personId,
        address: existing.address,
        admittedAt: existing.admittedAt,
        releasedAt: nowIso,
        cause: "rotada",
      });
    }
    this.data.persons[personId] = { address: addr, admittedAt: nowIso, revoked: false };
    this.data.addresses[key] = personId;
    this.save();
  }

  /** Rastro de auditoría (solo lectura). */
  auditTrail(): readonly AuditEntry[] {
    return this.data.audit;
  }

  /** Marca revocada a la persona dueña de `address` (el binding se conserva para auditoría). */
  revokeByAddress(address: Address, nowIso: string): string | null {
    const personId = this.personOf(address);
    if (!personId) return null;
    const rec = this.data.persons[personId];
    if (rec && !rec.revoked) {
      rec.revoked = true;
      rec.revokedAt = nowIso;
      this.data.audit.push({
        personId,
        address: rec.address,
        admittedAt: rec.admittedAt,
        releasedAt: nowIso,
        cause: "revocada",
      });
      this.save();
    }
    return personId;
  }
}
