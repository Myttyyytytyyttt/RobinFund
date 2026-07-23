import { createHash, createHmac, randomBytes } from "node:crypto";
import type { Hex } from "viem";

function normalized(value: unknown): unknown {
  if (typeof value === "bigint") return value.toString();
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(normalized);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, entry]) => entry !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, normalized(entry)]),
    );
  }
  return value;
}

export function stableJson(value: unknown): string {
  return JSON.stringify(normalized(value));
}

export function sha256(value: string | Uint8Array): Hex {
  return `0x${createHash("sha256").update(value).digest("hex")}`;
}

export function hmacSha256(secret: string, value: string): Hex {
  return `0x${createHmac("sha256", secret).update(value).digest("hex")}`;
}

export function randomOpaqueToken(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}

export function randomNonce(bytes = 24): string {
  // SIWE/AgentKit requires a strictly alphanumeric nonce; hexadecimal is portable.
  return randomBytes(bytes).toString("hex");
}

export function requestHash(value: unknown): Hex {
  return sha256(stableJson(value));
}

export function hexToBytes(value: Hex): Uint8Array {
  return Uint8Array.from(Buffer.from(value.slice(2), "hex"));
}
