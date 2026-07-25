import { describe, expect, it, vi } from "vitest";
import type { Address } from "viem";
import { createGatewayApp, type GatewayAppDependencies } from "../src/app.js";
import { ManagedSignerService } from "../src/managed-signer.js";
import { MemoryControlPlaneStore } from "../src/store.js";
import { VaultWorkerConfigurationError } from "../src/vault-worker-service.js";
import { agentId, FakeChain, policy, profile, registry, signer, sponsor } from "./fixtures.js";

const otherSponsor = "0xa00000000000000000000000000000000000000a" as Address;
const otherSigner = "0xb00000000000000000000000000000000000000b" as Address;

function vaultRequest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    agentId,
    signer,
    displayName: "Adversarial Test Agent",
    strategySummary: "Tests the authenticated vault ingress.",
    metadataUri: "ipfs://agent",
    runtimeKind: "external",
    policy,
    economy: {
      name: "Adversarial Test Fund",
      symbol: "ATF",
      initialStake: "2000",
      perfFeeBps: 2_000,
      feeMinBps: 0,
      feeMaxBps: 200,
      managerEntryShareBps: 5_000,
      kFactor: 25,
      periodDays: 30,
      cooldownHours: 24,
    },
    ...overrides,
  };
}

function setup(
  authenticatedSponsor: Address = sponsor,
  vaultDeployment?: GatewayAppDependencies["vaultDeployment"],
) {
  const store = new MemoryControlPlaneStore();
  const chain = new FakeChain();
  let currentSponsor = authenticatedSponsor;
  const managedSigners = new ManagedSignerService(
    store,
    "test-only-managed-signer-secret-that-is-long-enough",
  );
  const app = createGatewayApp({
    store,
    chain,
    managedSigners,
    sponsors: { authenticate: async () => currentSponsor },
    vaultDeployment,
    registryAddress: registry,
    allowedOrigins: [],
  } as unknown as GatewayAppDependencies);
  let key = 0;
  const post = (request: Record<string, unknown>, idempotencyKey = `vault-route-${++key}`) => app.request(
    "/v1/agent-vaults",
    {
      method: "POST",
      headers: {
        authorization: "Bearer sponsor",
        "content-type": "application/json",
        "idempotency-key": idempotencyKey,
      },
      body: JSON.stringify(request),
    },
  );
  const setAuthenticatedSponsor = (value: Address) => {
    currentSponsor = value;
  };
  const process = (jobId: string, idempotencyKey = `vault-process-${++key}`) => app.request(
    `/v1/agent-vaults/${jobId}/process`,
    {
      method: "POST",
      headers: {
        authorization: "Bearer sponsor",
        "content-type": "application/json",
        "idempotency-key": idempotencyKey,
      },
      body: "{}",
    },
  );
  return { app, chain, managedSigners, post, process, setAuthenticatedSponsor, store };
}

async function errorCode(response: Response): Promise<string | undefined> {
  const payload = await response.json() as { error?: { code?: string } };
  return payload.error?.code;
}

