import { describe, expect, it } from "vitest";
import { privateKeyToAccount } from "viem/accounts";
import { verifyTypedData, type Address, type Hex } from "viem";
import { AgentSessionService } from "../src/agentkit.js";
import { MemoryControlPlaneStore } from "../src/store.js";
import { WorldBackingService } from "../src/world-backing.js";
import { AI_VAULT_IDENTITY_POLICY } from "../src/world-identity.js";
import { agentId, FakeChain, profile, signer, sponsor } from "./fixtures.js";

const verifierKey = `0x${"77".repeat(32)}` as Hex;
const wrongVerifierKey = `0x${"88".repeat(32)}` as Hex;
const humanId = "anonymous-world-human-id-that-must-not-be-stored";
const identityAppId = "app_5fe197d24d83c55573c5d9d0356f3d6" as const;
const identityRpId = "rp_db7d77ff9edef255";
const identityAction = "ai-vault-identity-v1";
const identityGate = {
  appId: identityAppId,
  rpId: identityRpId,
  environment: "production" as const,
  policyId: AI_VAULT_IDENTITY_POLICY.id,
  policyVersion: AI_VAULT_IDENTITY_POLICY.version,
  policyHash: AI_VAULT_IDENTITY_POLICY.hash,
  action: identityAction,
};

function setup(options: {
  backed?: boolean;
  verifierKey?: Hex;
  identity?: false | {
    environment?: "staging" | "production";
    policyHash?: Hex;
    revokedAt?: Date | null;
    validUntil?: Date;
  };
} = {}) {
  const store = new MemoryControlPlaneStore();
  store.profiles.set(agentId, profile({ status: "pending_backing", worldBacked: false, worldBackedUntil: null }));
  if (options.identity !== false) {
    store.worldIdentityAgentBindings.set(agentId, {
      agentId,
      sponsorBindingId: "11111111-1111-4111-8111-111111111111",
      sponsor,
      signer,
      subjectHash: `0x${"99".repeat(32)}` as Hex,
      nullifierHash: `0x${"98".repeat(32)}` as Hex,
      appId: identityAppId,
      rpId: identityRpId,
      environment: options.identity?.environment ?? "production",
      policyId: AI_VAULT_IDENTITY_POLICY.id,
      policyVersion: AI_VAULT_IDENTITY_POLICY.version,
      policyHash: options.identity?.policyHash ?? AI_VAULT_IDENTITY_POLICY.hash,
      attributesHash: `0x${"97".repeat(32)}` as Hex,
      action: identityAction,
      credentialIdentifier: "passport",
      issuerSchemaId: 9_303,
      verifiedAt: new Date(),
      validUntil: options.identity?.validUntil ?? new Date(Date.now() + 7 * 24 * 60 * 60 * 1_000),
      revokedAt: options.identity?.revokedAt ?? null,
    });
  }
  const chain = new FakeChain();
  chain.agent.active = false;
  chain.agent.status = 0;
  chain.agent.backedUntil = 0;
  chain.backingNonce = 9n;
  chain.worldVerifier = privateKeyToAccount(verifierKey).address.toLowerCase() as Address;
  const sessions = new AgentSessionService(store, chain, {
    publicBaseUrl: "https://agents.nuvem.fund",
    rpcUrl: "https://rpc.invalid",
    sessionSecret: "s".repeat(32),
    worldIdPepper: "p".repeat(32),
  }, {
    lookupHuman: async () => options.backed === false ? null : humanId,
    verifySignature: async () => ({ valid: true, address: signer }),
  });
  const service = new WorldBackingService(
    store,
    chain,
    sessions,
    options.verifierKey ?? verifierKey,
    "https://world.invalid",
    { getBlockNumber: async () => 12_345n },
    identityGate,
  );
  return { store, chain, service };
}

describe("WorldBackingService", () => {
  it("issues a registry-verifiable attestation using the canonical World block", async () => {
    const { store, chain, service } = setup();
    const result = await service.issue(agentId, sponsor);

    expect(result.backing.agentBookBlock).toBe(12_345n);
    expect(result.backing.nonce).toBe(9n);
    expect(result.backing.signer).toBe(signer);
    expect(result.backing.backingHash).toMatch(/^0x[0-9a-f]{64}$/);
    expect(result.backing.backingHash).not.toContain(humanId);
    expect(await verifyTypedData({
      address: chain.worldVerifier,
      domain: {
        name: "Nuvem AgentRegistry",
        version: "1",
        chainId: chain.chainId,
        verifyingContract: chain.registryAddress,
      },
      types: { WorldBacking: [
        { name: "agentId", type: "bytes32" },
        { name: "sponsor", type: "address" },
        { name: "signer", type: "address" },
        { name: "backingHash", type: "bytes32" },
        { name: "agentBookBlock", type: "uint64" },
        { name: "validUntil", type: "uint48" },
        { name: "nonce", type: "uint256" },
      ] },
      primaryType: "WorldBacking",
      message: result.backing,
      signature: result.signature,
    })).toBe(true);
    expect(store.worldAttestations).toHaveLength(1);
    expect(store.worldIdentityAgentBindings.size).toBe(1);
    expect(JSON.stringify(store.worldAttestations, (_key, value) => typeof value === "bigint" ? value.toString() : value))
      .not.toContain(humanId);
    expect(JSON.stringify([...store.worldIdentityAgentBindings.values()])).not.toContain(humanId);
  });

  it("rejects a wallet that is not the on-chain sponsor", async () => {
    const { service } = setup();
    await expect(service.issue(agentId, "0x9000000000000000000000000000000000000001"))
      .rejects.toMatchObject({ code: "NOT_SPONSOR", status: 403 });
  });

  it("fails closed when the configured verifier key differs from AgentRegistry", async () => {
    const { service } = setup({ verifierKey: wrongVerifierKey });
    await expect(service.issue(agentId, sponsor))
      .rejects.toMatchObject({ code: "VERIFIER_MISCONFIGURED", status: 503 });
  });

  it("does not attest an AgentBook signer without human backing", async () => {
    const { service } = setup({ backed: false });
    await expect(service.issue(agentId, sponsor))
      .rejects.toMatchObject({ code: "AGENTBOOK_NOT_BACKED", status: 403 });
  });

  it("does not attest AgentBook alone without the configured Identity Check", async () => {
    const { service } = setup({ identity: false });
    await expect(service.issue(agentId, sponsor))
      .rejects.toMatchObject({ code: "NUVEM_WORLD_IDENTITY_REQUIRED", status: 403 });
  });

  it("does not allow a legacy PoH binding to substitute for Identity Check", async () => {
    const { store, service } = setup({ identity: false });
    store.worldIdAgentBindings.set(agentId, {
      agentId,
      sponsor,
      signer,
      humanHash: `0x${"99".repeat(32)}` as Hex,
      verifiedAt: new Date(),
      revokedAt: null,
    });
    await expect(service.issue(agentId, sponsor))
      .rejects.toMatchObject({ code: "NUVEM_WORLD_IDENTITY_REQUIRED", status: 403 });
  });

  it.each([
    ["staging", { environment: "staging" as const }],
    ["old policy", { policyHash: `0x${"55".repeat(32)}` as Hex }],
    ["revoked", { revokedAt: new Date() }],
    ["expired", { validUntil: new Date(Date.now() - 1_000) }],
  ])("rejects a %s Identity binding", async (_label, identity) => {
    const { service } = setup({ identity });
    await expect(service.issue(agentId, sponsor))
      .rejects.toMatchObject({ code: "NUVEM_WORLD_IDENTITY_REQUIRED", status: 403 });
  });
});
