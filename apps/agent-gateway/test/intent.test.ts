import type { Hex } from "viem";
import { describe, expect, it, vi } from "vitest";
import type { AgentSession, ExecutionPlan, QuoteRequest } from "../src/domain.js";
import { buildIntentDraft, IntentService } from "../src/intent.js";
import { MemoryControlPlaneStore } from "../src/store.js";
import {
  adapter,
  agentId,
  approvalProxy,
  controllerAddress,
  evidenceHash,
  executionHash,
  FakeChain,
  fund,
  policyHash,
  profile,
  reasoningHash,
  signer,
  sponsor,
  tokenIn,
  tokenOut,
} from "./fixtures.js";

const signature = `0x${"12".repeat(65)}` as Hex;

function execution(): { request: QuoteRequest; plan: ExecutionPlan } {
  const now = new Date();
  return {
    request: {
      agentId,
      tokenIn,
      tokenOut,
      amountIn: 1_000n,
      maxSlippageBps: 75,
      evidenceHash,
      reasoningHash,
      summary: "Test decision",
      provenance: {
        deploymentId: "deployment",
        blockNumber: 1n,
        blockTimestamp: now,
        chainHeadBlock: 1n,
        observedAt: now,
      },
    },
    plan: {
      proposalId: "00000000-0000-4000-8000-000000000001",
      quoteId: "00000000-0000-4000-8000-000000000002",
      quoteHash: `0x${"66".repeat(32)}`,
      adapter,
      approvalProxy,
      adapterId: 7n,
      fund,
      controller: controllerAddress,
      chainId: 4663,
      tokenIn,
      tokenOut,
      amountIn: 1_000n,
      quotedAmountOut: 990n,
      minAmountOut: 980n,
      routeCalldata: "0x12345678",
      adapterData: "0x1234",
      executionHash,
      expiresAt: new Date(Date.now() + 30_000),
    },
  };
}

function session(): AgentSession {
  return { id: "session", agentId, signer, sponsor, expiresAt: new Date(Date.now() + 60_000), revokedAt: null };
}

async function setup(validSignature = true) {
  const store = new MemoryControlPlaneStore();
  const chain = new FakeChain();
  await store.upsertAgentProfile(profile());
  const stored = execution();
  await store.saveExecutionPlan(stored.request, stored.plan);
  const service = new IntentService(store, chain, vi.fn(async () => validSignature));
  const draft = buildIntentDraft(profile(), chain.controller, stored.request, stored.plan);
  return { store, chain, service, stored, draft };
}

describe("signed trade intent acceptance", () => {
  it("queues a correctly bound EIP-712 intent", async () => {
    const { store, service, stored, draft } = await setup();
    const result = await service.accept(session(), { quoteId: stored.plan.quoteId, intent: draft.intent, signature });
    expect(result.state).toBe("queued");
    expect([...store.jobs.values()]).toHaveLength(1);
    expect(result.typedData.domain).toMatchObject({ chainId: 4663, verifyingContract: controllerAddress });
  });

  it("rejects calldata/execution hash substitution", async () => {
    const { service, stored, draft } = await setup();
    const altered = { ...draft.intent, executionHash: `0x${"ff".repeat(32)}` as Hex };
    await expect(service.accept(session(), { quoteId: stored.plan.quoteId, intent: altered, signature }))
      .rejects.toMatchObject({ code: "INTENT_BINDING_MISMATCH" });
  });

  it("rejects a stale controller nonce", async () => {
    const { service, stored, draft, chain } = await setup();
    chain.controller.nextNonce = 1n;
    await expect(service.accept(session(), { quoteId: stored.plan.quoteId, intent: draft.intent, signature }))
      .rejects.toMatchObject({ code: "NONCE_MISMATCH" });
  });

  it("rejects a signer rotated after session creation", async () => {
    const { service, stored, draft, chain } = await setup();
    chain.agent.signer = "0x9999999999999999999999999999999999999999";
    await expect(service.accept(session(), { quoteId: stored.plan.quoteId, intent: draft.intent, signature }))
      .rejects.toMatchObject({ code: "SIGNER_ROTATED" });
  });

  it("rejects an invalid EIP-712 signature", async () => {
    const { service, stored, draft } = await setup(false);
    await expect(service.accept(session(), { quoteId: stored.plan.quoteId, intent: draft.intent, signature }))
      .rejects.toMatchObject({ code: "INVALID_INTENT_SIGNATURE" });
  });

  it("rejects an expired quote before signature verification", async () => {
    const { service, stored, draft } = await setup();
    stored.plan.expiresAt = new Date(Date.now() - 1_000);
    const memory = (service as unknown as { store: MemoryControlPlaneStore }).store;
    memory.plans.set(stored.plan.quoteId, stored);
    await expect(service.accept(session(), { quoteId: stored.plan.quoteId, intent: draft.intent, signature }))
      .rejects.toMatchObject({ code: "QUOTE_EXPIRED" });
  });

  it("allows only one queued intent for a controller nonce", async () => {
    const { service, stored, draft } = await setup();
    await service.accept(session(), { quoteId: stored.plan.quoteId, intent: draft.intent, signature });
    await expect(service.accept(session(), { quoteId: stored.plan.quoteId, intent: draft.intent, signature }))
      .rejects.toMatchObject({ code: "NONCE_ALREADY_QUEUED" });
  });
});
