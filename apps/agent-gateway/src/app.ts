import { Hono, type Context } from "hono";
import { cors } from "hono/cors";
import { streamSSE } from "hono/streaming";
import { encodeFunctionData, getAddress, type Address, type Hex } from "viem";
import { z } from "zod";
import { AgentAuthError, AgentSessionService } from "./agentkit.js";
import type { AgentChainReader } from "./chain.js";
import { requestHash, stableJson } from "./crypto.js";
import type { AgentPolicy, AgentProfile, AgentSession, TradeIntentV1 } from "./domain.js";
import type { VaultJobRecord } from "./domain.js";
import { GraphDataError, type VaultIntelligence } from "./graph.js";
import { buildIntentDraft, IntentService, IntentValidationError } from "./intent.js";
import { ManagedSignerService } from "./managed-signer.js";
import { SponsorAuthError, SupabaseSponsorAuth } from "./sponsor-auth.js";
import type { ControlPlaneStore } from "./store.js";
import { UniswapApiError, UniswapTradingApi } from "./uniswap.js";
import { WorldBackingService } from "./world-backing.js";
import { WorldIdSponsorService } from "./world-id.js";
import { WorldRegistrationService } from "./world-registration.js";
import { parseRequiredStake6 } from "./vault-worker.js";

const hex32Schema = z.string().regex(/^0x[0-9a-fA-F]{64}$/).transform((value) => value.toLowerCase() as Hex);
const addressSchema = z.string().transform((value, context) => {
  try {
    return getAddress(value).toLowerCase() as Address;
  } catch {
    context.addIssue({ code: "custom", message: "invalid EVM address" });
    return z.NEVER;
  }
});
const decimalSchema = z.union([z.string(), z.number(), z.bigint()]).transform((value, context) => {
  try {
    const result = BigInt(value);
    if (result < 0n) throw new Error("negative");
    return result;
  } catch {
    context.addIssue({ code: "custom", message: "invalid unsigned integer" });
    return z.NEVER;
  }
});

const policySchema = z.object({
  maxTradeBps: z.number().int().min(100).max(2_000).default(1_000),
  maxConcentrationBps: z.number().int().min(1_000).max(5_000).default(3_500),
  dailyTurnoverBps: z.number().int().min(500).max(10_000).default(5_000),
  maxSlippageBps: z.number().int().min(10).max(100).default(75),
  maxTradesPerDay: z.number().int().min(1).max(200).default(24),
  minTradeInterval: z.number().int().min(60).max(3_600).default(300),
  maxIntentLifetime: z.number().int().min(1).max(300).default(300),
  allowedAssets: z.array(addressSchema).min(1).max(32),
});

const quoteSchema = z.object({
  tokenIn: addressSchema,
  tokenOut: addressSchema,
  amountIn: decimalSchema.refine((value) => value > 0n),
  maxSlippageBps: z.number().int().min(10).max(100),
  evidenceHash: hex32Schema,
  reasoningHash: hex32Schema,
  summary: z.string().trim().min(1).max(2_000),
  contextDeploymentId: z.string().min(1),
  contextBlockNumber: decimalSchema,
});

const intentMessageSchema = z.object({
  agentId: hex32Schema,
  fund: addressSchema,
  tokenIn: addressSchema,
  tokenOut: addressSchema,
  amountIn: decimalSchema,
  minAmountOut: decimalSchema,
  maxSlippageBps: z.number().int().min(1).max(10_000),
  policyHash: hex32Schema,
  executionHash: hex32Schema,
  evidenceHash: hex32Schema,
  nonce: decimalSchema,
  validAfter: z.number().int().nonnegative(),
  deadline: z.number().int().positive(),
});

const signedIntentSchema = z.object({
  quoteId: z.string().uuid(),
  intent: intentMessageSchema,
  signature: z.string().regex(/^0x[0-9a-fA-F]+$/).transform((value) => value as Hex),
});

const vaultJobSchema = z.object({
  agentId: hex32Schema,
  signer: addressSchema,
  displayName: z.string().trim().min(2).max(64),
  strategySummary: z.string().trim().max(1_000).default(""),
  metadataUri: z.string().trim().max(2_048).default(""),
  runtimeKind: z.enum(["external", "nuvem_reference"]),
  policy: policySchema,
  economy: z.record(z.string(), z.unknown()),
});

