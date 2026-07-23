import { createHmac } from "node:crypto";
import { getAddress, type Address, type Hex } from "viem";
import { privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";

const AGENT_ID_DOMAIN = "nuvem-managed-agent-id-v1";
const SIGNER_DOMAIN = "nuvem-managed-signer-v1";

function hmac(secret: string, value: string): Hex {
  return `0x${createHmac("sha256", secret).update(value, "utf8").digest("hex")}`;
}

function normalizedSponsor(sponsor: Address): Address {
  return getAddress(sponsor).toLowerCase() as Address;
}

/**
 * Produces a stable agent id for a sponsor-owned provisioning key. The key is
 * an idempotency handle, not a secret; the server secret prevents clients from
 * predicting or taking over another managed identity.
 */
export function deriveManagedAgentId(secret: string, sponsor: Address, provisioningKey: string): Hex {
  if (secret.length < 32) throw new Error("Managed signer secret must contain at least 32 characters");
  if (!provisioningKey.trim()) throw new Error("Provisioning key is required");
  return hmac(secret, `${AGENT_ID_DOMAIN}:${normalizedSponsor(sponsor)}:${provisioningKey.trim().toLowerCase()}`);
}

/** Derives the isolated reference-agent EOA without persisting a private key. */
export function deriveManagedAgentAccount(secret: string, agentId: Hex, sponsor: Address): PrivateKeyAccount {
  if (secret.length < 32) throw new Error("Managed signer secret must contain at least 32 characters");
  const owner = normalizedSponsor(sponsor);
  for (let counter = 0; counter < 256; counter++) {
    const privateKey = hmac(secret, `${SIGNER_DOMAIN}:${agentId.toLowerCase()}:${owner}:${counter}`);
    try {
      return privateKeyToAccount(privateKey);
    } catch {
      // A SHA-256 output is invalid for secp256k1 only with negligible
      // probability. The counter makes the derivation total and deterministic.
    }
  }
  throw new Error("Could not derive a valid secp256k1 managed signer");
}

export function deriveManagedSignerIdentity(secret: string, sponsor: Address, provisioningKey: string): {
  agentId: Hex;
  signer: Address;
  provider: "local-derived-v1";
} {
  const agentId = deriveManagedAgentId(secret, sponsor, provisioningKey);
  const account = deriveManagedAgentAccount(secret, agentId, sponsor);
  return {
    agentId,
    signer: account.address.toLowerCase() as Address,
    provider: "local-derived-v1",
  };
}