describe("POST /v1/agent-vaults", () => {
  it("keeps generic profile ownership immutable while allowing chain-validated signer sync", async () => {
    const store = new MemoryControlPlaneStore();
    await store.upsertAgentProfile(profile());

    await expect(store.upsertAgentProfile(profile({ sponsor: otherSponsor })))
      .rejects.toThrow("ownership mismatch");
    await expect(store.upsertAgentProfile(profile({ signer: otherSigner })))
      .rejects.toThrow("ownership mismatch");
    await expect(store.syncAgentProfile(profile({ signer: otherSigner }))).resolves.toBeUndefined();
    expect(store.profiles.get(agentId)?.signer).toBe(otherSigner);
    await expect(store.syncAgentProfile(profile({ sponsor: otherSponsor })))
      .rejects.toThrow("sponsor mismatch");
  });

  it("rejects an agent owned by another onchain sponsor without writing state", async () => {
    const { post, store } = setup(otherSponsor);
    const response = await post(vaultRequest());

    expect(response.status).toBe(403);
    await expect(errorCode(response)).resolves.toBe("NOT_SPONSOR");
    expect(store.profiles.size).toBe(0);
    expect(store.vaultJobs.size).toBe(0);
  });

  it("rejects a signer that differs from AgentRegistry without writing state", async () => {
    const { chain, post, store } = setup();
    chain.agent.signer = otherSigner;
    const response = await post(vaultRequest());

    expect(response.status).toBe(409);
    await expect(errorCode(response)).resolves.toBe("AGENT_SIGNER_MISMATCH");
    expect(store.profiles.size).toBe(0);
    expect(store.vaultJobs.size).toBe(0);
  });

  it.each([2, 3])("rejects onchain agent status %i for a new deployment", async (status) => {
    const { chain, post, store } = setup();
    chain.agent.status = status;
    chain.agent.active = false;
    const response = await post(vaultRequest());

    expect(response.status).toBe(409);
    await expect(errorCode(response)).resolves.toBe("AGENT_NOT_DEPLOYABLE");
    expect(store.profiles.size).toBe(0);
    expect(store.vaultJobs.size).toBe(0);
  });

  it("allows a newly registered PendingBacking agent", async () => {
    const { chain, post, store } = setup();
    chain.agent.status = 0;
    chain.agent.active = false;
    const response = await post(vaultRequest());

    expect(response.status).toBe(202);
    expect(store.profiles.get(agentId)?.status).toBe("pending_backing");
    expect(store.vaultJobs.size).toBe(1);
  });

  it("does not overwrite a conflicting stored profile owner", async () => {
    const { post, store } = setup();
    await store.upsertAgentProfile({
      agentId,
      sponsor: otherSponsor,
      signer: otherSigner,
      vault: null,
      controller: null,
      policyHash: null,
      policy,
      worldBacked: false,
      worldBackedUntil: null,
      runtimeKind: "external",
      status: "pending_backing",
    });
    const response = await post(vaultRequest());

    expect(response.status).toBe(409);
    await expect(errorCode(response)).resolves.toBe("AGENT_PROFILE_OWNERSHIP_CONFLICT");
    expect(store.profiles.get(agentId)).toMatchObject({
      sponsor: otherSponsor,
      signer: otherSigner,
    });
    expect(store.vaultJobs.size).toBe(0);
  });

  it("derives nuvem_reference from the managed signer record even when the body says external", async () => {
    const { post, store } = setup();
    await store.upsertManagedSigner({
      agentId,
      sponsor,
      signer,
      provisioningKey: "018f9a38-59ff-7f30-a3ee-91cddfc6dc3d",
      provider: "local-derived-v1",
      status: "provisioned",
      createdAt: new Date(),
    });

    const first = await post(vaultRequest({ runtimeKind: "external" }), "managed-create-1");
    const resumed = await post(vaultRequest({ runtimeKind: "external" }), "managed-create-2");

    expect(first.status).toBe(202);
    expect(resumed.status).toBe(202);
    await expect(resumed.json()).resolves.toMatchObject({ resumed: true });
    expect(store.profiles.get(agentId)?.runtimeKind).toBe("nuvem_reference");
    expect([...store.vaultJobs.values()][0]?.request.runtimeKind).toBe("nuvem_reference");
    expect(store.managedSigners.get(agentId)?.status).toBe("bound");
    expect(store.vaultJobs.size).toBe(1);
  });

  it("requires a provisioned managed signer when the requested UX is nuvem_reference", async () => {
    const { post, store } = setup();
    const response = await post(vaultRequest({ runtimeKind: "nuvem_reference" }));

    expect(response.status).toBe(409);
    await expect(errorCode(response)).resolves.toBe("MANAGED_SIGNER_REQUIRED");
    expect(store.profiles.size).toBe(0);
    expect(store.vaultJobs.size).toBe(0);
  });

  it.each(["retired", "mismatched"] as const)("fails closed for a %s managed signer record", async (kind) => {
    const { post, store } = setup();
    await store.upsertManagedSigner({
      agentId,
      sponsor: kind === "mismatched" ? otherSponsor : sponsor,
      signer: kind === "mismatched" ? otherSigner : signer,
      provisioningKey: "018f9a38-59ff-7f30-a3ee-91cddfc6dc3d",
      provider: "local-derived-v1",
      status: kind === "retired" ? "retired" : "provisioned",
      createdAt: new Date(),
    });

    const response = await post(vaultRequest({ runtimeKind: "external" }));

    expect(response.status).toBe(409);
    await expect(errorCode(response)).resolves.toBe("MANAGED_SIGNER_MISMATCH");
    expect(store.profiles.size).toBe(0);
    expect(store.vaultJobs.size).toBe(0);
  });

  it("resumes a matching live job without depending on an RPC round trip", async () => {
    const { chain, post, store } = setup();
    const first = await post(vaultRequest(), "resume-before-rpc-a");
    const firstPayload = await first.json() as { job: { id: string } };
    vi.spyOn(chain, "getAgent").mockRejectedValue(new Error("RPC unavailable"));

    const resumed = await post(vaultRequest(), "resume-before-rpc-b");
    const resumedPayload = await resumed.json() as { job: { id: string }; resumed?: boolean };

    expect(resumed.status).toBe(202);
    expect(resumedPayload).toEqual({
      job: { id: firstPayload.job.id, state: "requested" },
      resumed: true,
    });
    expect(store.vaultJobs.size).toBe(1);
  });

  it("rejects a different request for a live job without mutating it", async () => {
    const { post, store } = setup();
    const original = vaultRequest();
    const first = await post(original, "live-conflict-a");
    expect(first.status).toBe(202);
    const storedBefore = structuredClone([...store.vaultJobs.values()][0]);

    const conflicting = await post(
      vaultRequest({ displayName: "Different Agent" }),
      "live-conflict-b",
    );

    expect(conflicting.status).toBe(409);
    await expect(errorCode(conflicting)).resolves.toBe("VAULT_JOB_CONFLICT");
    expect([...store.vaultJobs.values()][0]).toEqual(storedBefore);
    expect(store.vaultJobs.size).toBe(1);
  });

  it("does not expose another sponsor's live deployment as resumable", async () => {
    const { post, setAuthenticatedSponsor, store } = setup();
    const first = await post(vaultRequest(), "foreign-job-a");
    expect(first.status).toBe(202);
    setAuthenticatedSponsor(otherSponsor);

    const response = await post(vaultRequest(), "foreign-job-b");

    expect(response.status).toBe(403);
    await expect(errorCode(response)).resolves.toBe("NOT_SPONSOR");
    expect(store.vaultJobs.size).toBe(1);
  });

  it("replays an identical idempotency key and conflicts if its body changes", async () => {
    const { post, store } = setup();
    const request = vaultRequest();
    const first = await post(request, "same-idempotency-key");
    const replay = await post(request, "same-idempotency-key");
    const conflict = await post(
      vaultRequest({ displayName: "Changed Agent" }),
      "same-idempotency-key",
    );

    expect(first.status).toBe(202);
    expect(replay.status).toBe(202);
    await expect(replay.json()).resolves.toEqual(await first.json());
    expect(conflict.status).toBe(409);
    await expect(errorCode(conflict)).resolves.toBe("IDEMPOTENCY_CONFLICT");
    expect(store.vaultJobs.size).toBe(1);
  });

  it("serializes concurrent requests with different idempotency keys into one live job", async () => {
    const { post, store } = setup();
    const [first, second] = await Promise.all([
      post(vaultRequest(), "concurrent-vault-a"),
      post(vaultRequest(), "concurrent-vault-b"),
    ]);

    expect(first.status).toBe(202);
    expect(second.status).toBe(202);
    const payloads = await Promise.all([first.json(), second.json()]) as Array<{
      job: { id: string };
      resumed?: boolean;
    }>;
    expect(payloads[0]?.job.id).toBe(payloads[1]?.job.id);
    expect(payloads.filter((payload) => payload.resumed === true)).toHaveLength(1);
    expect(store.profiles.size).toBe(1);
    expect(store.vaultJobs.size).toBe(1);
  });

  it("commits only the winning request when concurrent bodies conflict", async () => {
    const { post, store } = setup();
    const [first, second] = await Promise.all([
      post(vaultRequest({ displayName: "Concurrent Alpha" }), "concurrent-conflict-a"),
      post(vaultRequest({ displayName: "Concurrent Beta" }), "concurrent-conflict-b"),
    ]);

    expect([first.status, second.status].sort()).toEqual([202, 409]);
    const rejected = first.status === 409 ? first : second;
    await expect(errorCode(rejected)).resolves.toBe("VAULT_JOB_CONFLICT");
    expect(store.profiles.size).toBe(1);
    expect(store.vaultJobs.size).toBe(1);
    const job = [...store.vaultJobs.values()][0]!;
    expect(["Concurrent Alpha", "Concurrent Beta"]).toContain(job.request.displayName);
  });

  it.each([
    ["empty economy", {}],
    ["zero stake", {
      name: "Adversarial Test Fund",
      symbol: "ATF",
      initialStake: "0",
      perfFeeBps: 2_000,
      feeMinBps: 0,
      feeMaxBps: 200,
      managerEntryShareBps: 5_000,
      kFactor: 25,
      periodDays: 30,
      cooldownHours: 24,
    }],
    ["oversized stake", {
      name: "Adversarial Test Fund",
      symbol: "ATF",
      initialStake: "10000001",
      perfFeeBps: 2_000,
      feeMinBps: 0,
      feeMaxBps: 200,
      managerEntryShareBps: 5_000,
      kFactor: 25,
      periodDays: 30,
      cooldownHours: 24,
    }],
    ["inverted fees", {
      name: "Adversarial Test Fund",
      symbol: "ATF",
      initialStake: "2000",
      perfFeeBps: 2_000,
      feeMinBps: 300,
      feeMaxBps: 200,
      managerEntryShareBps: 5_000,
      kFactor: 25,
      periodDays: 30,
      cooldownHours: 24,
    }],
    ["lowercase symbol", {
      name: "Adversarial Test Fund",
      symbol: "atf",
      initialStake: "2000",
      perfFeeBps: 2_000,
      feeMinBps: 0,
      feeMaxBps: 200,
      managerEntryShareBps: 5_000,
      kFactor: 25,
      periodDays: 30,
      cooldownHours: 24,
    }],
  ])("rejects %s before persisting a poisoned job", async (_label, economy) => {
    const { chain, post, store } = setup();
    const getAgent = vi.spyOn(chain, "getAgent");
    const response = await post(vaultRequest({ economy }));

    expect(response.status).toBe(400);
    await expect(errorCode(response)).resolves.toBe("INVALID_REQUEST");
    expect(getAgent).not.toHaveBeenCalled();
    expect(store.profiles.size).toBe(0);
    expect(store.vaultJobs.size).toBe(0);
  });
});