const heartbeatSchema = z.object({
  runtimeVersion: z.string().trim().min(1).max(128),
  capabilities: z.array(z.string().trim().min(1).max(128)).max(64),
});

const decisionSchema = z.object({
  decision: z.enum(["hold", "rejected"]),
  summary: z.string().trim().min(1).max(2_000),
  evidenceRefs: z.array(z.record(z.string(), z.unknown())).max(32).default([]),
  contextDeploymentId: z.string().min(1),
  contextBlockNumber: decimalSchema,
});
const syncSchema = z.object({ controller: addressSchema.optional() });
const managedSignerSchema = z.object({ provisioningKey: z.string().uuid() });
const worldRegistrationSchema = z.object({
  root: z.string().regex(/^(?:0x[0-9a-fA-F]+|[0-9]+)$/),
  nonce: decimalSchema,
  nullifierHash: z.string().regex(/^(?:0x[0-9a-fA-F]+|[0-9]+)$/),
  proof: z.array(z.string().regex(/^0x[0-9a-fA-F]{64}$/).transform((value) => value.toLowerCase() as Hex)).length(8),
});
const worldIdVerifySchema = z.object({
  requestId: z.string().uuid(),
  proof: z.unknown(),
});

type MutationResult = {
  status: number;
  body: unknown;
  replayStatus?: number;
  replayBody?: unknown;
};

function safe(value: unknown): unknown {
  return JSON.parse(stableJson(value)) as unknown;
}

function response(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(safe(body)), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...headers },
  });
}

function parseAgentId(value: string): Hex {
  const result = hex32Schema.safeParse(value);
  if (!result.success) throw new IntentValidationError("INVALID_AGENT_ID", "Invalid agent id", 400);
  return result.data;
}

async function body(c: Context): Promise<unknown> {
  try {
    return await c.req.json();
  } catch {
    throw new IntentValidationError("INVALID_JSON", "Request body must be JSON", 400);
  }
}

function parsed<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw new IntentValidationError("INVALID_REQUEST", result.error.issues[0]?.message ?? "Invalid request", 400);
  }
  return result.data;
}

function publicVaultJob(job: VaultJobRecord): Record<string, unknown> {
  return {
    id: job.id,
    agentId: job.agentId,
    state: job.state,
    controller: job.controller,
    fund: job.fund,
    stakeEscrow: job.stakeEscrow,
    transactionHashes: job.transactionHashes,
    attempts: job.attempts,
    errorCode: job.errorCode,
    requiredStake6: parseRequiredStake6(job).toString(),
  };
}

export interface GatewayAppDependencies {
  store: ControlPlaneStore;
  sessions: AgentSessionService;
  sponsors: SupabaseSponsorAuth;
  chain: AgentChainReader;
  graph: VaultIntelligence;
  uniswap: UniswapTradingApi;
  intents: IntentService;
  worldId: WorldIdSponsorService;
  worldBacking: WorldBackingService;
  managedSigners: ManagedSignerService;
  worldRegistration: WorldRegistrationService;
  registryAddress: Address;
  mcpHandler: (request: Request) => Promise<Response>;
  allowedOrigins?: string[];
  tradingEnabled?: boolean;
}

async function runMutation(
  c: Context,
  store: ControlPlaneStore,
  scope: string,
  request: unknown,
  execute: () => Promise<MutationResult>,
): Promise<Response> {
  const key = c.req.header("idempotency-key")?.trim();
  if (!key || key.length < 8 || key.length > 128) {
    return response({ error: { code: "IDEMPOTENCY_KEY_REQUIRED", message: "Idempotency-Key must contain 8-128 characters" } }, 400);
  }
  const reservation = await store.reserveIdempotency(scope, key, requestHash(request));
  if (reservation.kind === "conflict") {
    return response({ error: { code: "IDEMPOTENCY_CONFLICT", message: "Key was used with a different request" } }, 409);
  }
  if (reservation.kind === "processing") {
    return response({ error: { code: "IDEMPOTENCY_IN_PROGRESS", message: "Original request is still processing" } }, 409, { "retry-after": "2" });
  }
  if (reservation.kind === "replay") return response(reservation.body, reservation.statusCode ?? 200);
  try {
    const result = await execute();
    await store.completeIdempotency(
      scope,
      key,
      result.replayStatus ?? result.status,
      result.replayBody ?? result.body,
    );
    return response(result.body, result.status);
  } catch (error) {
    const formatted = errorBody(error);
    await store.failIdempotency(scope, key, formatted.status, formatted.body);
    return response(formatted.body, formatted.status);
  }
}

