import { hashSignal } from "@worldcoin/idkit-core/hashing";
import { describe, expect, it, vi } from "vitest";
import type { Hex } from "viem";
import { MemoryControlPlaneStore } from "../src/store.js";
import { WorldIdSponsorService, type WorldIdRequestResponse } from "../src/world-id.js";
import { agentId, FakeChain, profile, signer, sponsor } from "./fixtures.js";

const appId = "app_5fe197d24d83c55573c5d9d0356f3d6" as const;
const rpId = "rp_db7d77ff9edef255";
const action = "sponsor-ai-vault";
const rpKey = `0x${"12".repeat(32)}` as Hex;
const nullifier = `0x${"ab".repeat(32)}`;

function proofFor(request: Extract<WorldIdRequestResponse, { verified: false }>, overrides: Record<string, unknown> = {}) {
  return {
    protocol_version: "4.0",
    nonce: request.rpContext.nonce,
    action,
    responses: [{
      identifier: "proof_of_human",
      signal_hash: hashSignal(request.signal),
      proof: Array.from({ length: 5 }, (_, index) => `0x${String(index + 1).padStart(64, "0")}`),
      nullifier,
      issuer_schema_id: 1,
      expires_at_min: Math.floor(Date.now() / 1_000) + 3_600,
    }],
    user_presence_completed: false,
    environment: "production",
    ...overrides,
  };
}

function setup(runtimeKind: "external" | "nuvem_reference" = "external", maxManagedAgents = 3) {
  const store = new MemoryControlPlaneStore();
  void store.upsertAgentProfile(profile({
    runtimeKind,
    status: "pending_backing",
    worldBacked: false,
    worldBackedUntil: null,
  }));
  const chain = new FakeChain();
  const portal = vi.fn(async () => new Response(JSON.stringify({ success: true }), {
    status: 200,
    headers: { "content-type": "application/json" },
  }));
  let sequence = 0;
  const service = new WorldIdSponsorService(store, chain, {
    appId,
    rpId,
    rpSigningKey: rpKey,
    action,
    worldIdPepper: "p".repeat(32),
    maxManagedAgentsPerHuman: maxManagedAgents,
  }, {
    sign: () => {
      sequence += 1;
      const now = Math.floor(Date.now() / 1_000);
      return { sig: `0x${"34".repeat(65)}`, nonce: `nonce-${sequence}`, createdAt: now, expiresAt: now + 300 };
    },
    fetch: portal,
  });
  return { store, chain, portal, service };
}

describe("WorldIdSponsorService", () => {
  it("binds the Nuvem World ID 4.0 proof without persisting raw identity material", async () => {
    const { store, portal, service } = setup();
    const request = await service.request(agentId, sponsor);
    expect(request).toMatchObject({
      verified: false,
      appId,
      action,
      allowLegacyProofs: false,
      rpContext: { rp_id: rpId },
    });
    if (request.verified) throw new Error("expected a proof request");
    const proof = proofFor(request);
    const verified = await service.verify(agentId, sponsor, request.requestId, proof);

    expect(verified).toMatchObject({ verified: true, reused: false, action });
    expect(portal).toHaveBeenCalledTimes(1);
    expect(store.worldIdAgentBindings.get(agentId)?.signer).toBe(signer);
    const persisted = JSON.stringify({
      requests: [...store.worldIdRequests.values()],
      sponsors: [...store.worldIdSponsorBindings.values()],
      agents: [...store.worldIdAgentBindings.values()],
    });
    expect(persisted).not.toContain(nullifier);
    expect(persisted).not.toContain(JSON.stringify(proof.responses[0]?.proof));
  });

  it("rejects a proof whose signal is not bound to sponsor, signer and agent", async () => {
    const { portal, service } = setup();
    const request = await service.request(agentId, sponsor);
    if (request.verified) throw new Error("expected a proof request");
    const proof = proofFor(request);
    proof.responses[0]!.signal_hash = `0x${"ff".repeat(32)}`;
    await expect(service.verify(agentId, sponsor, request.requestId, proof))
      .rejects.toMatchObject({ code: "WORLD_ID_PROOF_MISMATCH", status: 409 });
    expect(portal).not.toHaveBeenCalled();
  });

  it("consumes a verified RP request exactly once", async () => {
    const { portal, service } = setup();
    const request = await service.request(agentId, sponsor);
    if (request.verified) throw new Error("expected a proof request");
    const proof = proofFor(request);
    await service.verify(agentId, sponsor, request.requestId, proof);
    await expect(service.verify(agentId, sponsor, request.requestId, proof))
      .rejects.toMatchObject({ code: "WORLD_ID_REQUEST_INVALID", status: 409 });
    expect(portal).toHaveBeenCalledTimes(1);
  });

  it("reuses one verified sponsor wallet for a later BYOA agent without another World scan", async () => {
    const { store, service } = setup();
    const first = await service.request(agentId, sponsor);
    if (first.verified) throw new Error("expected a proof request");
    await service.verify(agentId, sponsor, first.requestId, proofFor(first));

    const secondId = `0x${"22".repeat(32)}` as Hex;
    await store.upsertAgentProfile(profile({ agentId: secondId, status: "pending_backing", worldBacked: false }));
    await expect(service.request(secondId, sponsor)).resolves.toEqual({ verified: true, reused: true });
    expect(store.worldIdAgentBindings.get(secondId)?.humanHash)
      .toBe(store.worldIdAgentBindings.get(agentId)?.humanHash);
  });

  it("enforces the managed-agent quota even when the sponsor proof is reusable", async () => {
    const { store, service } = setup("nuvem_reference", 1);
    const first = await service.request(agentId, sponsor);
    if (first.verified) throw new Error("expected a proof request");
    await service.verify(agentId, sponsor, first.requestId, proofFor(first));

    const secondId = `0x${"33".repeat(32)}` as Hex;
    await store.upsertAgentProfile(profile({
      agentId: secondId,
      runtimeKind: "nuvem_reference",
      status: "pending_backing",
      worldBacked: false,
    }));
    await expect(service.request(secondId, sponsor))
      .rejects.toMatchObject({ code: "MANAGED_AGENT_LIMIT", status: 409 });
  });

  it("fails closed when the World verifier rejects the proof", async () => {
    const { service, portal } = setup();
    portal.mockResolvedValueOnce(new Response(JSON.stringify({ success: false, code: "invalid_proof" }), { status: 400 }));
    const request = await service.request(agentId, sponsor);
    if (request.verified) throw new Error("expected a proof request");
    await expect(service.verify(agentId, sponsor, request.requestId, proofFor(request)))
      .rejects.toMatchObject({ code: "WORLD_ID_REJECTED", status: 403 });
  });
});
