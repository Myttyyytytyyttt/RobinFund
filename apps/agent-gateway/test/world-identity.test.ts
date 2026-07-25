import { hashSignal } from "@worldcoin/idkit-core/hashing";
import { describe, expect, it, vi } from "vitest";
import type { Hex } from "viem";
import { createGatewayApp, type GatewayAppDependencies } from "../src/app.js";
import { MemoryControlPlaneStore } from "../src/store.js";
import {
  AI_VAULT_IDENTITY_POLICY,
  AI_VAULT_IDENTITY_POLICY_ID,
  WorldIdentityCheckService,
  type WorldIdentityRequestResponse,
} from "../src/world-identity.js";
import { agentId, FakeChain, profile, signer, sponsor } from "./fixtures.js";

const productionAppId = "app_5fe197d24d83c55573c5d9d0356f3d6" as const;
const stagingAppId = "app_staging_5fe197d24d83c55573c5d9d0356f3d6" as const;
const rpId = "rp_db7d77ff9edef255";
const action = "ai-vault-identity-v1";
const rpKey = `0x${"12".repeat(32)}` as Hex;
const nullifier = `0x${"ab".repeat(32)}`;
const clock = new Date("2026-07-25T16:00:00.000Z");
const secondAgentId = `0x${"22".repeat(32)}` as Hex;
const secondSponsor = "0x3000000000000000000000000000000000000003" as const;
const secondSigner = "0x4000000000000000000000000000000000000004" as const;

function proofFor(
  request: Extract<WorldIdentityRequestResponse, { verified: false }>,
  overrides: Record<string, unknown> = {},
) {
  return {
    protocol_version: "4.0",
    nonce: request.rpContext.nonce,
    action,
    responses: [{
      identifier: "passport",
      signal_hash: hashSignal(request.signal),
      proof: Array.from({ length: 5 }, (_, index) => `0x${String(index + 1).padStart(64, "0")}`),
      nullifier,
      issuer_schema_id: 9_303,
      expires_at_min: Math.floor(clock.getTime() / 1_000) + 3_600,
    }],
    user_presence_completed: false,
    environment: request.environment,
    identity_attested: true,
    ...overrides,
  };
}

async function requestFor(service: WorldIdentityCheckService) {
  const request = await service.request(
    agentId,
    sponsor,
    "staging",
    AI_VAULT_IDENTITY_POLICY_ID,
  );
  if (request.verified) throw new Error("expected a fresh Identity Check request");
  return request;
}

function setup(options: {
  environment?: "staging" | "production";
  fetch?: (input: string, init: RequestInit) => Promise<Response>;
  verifyTimeoutMs?: number;
  attestationLifetimeSeconds?: number;
  maxManagedAgentsPerHuman?: number;
  runtimeKind?: "external" | "nuvem_reference";
} = {}) {
  const environment = options.environment ?? "staging";
  const appId = environment === "staging" ? stagingAppId : productionAppId;
  const store = new MemoryControlPlaneStore();
  void store.upsertAgentProfile(profile({
    status: "pending_backing",
    worldBacked: false,
    worldBackedUntil: null,
    runtimeKind: options.runtimeKind ?? "external",
  }));
  const chain = new FakeChain();
  const portal = vi.fn(options.fetch ?? (async () => new Response(JSON.stringify({
    success: true,
    results: [{
      identifier: "passport",
      success: true,
      nullifier,
    }],
    action,
    environment,
  }), {
    status: 200,
    headers: { "content-type": "application/json" },
  })));
  let sequence = 0;
  const service = new WorldIdentityCheckService(store, chain, {
    environment,
    appId,
    rpId,
    rpSigningKey: rpKey,
    action,
    worldIdPepper: "p".repeat(32),
    verifyTimeoutMs: options.verifyTimeoutMs,
    attestationLifetimeSeconds: options.attestationLifetimeSeconds,
    maxManagedAgentsPerHuman: options.maxManagedAgentsPerHuman,
  }, {
    sign: () => {
      sequence += 1;
      const createdAt = Math.floor(clock.getTime() / 1_000);
      return {
        sig: `0x${"34".repeat(65)}`,
        nonce: `identity-${sequence}`,
        createdAt,
        expiresAt: createdAt + 600,
      };
    },
    fetch: portal,
    now: () => new Date(clock),
  });
  return { appId, chain, environment, portal, service, store };
}