function errorBody(error: unknown): { status: number; body: unknown } {
  if (
    error instanceof AgentAuthError
    || error instanceof IntentValidationError
    || error instanceof SponsorAuthError
    || error instanceof GraphDataError
    || error instanceof UniswapApiError
  ) return { status: error.status, body: { error: { code: error.code, message: error.message } } };
  return { status: 500, body: { error: { code: "INTERNAL_ERROR", message: "Unexpected gateway error" } } };
}

async function sessionForAgent(c: Context, sessions: AgentSessionService, agentId: Hex): Promise<AgentSession> {
  const session = await sessions.authenticateBearer(c.req.header("authorization"));
  if (session.agentId.toLowerCase() !== agentId.toLowerCase()) {
    throw new AgentAuthError("AGENT_MISMATCH", "Session belongs to another agent", 403);
  }
  return session;
}

export function createGatewayApp(dependencies: GatewayAppDependencies): Hono {
  const app = new Hono();
  const origins = new Set(dependencies.allowedOrigins ?? []);
  app.use("*", cors({
    origin: (origin) => origins.size === 0 || origins.has(origin) ? origin : "",
    allowHeaders: ["authorization", "content-type", "idempotency-key", "x-agentkit", "mcp-session-id", "last-event-id", "mcp-protocol-version"],
    allowMethods: ["GET", "POST", "DELETE", "OPTIONS"],
    exposeHeaders: ["x-request-id", "mcp-session-id", "mcp-protocol-version"],
    maxAge: 600,
  }));

  app.get("/healthz", (c) => c.json({ ok: true, service: "nuvem-agent-gateway", version: "v1" }));
  app.get("/openapi.json", (c) => c.json(openApiDocument()));
  app.all("/mcp", (c) => dependencies.mcpHandler(c.req.raw));

  app.post("/v1/agent-sessions/challenge", async (c) => {
    const raw = await body(c);
    const input = parsed(z.object({ agentId: hex32Schema }), raw);
    return runMutation(c, dependencies.store, `session-challenge:${input.agentId}`, raw, async () => ({
      status: 201,
      body: { agentkit: await dependencies.sessions.createChallenge(input.agentId) },
    }));
  });

  app.post("/v1/agent-sessions", async (c) => {
    const raw = await body(c);
    const input = parsed(z.object({ agentId: hex32Schema }), raw);
    const agentkit = c.req.header("x-agentkit");
    if (!agentkit) return response({ error: { code: "AGENTKIT_REQUIRED", message: "X-AgentKit header required" } }, 401);
    return runMutation(c, dependencies.store, `agent-session:${input.agentId}`, raw, async () => ({
      status: 201,
      body: await dependencies.sessions.createSession(input.agentId, agentkit),
      // The bearer token is never persisted in an idempotency response.
      replayStatus: 409,
      replayBody: { error: { code: "SESSION_ALREADY_ISSUED", message: "Open a fresh AgentKit challenge" } },
    }));
  });

  app.get("/v1/agents/:id/context", async (c) => {
    if (dependencies.tradingEnabled === false) {
      return response({ error: { code: "TRADING_NOT_CONFIGURED", message: "Graph-backed trading is not enabled on this deployment" } }, 503);
    }
    const agentId = parseAgentId(c.req.param("id"));
    await sessionForAgent(c, dependencies.sessions, agentId);
    const profile = await dependencies.store.getAgentProfile(agentId);
    if (!profile) return response({ error: { code: "UNKNOWN_AGENT", message: "Agent not found" } }, 404);
    return response(await dependencies.graph.getVaultContext(profile));
  });

  app.post("/v1/agents/:id/quotes", async (c) => {
    if (dependencies.tradingEnabled === false) {
      return response({ error: { code: "TRADING_NOT_CONFIGURED", message: "Graph and an executable venue are required before quoting" } }, 503);
    }
    const agentId = parseAgentId(c.req.param("id"));
    const session = await sessionForAgent(c, dependencies.sessions, agentId);
    const raw = await body(c);
    const input = parsed(quoteSchema, raw);
    return runMutation(c, dependencies.store, `quote:${session.id}`, raw, async () => {
      const profile = await dependencies.store.getAgentProfile(agentId);
      if (!profile?.controller) throw new IntentValidationError("AGENT_VAULT_NOT_READY", "Agent vault is not bound", 409);
      const [context, controller] = await Promise.all([
        dependencies.graph.getVaultContext(profile),
        dependencies.chain.getController(profile.controller),
      ]);
      if (
        context.provenance.deploymentId !== input.contextDeploymentId
        || context.provenance.blockNumber !== input.contextBlockNumber
      ) throw new GraphDataError("GRAPH_CONTEXT_CHANGED", "Context cursor changed; recompute the proposal", 409);
      const quoteRequest = {
        agentId,
        tokenIn: input.tokenIn,
        tokenOut: input.tokenOut,
        amountIn: input.amountIn,
        maxSlippageBps: input.maxSlippageBps,
        evidenceHash: input.evidenceHash,
        reasoningHash: input.reasoningHash,
        summary: input.summary,
        provenance: context.provenance,
      };
      const plan = await dependencies.uniswap.createExecutionPlan(profile, controller, quoteRequest);
      const draft = buildIntentDraft(profile, controller, quoteRequest, plan);
      await dependencies.store.saveExecutionPlan(quoteRequest, plan);
      return { status: 201, body: { executionPlan: plan, ...draft, provenance: context.provenance } };
    });
  });

  app.post("/v1/intents", async (c) => {
    if (dependencies.tradingEnabled === false) {
      return response({ error: { code: "TRADING_NOT_CONFIGURED", message: "Intent relay is disabled on this deployment" } }, 503);
    }
    const session = await dependencies.sessions.authenticateBearer(c.req.header("authorization"));
    const raw = await body(c);
    const input = parsed(signedIntentSchema, raw);
    return runMutation(c, dependencies.store, `intent:${session.id}`, raw, async () => ({
      status: 202,
      body: { intent: await dependencies.intents.accept(session, input) },
    }));
  });

  app.get("/v1/intents/:id", async (c) => {
    const intent = await dependencies.store.getIntent(c.req.param("id"));
    if (!intent) return response({ error: { code: "UNKNOWN_INTENT", message: "Intent not found" } }, 404);
    let authorized = false;
    try {
      const session = await dependencies.sessions.authenticateBearer(c.req.header("authorization"));
      authorized = session.agentId.toLowerCase() === intent.agentId.toLowerCase();
    } catch {
      const sponsor = await dependencies.sponsors.authenticate(c.req.header("authorization"));
      authorized = sponsor.toLowerCase() === intent.sponsor.toLowerCase();
    }
    if (!authorized) return response({ error: { code: "FORBIDDEN", message: "Intent is private" } }, 403);
    return response({ intent });
  });

  app.get("/v1/agents/:id/events", async (c) => {
    const agentId = parseAgentId(c.req.param("id"));
    await sessionForAgent(c, dependencies.sessions, agentId);
    const initialCursor = c.req.query("cursor") ?? c.req.header("last-event-id") ?? null;
    return streamSSE(c, async (stream) => {
      let cursor = initialCursor;
      const endsAt = Date.now() + 25_000;
      while (Date.now() < endsAt && !stream.aborted) {
        const events = await dependencies.store.listEvents(agentId, cursor, 100);
        for (const event of events) {
          await stream.writeSSE({
            id: event.cursor,
            event: event.type,
            data: JSON.stringify(safe(event)),
          });
          cursor = event.cursor;
        }
        if (events.length === 0) await stream.writeSSE({ event: "keepalive", data: "{}" });
        await stream.sleep(1_000);
      }
    });
  });

  app.post("/v1/agents/:id/heartbeat", async (c) => {
    const agentId = parseAgentId(c.req.param("id"));
    const session = await sessionForAgent(c, dependencies.sessions, agentId);
    const raw = await body(c);
    const input = parsed(heartbeatSchema, raw);
    return runMutation(c, dependencies.store, `heartbeat:${session.id}`, raw, async () => {
      await dependencies.store.recordHeartbeat({ sessionId: session.id, agentId, ...input });
      return { status: 202, body: { accepted: true, observedAt: new Date().toISOString() } };
    });
  });

  app.post("/v1/agents/:id/decisions", async (c) => {
    if (dependencies.tradingEnabled === false) {
      return response({ error: { code: "TRADING_NOT_CONFIGURED", message: "Graph-backed decisions are not enabled on this deployment" } }, 503);
    }
    const agentId = parseAgentId(c.req.param("id"));
    const session = await sessionForAgent(c, dependencies.sessions, agentId);
    const raw = await body(c);
    const input = parsed(decisionSchema, raw);
    return runMutation(c, dependencies.store, `decision:${session.id}`, raw, async () => {
      const profile = await dependencies.store.getAgentProfile(agentId);
      if (!profile?.vault) throw new IntentValidationError("AGENT_VAULT_NOT_READY", "Agent vault is not bound", 409);
      const context = await dependencies.graph.getVaultContext(profile);
      if (
        context.provenance.deploymentId !== input.contextDeploymentId
        || context.provenance.blockNumber !== input.contextBlockNumber
      ) throw new GraphDataError("GRAPH_CONTEXT_CHANGED", "Context cursor changed; recompute the decision", 409);
      const id = await dependencies.store.recordDecision({
        agentId,
        vault: profile.vault,
        decision: input.decision,
        summary: input.summary,
        evidenceRefs: [{
          deploymentId: context.provenance.deploymentId,
          blockNumber: context.provenance.blockNumber.toString(),
          blockTimestamp: context.provenance.blockTimestamp.toISOString(),
        }, ...input.evidenceRefs],
        policyResult: input.decision === "rejected" ? "rejected" : "not_evaluated",
        chainId: dependencies.chain.chainId,
      });
      await dependencies.store.appendEvent({ type: "intent", agentId, occurredAt: new Date(), payload: { decisionId: id, decision: input.decision } });
      return { status: 201, body: { decision: { id, state: input.decision } } };
    });
  });

  app.post("/v1/managed-signers", async (c) => {
    const sponsor = await dependencies.sponsors.authenticate(c.req.header("authorization"));
    const raw = await body(c);
    const input = parsed(managedSignerSchema, raw);
    return runMutation(c, dependencies.store, `managed-signer:${sponsor}:${input.provisioningKey}`, raw, async () => {
      const managed = await dependencies.managedSigners.provision(sponsor, input.provisioningKey);
      return {
        status: 201,
        body: {
          managedSigner: {
            agentId: managed.agentId,
            signer: managed.signer,
            custody: "nuvem-managed",
            provider: managed.provider,
          },
        },
      };
    });
  });

  app.post("/v1/agent-vaults", async (c) => {
    const sponsor = await dependencies.sponsors.authenticate(c.req.header("authorization"));
    const raw = await body(c);
    const input = parsed(vaultJobSchema, raw);
    return runMutation(c, dependencies.store, `vault:${sponsor}`, raw, async () => {
      const existing = await dependencies.store.getVaultJobForAgent(input.agentId);
      if (existing) {
        if (existing.sponsor.toLowerCase() !== sponsor.toLowerCase()) {
          throw new SponsorAuthError("NOT_SPONSOR", "Agent deployment belongs to another sponsor", 403);
        }
        if (requestHash(existing.request) !== requestHash(safe(input))) {
          throw new IntentValidationError("VAULT_JOB_CONFLICT", "This agent already has a different live deployment request", 409);
        }
        return { status: 202, body: { job: { id: existing.id, state: existing.state }, resumed: true } };
      }
      if (input.runtimeKind === "nuvem_reference") {
        await dependencies.managedSigners.assertVaultBinding(input.agentId, sponsor, input.signer);
      }
      const profile: AgentProfile & { displayName: string; strategySummary: string; metadataUri: string } = {
        agentId: input.agentId,
        sponsor,
        signer: input.signer,
        vault: null,
        controller: null,
        policyHash: null,
        policy: input.policy as AgentPolicy,
        worldBacked: false,
        worldBackedUntil: null,
        runtimeKind: input.runtimeKind,
        status: "pending_backing",
        displayName: input.displayName,
        strategySummary: input.strategySummary,
        metadataUri: input.metadataUri,
      };
      await dependencies.store.upsertAgentProfile(profile);
      const job = await dependencies.store.createVaultJob({ agentId: input.agentId, sponsor, request: safe(input) as Record<string, unknown> });
      return { status: 202, body: { job, next: "Register the agent and sign the controller/Fund deployment transactions" } };
    });
  });

  app.get("/v1/agent-vaults/:id", async (c) => {
    const sponsor = await dependencies.sponsors.authenticate(c.req.header("authorization"));
    const job = await dependencies.store.getVaultJob(c.req.param("id"));
    if (!job) return response({ error: { code: "UNKNOWN_VAULT_JOB", message: "Vault deployment job not found" } }, 404);
    if (job.sponsor.toLowerCase() !== sponsor.toLowerCase()) {
      return response({ error: { code: "FORBIDDEN", message: "Vault deployment job belongs to another sponsor" } }, 403);
    }
    return response({ job: publicVaultJob(job) });
  });

  app.get("/v1/agents/:id/vault-job", async (c) => {
    const agentId = parseAgentId(c.req.param("id"));
    const sponsor = await dependencies.sponsors.authenticate(c.req.header("authorization"));
    const job = await dependencies.store.getVaultJobForAgent(agentId);
    if (!job) return response({ error: { code: "UNKNOWN_VAULT_JOB", message: "Agent has no active deployment job" } }, 404);
    if (job.sponsor.toLowerCase() !== sponsor.toLowerCase()) {
      return response({ error: { code: "FORBIDDEN", message: "Vault deployment job belongs to another sponsor" } }, 403);
    }
    return response({ job: publicVaultJob(job) });
  });

  app.post("/v1/agents/:id/world-backing", async (c) => {
    const agentId = parseAgentId(c.req.param("id"));
    const sponsor = await dependencies.sponsors.authenticate(c.req.header("authorization"));
    const raw = await body(c).catch(() => ({}));
    return runMutation(c, dependencies.store, `world-backing:${sponsor}:${agentId}`, raw, async () => ({
      status: 201,
      body: await dependencies.worldBacking.issue(agentId, sponsor),
    }));
  });

  app.post("/v1/agents/:id/world-id/request", async (c) => {
    const agentId = parseAgentId(c.req.param("id"));
    const sponsor = await dependencies.sponsors.authenticate(c.req.header("authorization"));
    const raw = await body(c).catch(() => ({}));
    return runMutation(c, dependencies.store, `world-id-request:${sponsor}:${agentId}`, raw, async () => ({
      status: 201,
      body: { worldId: await dependencies.worldId.request(agentId, sponsor) },
    }));
  });

  app.post("/v1/agents/:id/world-id/verify", async (c) => {
    const agentId = parseAgentId(c.req.param("id"));
    const sponsor = await dependencies.sponsors.authenticate(c.req.header("authorization"));
    const raw = await body(c);
    const input = parsed(worldIdVerifySchema, raw);
    return runMutation(c, dependencies.store, `world-id-verify:${sponsor}:${agentId}:${input.requestId}`, raw, async () => ({
      status: 200,
      body: { worldId: await dependencies.worldId.verify(agentId, sponsor, input.requestId, input.proof) },
    }));
  });

  app.get("/v1/agents/:id/world-registration", async (c) => {
    const agentId = parseAgentId(c.req.param("id"));
    const sponsor = await dependencies.sponsors.authenticate(c.req.header("authorization"));
    return response({ registration: await dependencies.worldRegistration.status(agentId, sponsor) });
  });

  app.post("/v1/agents/:id/world-registration", async (c) => {
    const agentId = parseAgentId(c.req.param("id"));
    const sponsor = await dependencies.sponsors.authenticate(c.req.header("authorization"));
    const raw = await body(c);
    const input = parsed(worldRegistrationSchema, raw);
    return runMutation(c, dependencies.store, `world-registration:${sponsor}:${agentId}:${input.nonce}`, raw, async () => ({
      status: 202,
      body: { registration: await dependencies.worldRegistration.submit(agentId, sponsor, input) },
    }));
  });

  app.post("/v1/agents/:id/sync", async (c) => {
    const agentId = parseAgentId(c.req.param("id"));
    const sponsor = await dependencies.sponsors.authenticate(c.req.header("authorization"));
    const raw = await body(c).catch(() => ({}));
    const input = parsed(syncSchema, raw);
    return runMutation(c, dependencies.store, `agent-sync:${sponsor}:${agentId}`, raw, async () => {
      const [profile, chainAgent] = await Promise.all([
        dependencies.store.getAgentProfile(agentId),
        dependencies.chain.getAgent(agentId),
      ]);
      if (!profile || profile.sponsor.toLowerCase() !== sponsor.toLowerCase() || chainAgent.sponsor.toLowerCase() !== sponsor.toLowerCase()) {
        throw new SponsorAuthError("NOT_SPONSOR", "Wallet is not this agent's sponsor", 403);
      }
      let controllerAddress = profile.controller;
      let vault = profile.vault;
      let policyHash = profile.policyHash;
      let controllerPaused = false;
      let deploymentState: string | null = null;
      if (input.controller) {
        const [controller, enabled] = await Promise.all([
          dependencies.chain.getController(input.controller),
          dependencies.chain.isControllerBound(agentId, input.controller),
        ]);
        if (
          controller.agentId.toLowerCase() !== agentId.toLowerCase()
          || controller.sponsor.toLowerCase() !== sponsor.toLowerCase()
          || !enabled
        ) throw new IntentValidationError("CONTROLLER_NOT_BOUND", "Controller is not authorized for this agent", 409);
        controllerAddress = input.controller;
        vault = controller.fund === "0x0000000000000000000000000000000000000000" ? null : controller.fund;
        policyHash = controller.policyHash;
        controllerPaused = controller.paused;
        if (vault) {
          const job = await dependencies.store.getVaultJobForAgent(agentId);
          if (job?.state === "awaiting_sponsor_bind") {
            const protection = await dependencies.chain.getFundProtection(vault);
            if (protection.stakeAvailable < parseRequiredStake6(job)) {
              throw new IntentValidationError("STAKE_INCOMPLETE", "Initial sponsor loss protection is not fully funded", 409);
            }
            await dependencies.store.markVaultJobReady(agentId, input.controller, vault, protection.stakeEscrow);
            deploymentState = "ready";
          } else {
            deploymentState = job?.state ?? null;
          }
        }
      }
      const status: AgentProfile["status"] = chainAgent.status === 3
        ? "retired"
        : chainAgent.status === 2 || controllerPaused
          ? "paused"
          : chainAgent.active
            ? "active"
            : "pending_backing";
      const synced: AgentProfile = {
        ...profile,
        signer: chainAgent.signer,
        controller: controllerAddress,
        vault,
        policyHash,
        worldBacked: chainAgent.active,
        worldBackedUntil: chainAgent.backedUntil > 0 ? new Date(chainAgent.backedUntil * 1_000) : null,
        status,
      };
      await dependencies.store.upsertAgentProfile(synced);
      await dependencies.store.appendEvent({ type: "agent", agentId, occurredAt: new Date(), payload: { action: "profile_synced", status, controller: controllerAddress, vault } });
      return { status: 200, body: { agent: synced, deploymentState } };
    });
  });

  app.post("/v1/agents/:id/pause", async (c) => {
    const agentId = parseAgentId(c.req.param("id"));
    const sponsor = await dependencies.sponsors.authenticate(c.req.header("authorization"));
    const raw = await body(c).catch(() => ({}));
    return runMutation(c, dependencies.store, `pause:${sponsor}:${agentId}`, raw, async () => {
      const profile = await dependencies.store.getAgentProfile(agentId);
      if (!profile || profile.sponsor.toLowerCase() !== sponsor.toLowerCase()) {
        throw new SponsorAuthError("NOT_SPONSOR", "Wallet is not this agent's sponsor", 403);
      }
      await dependencies.store.revokeAgentSessions(agentId);
      const transactions: Array<{ to: Address; data: Hex; value: "0"; description: string }> = [{
        to: dependencies.registryAddress,
        data: encodeFunctionData({
          abi: [{ type: "function", name: "pause", stateMutability: "nonpayable", inputs: [{ type: "bytes32", name: "agentId" }], outputs: [] }],
          functionName: "pause",
          args: [agentId],
        }),
        value: "0",
        description: "Invalidate World backing and stop all controller executions",
      }];
      if (profile.controller) transactions.push({
        to: profile.controller,
        data: encodeFunctionData({
          abi: [{ type: "function", name: "setPaused", stateMutability: "nonpayable", inputs: [{ type: "bool", name: "value" }], outputs: [] }],
          functionName: "setPaused",
          args: [true],
        }),
        value: "0",
        description: "Pause the vault controller explicitly",
      });
      await dependencies.store.appendEvent({ type: "agent", agentId, occurredAt: new Date(), payload: { action: "pause_requested" } });
      return { status: 200, body: { transactions, sessionsRevoked: true } };
    });
  });

  app.onError((error) => {
    const formatted = errorBody(error);
    return response(formatted.body, formatted.status);
  });
  app.notFound(() => response({ error: { code: "NOT_FOUND", message: "Endpoint not found" } }, 404));
  return app;
}