describe("POST /v1/agent-vaults/:id/process", () => {
  async function createJob(
    context: ReturnType<typeof setup>,
  ): Promise<string> {
    const created = await context.post(vaultRequest(), "process-create-job");
    expect(created.status).toBe(202);
    const payload = await created.json() as { job: { id: string } };
    return payload.job.id;
  }

  function activateAgent(context: ReturnType<typeof setup>): void {
    const stored = context.store.profiles.get(agentId);
    if (!stored) throw new Error("missing test profile");
    stored.worldBacked = true;
    stored.worldBackedUntil = new Date(Date.now() + 60_000);
    stored.status = "active";
    context.chain.agent.active = true;
    context.chain.agent.status = 1;
    context.chain.agent.backedUntil = Math.floor(Date.now() / 1_000) + 60;
  }

  it("advances one globally serialized worker transition for an active World-backed job", async () => {
    const processNextEligible = vi.fn(async () => ({
      claimed: 1,
      awaitingSponsor: 0,
      failed: 0,
      jobId: "",
    }));
    const context = setup(sponsor, { processNextEligible });
    const jobId = await createJob(context);
    processNextEligible.mockResolvedValue({
      claimed: 1,
      awaitingSponsor: 0,
      failed: 0,
      jobId,
    });
    activateAgent(context);

    const response = await context.process(jobId);

    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toMatchObject({
      job: { id: jobId, state: "requested" },
      processed: true,
    });
    expect(processNextEligible).toHaveBeenCalledTimes(1);
  });

  it("does not report the target as processed when the global nonce queue advances another job", async () => {
    const processNextEligible = vi.fn(async () => ({
      claimed: 1,
      awaitingSponsor: 0,
      failed: 0,
      jobId: "older-global-job",
    }));
    const context = setup(sponsor, { processNextEligible });
    const jobId = await createJob(context);
    activateAgent(context);

    const response = await context.process(jobId);

    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toMatchObject({
      job: { id: jobId, state: "requested" },
      processed: false,
    });
  });

  it("does not expose or process another sponsor's job", async () => {
    const processNextEligible = vi.fn();
    const context = setup(sponsor, { processNextEligible });
    const jobId = await createJob(context);
    activateAgent(context);
    context.setAuthenticatedSponsor(otherSponsor);

    const response = await context.process(jobId);

    expect(response.status).toBe(403);
    await expect(errorCode(response)).resolves.toBe("NOT_SPONSOR");
    expect(processNextEligible).not.toHaveBeenCalled();
  });

  it("requires completed onchain World backing before any worker transition", async () => {
    const processNextEligible = vi.fn();
    const context = setup(sponsor, { processNextEligible });
    const jobId = await createJob(context);

    const response = await context.process(jobId);

    expect(response.status).toBe(409);
    await expect(errorCode(response)).resolves.toBe("VAULT_AGENT_NOT_ACTIVE");
    expect(processNextEligible).not.toHaveBeenCalled();
  });

  it("returns an actionable 503 when request-driven deployment is not configured", async () => {
    const context = setup();
    const jobId = await createJob(context);
    activateAgent(context);

    const response = await context.process(jobId);

    expect(response.status).toBe(503);
    await expect(errorCode(response)).resolves.toBe("VAULT_WORKER_NOT_CONFIGURED");
  });

  it("distinguishes permanent worker configuration failures from temporary outages", async () => {
    const context = setup(sponsor, {
      processNextEligible: async () => {
        throw new VaultWorkerConfigurationError();
      },
    });
    const jobId = await createJob(context);
    activateAgent(context);

    const response = await context.process(jobId);

    expect(response.status).toBe(503);
    await expect(errorCode(response)).resolves.toBe("VAULT_WORKER_NOT_CONFIGURED");
  });

  it("keeps terminal jobs inspectable without invoking or configuring the worker", async () => {
    const context = setup();
    const jobId = await createJob(context);
    const job = context.store.vaultJobs.get(jobId);
    if (!job) throw new Error("missing test job");
    job.state = "failed";
    job.errorCode = "INVALID_VAULT_JOB";
    job.request = {};

    const response = await context.process(jobId);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      job: {
        id: jobId,
        state: "failed",
        errorCode: "INVALID_VAULT_JOB",
        requiredStake6: "0",
      },
      processed: false,
    });
  });
});