describe("WorldIdentityCheckService", () => {
  it("creates a server-selected staging Identity Check policy without reusing PoH", async () => {
    const { appId, service, store } = setup();
    store.worldIdAgentBindings.set(agentId, {
      agentId,
      sponsor,
      signer,
      humanHash: `0x${"99".repeat(32)}` as Hex,
      verifiedAt: new Date(clock),
      revokedAt: null,
    });

    const request = await requestFor(service);

    expect(request).toMatchObject({
      credential: "identity_check",
      verified: false,
      reused: false,
      environment: "staging",
      appId,
      action,
      allowLegacyProofs: false,
      requireUserPresence: false,
      policy: {
        id: AI_VAULT_IDENTITY_POLICY_ID,
        version: 1,
        attributes: [
          { type: "document_type", value: "passport" },
          { type: "minimum_age", value: 18 },
        ],
      },
      rpContext: { rp_id: rpId },
    });
    expect(request.signal).toMatch(/^0x[0-9a-f]{64}$/);
    const persisted = store.worldIdentityRequests.get(request.requestId);
    expect(persisted).toMatchObject({
      appId,
      rpId,
      environment: "staging",
      policyHash: AI_VAULT_IDENTITY_POLICY.hash,
      signalHash: hashSignal(request.signal).toLowerCase(),
      consumedAt: null,
    });
    expect(store.worldIdentityAgentBindings.size).toBe(0);
  });

  it("rejects an environment not authorized by this deployment", async () => {
    const { service, store } = setup({ environment: "production" });
    await expect(service.request(agentId, sponsor, "staging", AI_VAULT_IDENTITY_POLICY_ID))
      .rejects.toMatchObject({ code: "WORLD_IDENTITY_ENVIRONMENT_UNAVAILABLE", status: 409 });
    expect(store.worldIdentityRequests.size).toBe(0);
  });

  it("verifies Passport/9303, identity_attested and the agent signal exactly once", async () => {
    const { portal, service, store } = setup();
    const request = await requestFor(service);
    const proof = proofFor(request);

    await expect(service.verify(agentId, sponsor, request.requestId, proof))
      .resolves.toMatchObject({
        credential: "identity_check",
        verified: true,
        environment: "staging",
        action,
        policy: {
          id: AI_VAULT_IDENTITY_POLICY_ID,
          version: 1,
          hash: AI_VAULT_IDENTITY_POLICY.hash,
        },
        identityAttested: true,
      });
    expect(portal).toHaveBeenCalledTimes(1);
    expect(portal.mock.calls[0]?.[1]).toMatchObject({
      method: "POST",
      signal: expect.any(AbortSignal),
    });
    const binding = store.worldIdentityAgentBindings.get(agentId);
    expect(binding).toMatchObject({
      sponsor,
      signer,
      appId: stagingAppId,
      rpId,
      environment: "staging",
      policyHash: AI_VAULT_IDENTITY_POLICY.hash,
      credentialIdentifier: "passport",
      issuerSchemaId: 9_303,
    });
    const persisted = JSON.stringify({
      request: store.worldIdentityRequests.get(request.requestId),
      binding,
    });
    expect(persisted).not.toContain(nullifier);
    expect(persisted).not.toContain(JSON.stringify((proof.responses as Array<{ proof: string[] }>)[0]?.proof));

    await expect(service.verify(agentId, sponsor, request.requestId, proof))
      .rejects.toMatchObject({ code: "WORLD_IDENTITY_REQUEST_INVALID", status: 409 });
    expect(portal).toHaveBeenCalledTimes(1);

    await expect(service.request(agentId, sponsor, "staging", AI_VAULT_IDENTITY_POLICY_ID))
      .resolves.toMatchObject({
        credential: "identity_check",
        verified: true,
        reused: true,
        policy: { hash: AI_VAULT_IDENTITY_POLICY.hash },
        identityAttested: true,
      });
  });

  it.each([
    ["identity attestation", { identity_attested: false }],
    ["request environment", { environment: "production" }],
    ["request action", { action: "another-action" }],
    ["request nonce", { nonce: "another-nonce" }],
  ])("rejects a mismatched %s before contacting World", async (_label, override) => {
    const { portal, service } = setup();
    const request = await requestFor(service);
    await expect(service.verify(agentId, sponsor, request.requestId, proofFor(request, override)))
      .rejects.toMatchObject({ code: "WORLD_IDENTITY_PROOF_MISMATCH", status: 409 });
    expect(portal).not.toHaveBeenCalled();
  });

  it("rejects another credential, issuer schema or signal before contacting World", async () => {
    const { portal, service } = setup();
    const request = await requestFor(service);
    const proof = proofFor(request);
    const response = (proof.responses as Array<Record<string, unknown>>)[0]!;

    for (const mutation of [
      () => { response.identifier = "proof_of_human"; },
      () => { response.identifier = "passport"; response.issuer_schema_id = 1; },
      () => { response.issuer_schema_id = 9_303; response.signal_hash = `0x${"ff".repeat(32)}`; },
    ]) {
      mutation();
      await expect(service.verify(agentId, sponsor, request.requestId, proof))
        .rejects.toMatchObject({ code: "WORLD_IDENTITY_PROOF_MISMATCH", status: 409 });
    }
    expect(portal).not.toHaveBeenCalled();
  });

  it("requires the Portal result, nullifier, action and environment to match exactly", async () => {
    const { portal, service } = setup();
    const request = await requestFor(service);
    for (const payload of [
      {
        success: true,
        results: [{ identifier: "proof_of_human", success: true, nullifier }],
        action,
        environment: "staging",
      },
      {
        success: true,
        results: [{ identifier: "passport", success: true }],
        action,
        environment: "staging",
      },
      {
        success: true,
        results: [{ identifier: "passport", success: true, nullifier }],
        action: "wrong-action",
        environment: "staging",
      },
      {
        success: true,
        results: [{ identifier: "passport", success: true, nullifier }],
        action,
        environment: "production",
      },
    ]) {
      portal.mockResolvedValueOnce(new Response(JSON.stringify(payload), {
        status: 200,
        headers: { "content-type": "application/json" },
      }));
      await expect(service.verify(agentId, sponsor, request.requestId, proofFor(request)))
        .rejects.toMatchObject({ code: "WORLD_IDENTITY_REJECTED", status: 403 });
    }
  });

  it("fails closed when the World verifier times out", async () => {
    const timeoutFetch = (_input: string, init: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
    });
    const { service } = setup({ fetch: timeoutFetch, verifyTimeoutMs: 5 });
    const request = await requestFor(service);
    await expect(service.verify(agentId, sponsor, request.requestId, proofFor(request)))
      .rejects.toMatchObject({ code: "WORLD_IDENTITY_UNAVAILABLE", status: 503 });
  });

  it.each([
    ["a verifier 5xx", async () => new Response("upstream unavailable", { status: 503 }), 503, "WORLD_IDENTITY_UNAVAILABLE"],
    ["an invalid JSON response", async () => new Response("<html>bad gateway</html>", { status: 200 }), 503, "WORLD_IDENTITY_UNAVAILABLE"],
    ["a proof-level 4xx", async () => new Response(JSON.stringify({ success: false }), { status: 400 }), 403, "WORLD_IDENTITY_REJECTED"],
    ["verifier rate limiting", async () => new Response("", { status: 429 }), 429, "WORLD_IDENTITY_RATE_LIMITED"],
  ])("maps %s without consuming the request", async (_label, fetch, status, code) => {
    const { service, store } = setup({ fetch });
    const request = await requestFor(service);
    await expect(service.verify(agentId, sponsor, request.requestId, proofFor(request)))
      .rejects.toMatchObject({ code, status });
    expect(store.worldIdentityRequests.get(request.requestId)?.consumedAt).toBeNull();
  });

  it("keeps the verifier timeout active while parsing JSON", async () => {
    const parsingFetch = async (_input: string, init: RequestInit) => ({
      ok: true,
      status: 200,
      json: () => new Promise((_resolve, reject) => {
        init.signal?.addEventListener("abort", () => reject(new Error("aborted while parsing")), { once: true });
      }),
    }) as Response;
    const { service } = setup({ fetch: parsingFetch, verifyTimeoutMs: 5 });
    const request = await requestFor(service);
    await expect(service.verify(agentId, sponsor, request.requestId, proofFor(request)))
      .rejects.toMatchObject({ code: "WORLD_IDENTITY_UNAVAILABLE", status: 503 });
  });

  it("uses the server attestation TTL instead of treating expires_at_min as an expiry cap", async () => {
    const { service } = setup({ attestationLifetimeSeconds: 600 });
    const request = await requestFor(service);
    const proof = proofFor(request);
    (proof.responses[0] as { expires_at_min: number }).expires_at_min = 0;
    await expect(service.verify(agentId, sponsor, request.requestId, proof))
      .resolves.toMatchObject({
        validUntil: new Date(clock.getTime() + 600_000).toISOString(),
      });
  });

  it("reuses one sponsor identity for another agent without another World proof", async () => {
    const { portal, service, store } = setup();
    const firstRequest = await requestFor(service);
    await service.verify(agentId, sponsor, firstRequest.requestId, proofFor(firstRequest));
    await store.upsertAgentProfile(profile({
      agentId: secondAgentId,
      status: "pending_backing",
      worldBacked: false,
      worldBackedUntil: null,
    }));

    await expect(service.request(secondAgentId, sponsor, "staging", AI_VAULT_IDENTITY_POLICY_ID))
      .resolves.toMatchObject({
        credential: "identity_check",
        verified: true,
        reused: true,
      });
    expect(portal).toHaveBeenCalledTimes(1);
    expect(store.worldIdentityAgentBindings.get(secondAgentId)?.sponsorBindingId)
      .toBe(store.worldIdentityAgentBindings.get(agentId)?.sponsorBindingId);
  });

  it("enforces the managed-agent quota before creating or consuming a new request", async () => {
    const { service, store } = setup({
      runtimeKind: "nuvem_reference",
      maxManagedAgentsPerHuman: 1,
    });
    const firstRequest = await requestFor(service);
    await service.verify(agentId, sponsor, firstRequest.requestId, proofFor(firstRequest));
    await store.upsertAgentProfile(profile({
      agentId: secondAgentId,
      runtimeKind: "nuvem_reference",
      status: "pending_backing",
      worldBacked: false,
      worldBackedUntil: null,
    }));

    await expect(service.request(secondAgentId, sponsor, "staging", AI_VAULT_IDENTITY_POLICY_ID))
      .rejects.toMatchObject({ code: "MANAGED_AGENT_LIMIT", status: 409 });
    expect(store.worldIdentityRequests.size).toBe(1);
    expect(store.worldIdentityAgentBindings.has(secondAgentId)).toBe(false);
  });

  it("does not let the same scoped World identity switch sponsor wallets", async () => {
    const { chain, service, store } = setup();
    const firstRequest = await requestFor(service);
    await service.verify(agentId, sponsor, firstRequest.requestId, proofFor(firstRequest));
    await store.upsertAgentProfile(profile({
      agentId: secondAgentId,
      sponsor: secondSponsor,
      signer: secondSigner,
      status: "pending_backing",
      worldBacked: false,
      worldBackedUntil: null,
    }));
    chain.agent.sponsor = secondSponsor;
    chain.agent.signer = secondSigner;
    const conflictingRequest = await service.request(
      secondAgentId,
      secondSponsor,
      "staging",
      AI_VAULT_IDENTITY_POLICY_ID,
    );
    if (conflictingRequest.verified) throw new Error("expected a fresh conflicting request");

    await expect(service.verify(
      secondAgentId,
      secondSponsor,
      conflictingRequest.requestId,
      proofFor(conflictingRequest),
    )).rejects.toMatchObject({ code: "WORLD_IDENTITY_ALREADY_BOUND", status: 409 });
    expect(store.worldIdentityRequests.get(conflictingRequest.requestId)?.consumedAt).toBeNull();
    expect(store.worldIdentityAgentBindings.has(secondAgentId)).toBe(false);
  });

  it("allows only one winner when the same request is verified concurrently", async () => {
    const { service } = setup();
    const request = await requestFor(service);
    const proof = proofFor(request);
    const outcomes = await Promise.allSettled([
      service.verify(agentId, sponsor, request.requestId, proof),
      service.verify(agentId, sponsor, request.requestId, proof),
    ]);
    expect(outcomes.filter((entry) => entry.status === "fulfilled")).toHaveLength(1);
    expect(outcomes.filter((entry) => entry.status === "rejected")).toHaveLength(1);
  });

  it("dispatches the existing World ID routes to Identity Check without invoking PoH", async () => {
    const { chain, service, store } = setup();
    const legacyRequest = vi.fn();
    const legacyVerify = vi.fn();
    const app = createGatewayApp({
      store,
      chain,
      sponsors: { authenticate: async () => sponsor },
      worldIdentity: service,
      worldId: { request: legacyRequest, verify: legacyVerify },
      registryAddress: chain.registryAddress,
      allowedOrigins: [],
    } as unknown as GatewayAppDependencies);

    const requestResponse = await app.request(`/v1/agents/${agentId}/world-id/request`, {
      method: "POST",
      headers: {
        authorization: "Bearer sponsor",
        "content-type": "application/json",
        "idempotency-key": "identity-route-request",
      },
      body: JSON.stringify({
        credential: "identity_check",
        environment: "staging",
        policy: AI_VAULT_IDENTITY_POLICY_ID,
      }),
    });
    expect(requestResponse.status).toBe(201);
    const requestPayload = await requestResponse.json() as {
      worldId: Extract<WorldIdentityRequestResponse, { verified: false }>;
    };
    expect(requestPayload.worldId).toMatchObject({
      credential: "identity_check",
      verified: false,
      environment: "staging",
    });
    expect(legacyRequest).not.toHaveBeenCalled();

    const replayResponse = await app.request(`/v1/agents/${agentId}/world-id/request`, {
      method: "POST",
      headers: {
        authorization: "Bearer sponsor",
        "content-type": "application/json",
        "idempotency-key": "identity-route-request",
      },
      body: JSON.stringify({
        credential: "identity_check",
        environment: "staging",
        policy: AI_VAULT_IDENTITY_POLICY_ID,
      }),
    });
    expect(replayResponse.status).toBe(409);
    const replayPayload = await replayResponse.json();
    expect(replayPayload).toEqual({
      error: {
        code: "WORLD_ID_REQUEST_ALREADY_ISSUED",
        message: "Request a fresh World ID challenge",
      },
    });
    expect(JSON.stringify(replayPayload)).not.toContain(requestPayload.worldId.rpContext.nonce);
    expect(JSON.stringify(replayPayload)).not.toContain(requestPayload.worldId.rpContext.signature);

    const verifyResponse = await app.request(`/v1/agents/${agentId}/world-id/verify`, {
      method: "POST",
      headers: {
        authorization: "Bearer sponsor",
        "content-type": "application/json",
        "idempotency-key": "identity-route-verify",
      },
      body: JSON.stringify({
        credential: "identity_check",
        requestId: requestPayload.worldId.requestId,
        proof: proofFor(requestPayload.worldId),
      }),
    });
    expect(verifyResponse.status).toBe(200);
    await expect(verifyResponse.json()).resolves.toMatchObject({
      worldId: {
        credential: "identity_check",
        verified: true,
        identityAttested: true,
      },
    });
    expect(legacyVerify).not.toHaveBeenCalled();
  });
});