function openApiDocument(): Record<string, unknown> {
  return {
    openapi: "3.1.0",
    info: { title: "Nuvem Agents API", version: "1.0.0", description: "Model-neutral BYOA gateway. Agent sessions never authorize funds." },
    paths: {
      "/v1/agent-sessions/challenge": { post: { summary: "Create AgentKit challenge" } },
      "/v1/agent-sessions": { post: { summary: "Exchange AgentKit proof for a 15-minute session" } },
      "/v1/agents/{id}/context": { get: { summary: "Read fresh Graph-backed vault context" } },
      "/v1/agents/{id}/quotes": { post: { summary: "Create a bound CLASSIC Uniswap execution plan" } },
      "/v1/intents": { post: { summary: "Verify and queue a signed EIP-712 trade intent" } },
      "/v1/intents/{id}": { get: { summary: "Read private intent status" } },
      "/v1/agents/{id}/events": { get: { summary: "SSE event stream with resumable cursor" } },
      "/v1/agents/{id}/heartbeat": { post: { summary: "Record external agent heartbeat" } },
      "/v1/agents/{id}/decisions": { post: { summary: "Publish a sanitized hold or rejected decision" } },
      "/v1/managed-signers": { post: { summary: "Provision a sponsor-owned Nuvem reference signer without returning private key material" } },
      "/v1/agent-vaults": { post: { summary: "Create an AI vault deployment job (sponsor SIWE)" } },
      "/v1/agent-vaults/{id}": { get: { summary: "Read a sponsor-owned durable deployment job" } },
      "/v1/agents/{id}/vault-job": { get: { summary: "Resume the sponsor-owned deployment for an agent" } },
      "/v1/agents/{id}/world-backing": { post: { summary: "Issue a canonical AgentBook-backed activation attestation" } },
      "/v1/agents/{id}/world-id/request": { post: { summary: "Create a Nuvem World ID 4.0 sponsor proof request" } },
      "/v1/agents/{id}/world-id/verify": { post: { summary: "Verify and consume a Nuvem World ID 4.0 sponsor proof" } },
      "/v1/agents/{id}/world-registration": {
        get: { summary: "Read canonical AgentBook registration state without exposing the human id" },
        post: { summary: "Relay an official World ID AgentBook registration proof" },
      },
      "/v1/agents/{id}/sync": { post: { summary: "Sync verified AgentRegistry/controller state into the public profile" } },
      "/v1/agents/{id}/pause": { post: { summary: "Revoke sessions and return sponsor pause transactions" } },
    },
  };
}
