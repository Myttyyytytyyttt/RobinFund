import { randomUUID } from "node:crypto";
import type { Address, Hex } from "viem";
import type {
  AgentEvent,
  AgentDecisionInput,
  AgentProfile,
  AgentSession,
  ExecutionJob,
  ExecutionPlan,
  IdempotencyResult,
  IntentRecord,
  ManagedSignerRecord,
  QuoteRequest,
  WorldAttestationRecord,
  WorldIdAgentBinding,
  WorldIdRequestRecord,
  WorldIdVerificationInput,
  WorldIdVerificationResult,
  VaultDeploymentPlan,
  VaultJobRecord,
  VaultJobState,
} from "./domain.js";

export interface NewSession {
  agentId: Hex;
  signer: Address;
  sponsor: Address;
  tokenHash: Hex;
  proofHash: Hex;
  expiresAt: Date;
}

export interface NewVaultJob {
  agentId: Hex;
  sponsor: Address;
  request: Record<string, unknown>;
}

export interface ControlPlaneStore {
  getAgentProfile(agentId: Hex): Promise<AgentProfile | null>;
  upsertAgentProfile(profile: AgentProfile & { displayName?: string; strategySummary?: string; metadataUri?: string }): Promise<void>;
  upsertManagedSigner(input: ManagedSignerRecord): Promise<ManagedSignerRecord>;
  getManagedSigner(agentId: Hex): Promise<ManagedSignerRecord | null>;
  markManagedSignerBound(agentId: Hex, sponsor: Address, signer: Address): Promise<void>;
  createWorldIdRequest(input: WorldIdRequestRecord): Promise<void>;
  getWorldIdRequest(id: string): Promise<WorldIdRequestRecord | null>;
  getWorldIdAgentBinding(agentId: Hex): Promise<WorldIdAgentBinding | null>;
  bindExistingWorldIdSponsor(input: {
    agentId: Hex;
    sponsor: Address;
    signer: Address;
    maxManagedAgents: number;
  }): Promise<WorldIdVerificationResult>;
  recordWorldIdVerification(input: WorldIdVerificationInput): Promise<WorldIdVerificationResult>;

  createChallenge(input: {
    agentId: Hex;
    signer: Address;
    nonce: string;
    challengeHash: Hex;
    expiresAt: Date;
  }): Promise<void>;
  isChallengeActive(agentId: Hex, signer: Address, nonce: string): Promise<boolean>;
  consumeChallenge(agentId: Hex, signer: Address, nonce: string): Promise<boolean>;

  createSession(input: NewSession): Promise<AgentSession>;
  getSession(tokenHash: Hex): Promise<AgentSession | null>;
  touchSession(id: string): Promise<void>;
  revokeAgentSessions(agentId: Hex): Promise<void>;
  recordHeartbeat(input: {
    sessionId: string;
    agentId: Hex;
    runtimeVersion: string;
    capabilities: string[];
  }): Promise<void>;

  reserveIdempotency(scope: string, key: string, requestHash: Hex): Promise<IdempotencyResult>;
  completeIdempotency(scope: string, key: string, statusCode: number, body: unknown): Promise<void>;
  failIdempotency(scope: string, key: string, statusCode: number, body: unknown): Promise<void>;

  saveExecutionPlan(request: QuoteRequest, plan: ExecutionPlan): Promise<void>;
  getExecutionPlan(quoteId: string): Promise<{ request: QuoteRequest; plan: ExecutionPlan } | null>;
  saveIntent(intent: IntentRecord): Promise<void>;
  getIntent(id: string): Promise<IntentRecord | null>;
  enqueueIntent(intentId: string): Promise<ExecutionJob>;
  listEvents(agentId: Hex, cursor: string | null, limit: number): Promise<AgentEvent[]>;
  appendEvent(event: Omit<AgentEvent, "cursor">): Promise<AgentEvent>;
  recordDecision(input: AgentDecisionInput): Promise<string>;
  recordWorldAttestation(input: WorldAttestationRecord): Promise<void>;
  createVaultJob(input: NewVaultJob): Promise<{ id: string; state: string }>;
  getVaultJob(id: string): Promise<VaultJobRecord | null>;
  getVaultJobForAgent(agentId: Hex): Promise<VaultJobRecord | null>;
  claimVaultJobs(workerId: string, limit: number): Promise<VaultJobRecord[]>;
  reserveVaultNonceRange(jobId: string, chainId: number, deployer: Address, observedNonce: bigint): Promise<bigint>;
  releaseUnusedVaultNonceRange(jobId: string, chainId: number, deployer: Address): Promise<void>;
  persistVaultDeploymentPlan(jobId: string, workerId: string, plan: VaultDeploymentPlan): Promise<void>;
  updateVaultJobState(
    jobId: string,
    workerId: string,
    state: VaultJobState,
    options?: { stakeEscrow?: Address; errorCode?: string; retryAt?: Date; terminal?: boolean },
  ): Promise<void>;
  markVaultJobReady(agentId: Hex, controller: Address, fund: Address, stakeEscrow: Address): Promise<void>;

  claimExecutionJobs(workerId: string, limit: number): Promise<ExecutionJob[]>;
  getIntentForJob(job: ExecutionJob): Promise<IntentRecord | null>;
  persistSignedTransaction(jobId: string, tx: { hash: Hex; serialized: Hex; nonce: bigint }): Promise<void>;
  markJobSubmitted(jobId: string, hash: Hex): Promise<void>;
  markJobConfirmed(jobId: string, hash: Hex, blockNumber: bigint): Promise<void>;
  markJobFailed(jobId: string, code: string, retryAt: Date | null): Promise<void>;
  appendExecutionAttempt(input: {
    jobId: string;
    attempt: number;
    phase: "claimed" | "simulated" | "broadcast" | "receipt" | "reorg_check" | "failed";
    transactionHash?: Hex;
    receiptStatus?: "success" | "reverted" | "not_found";
    errorCode?: string;
  }): Promise<void>;
}

type Challenge = {
  agentId: Hex;
  signer: Address;
  nonce: string;
  expiresAt: Date;
  consumed: boolean;
};

type IdempotencyEntry = {
  requestHash: Hex;
  state: "processing" | "completed" | "failed";
  statusCode?: number;
  body?: unknown;
};

/** Deterministic in-memory implementation used by unit tests and the local demo. */
export class MemoryControlPlaneStore implements ControlPlaneStore {
  readonly profiles = new Map<string, AgentProfile>();
  readonly sessions = new Map<string, AgentSession>();
  readonly intents = new Map<string, IntentRecord>();
  readonly jobs = new Map<string, ExecutionJob>();
  readonly plans = new Map<string, { request: QuoteRequest; plan: ExecutionPlan }>();
  readonly vaultJobs = new Map<string, VaultJobRecord>();
  readonly attempts: Array<Record<string, unknown>> = [];
  readonly decisions: Array<AgentDecisionInput & { id: string }> = [];
  readonly worldAttestations: WorldAttestationRecord[] = [];
  readonly managedSigners = new Map<string, ManagedSignerRecord>();
  readonly worldIdRequests = new Map<string, WorldIdRequestRecord>();
  readonly worldIdSponsorBindings = new Map<string, { humanHash: Hex; nullifierHash: Hex }>();
  readonly worldIdAgentBindings = new Map<string, WorldIdAgentBinding>();

  private readonly challenges = new Map<string, Challenge>();
  private readonly idempotency = new Map<string, IdempotencyEntry>();
  private readonly events: AgentEvent[] = [];
  private readonly tokenToSession = new Map<string, string>();

  async getAgentProfile(agentId: Hex): Promise<AgentProfile | null> {
    return this.profiles.get(agentId.toLowerCase()) ?? null;
  }

  async upsertAgentProfile(profile: AgentProfile): Promise<void> {
    this.profiles.set(profile.agentId.toLowerCase(), structuredClone(profile));
  }

  async upsertManagedSigner(input: ManagedSignerRecord): Promise<ManagedSignerRecord> {
    const key = input.agentId.toLowerCase();
    const existing = this.managedSigners.get(key);
    if (existing && (
      existing.sponsor.toLowerCase() !== input.sponsor.toLowerCase()
      || existing.signer.toLowerCase() !== input.signer.toLowerCase()
      || existing.provisioningKey !== input.provisioningKey
    )) throw new Error("managed signer identity collision");
    const value = existing ?? structuredClone(input);
    this.managedSigners.set(key, value);
    return structuredClone(value);
  }

  async getManagedSigner(agentId: Hex): Promise<ManagedSignerRecord | null> {
    const value = this.managedSigners.get(agentId.toLowerCase());
    return value ? structuredClone(value) : null;
  }

  async markManagedSignerBound(agentId: Hex, sponsor: Address, signer: Address): Promise<void> {
    const value = this.managedSigners.get(agentId.toLowerCase());
    if (
      !value
      || value.sponsor.toLowerCase() !== sponsor.toLowerCase()
      || value.signer.toLowerCase() !== signer.toLowerCase()
    ) throw new Error("managed signer binding mismatch");
    value.status = "bound";
  }

  async createWorldIdRequest(input: WorldIdRequestRecord): Promise<void> {
    if (this.worldIdRequests.has(input.id)) throw new Error("World ID request collision");
    this.worldIdRequests.set(input.id, structuredClone(input));
  }

  async getWorldIdRequest(id: string): Promise<WorldIdRequestRecord | null> {
    const value = this.worldIdRequests.get(id);
    return value ? structuredClone(value) : null;
  }

  async getWorldIdAgentBinding(agentId: Hex): Promise<WorldIdAgentBinding | null> {
    const value = this.worldIdAgentBindings.get(agentId.toLowerCase());
    return value ? structuredClone(value) : null;
  }

  async bindExistingWorldIdSponsor(input: {
    agentId: Hex;
    sponsor: Address;
    signer: Address;
    maxManagedAgents: number;
  }): Promise<WorldIdVerificationResult> {
    const profile = this.profiles.get(input.agentId.toLowerCase());
    const sponsorBinding = this.worldIdSponsorBindings.get(input.sponsor.toLowerCase());
    if (!sponsorBinding) {
      return { accepted: false, reason: "sponsor_unverified", managedAgentCount: 0, maxManagedAgents: input.maxManagedAgents };
    }
    if (
      !profile
      || profile.sponsor.toLowerCase() !== input.sponsor.toLowerCase()
      || profile.signer.toLowerCase() !== input.signer.toLowerCase()
    ) return { accepted: false, reason: "request_invalid", managedAgentCount: 0, maxManagedAgents: input.maxManagedAgents };

    const existing = this.worldIdAgentBindings.get(input.agentId.toLowerCase());
    if (existing) {
      const matches = existing.sponsor.toLowerCase() === input.sponsor.toLowerCase()
        && existing.signer.toLowerCase() === input.signer.toLowerCase()
        && existing.humanHash === sponsorBinding.humanHash
        && !existing.revokedAt;
      return {
        accepted: matches,
        reason: matches ? "already_verified" : "request_invalid",
        managedAgentCount: 0,
        maxManagedAgents: input.maxManagedAgents,
      };
    }

    const managedPeers = [...this.worldIdAgentBindings.values()].filter((binding) => {
      const candidate = this.profiles.get(binding.agentId.toLowerCase());
      return binding.humanHash === sponsorBinding.humanHash
        && !binding.revokedAt
        && candidate?.runtimeKind === "nuvem_reference"
        && candidate.status !== "retired";
    }).length;
    const managed = profile.runtimeKind === "nuvem_reference";
    if (managed && managedPeers >= input.maxManagedAgents) {
      return {
        accepted: false,
        reason: "managed_agent_limit",
        managedAgentCount: managedPeers,
        maxManagedAgents: input.maxManagedAgents,
      };
    }
    this.worldIdAgentBindings.set(input.agentId.toLowerCase(), {
      agentId: input.agentId,
      sponsor: input.sponsor,
      signer: input.signer,
      humanHash: sponsorBinding.humanHash,
      verifiedAt: new Date(),
      revokedAt: null,
    });
    return {
      accepted: true,
      reason: "verified",
      managedAgentCount: managedPeers + (managed ? 1 : 0),
      maxManagedAgents: input.maxManagedAgents,
    };
  }

  async recordWorldIdVerification(input: WorldIdVerificationInput): Promise<WorldIdVerificationResult> {
    const request = this.worldIdRequests.get(input.requestId);
    if (
      !request
      || request.consumedAt
      || request.expiresAt <= new Date()
      || request.agentId.toLowerCase() !== input.agentId.toLowerCase()
      || request.sponsor.toLowerCase() !== input.sponsor.toLowerCase()
      || request.signer.toLowerCase() !== input.signer.toLowerCase()
      || request.rpNonceHash !== input.rpNonceHash
      || request.signalHash !== input.signalHash
      || request.action !== input.action
    ) return { accepted: false, reason: "request_invalid", managedAgentCount: 0, maxManagedAgents: input.maxManagedAgents };

    const sponsorKey = input.sponsor.toLowerCase();
    const existingSponsor = this.worldIdSponsorBindings.get(sponsorKey);
    const humanOwner = [...this.worldIdSponsorBindings.entries()]
      .find(([candidateSponsor, value]) => candidateSponsor !== sponsorKey && value.humanHash === input.humanHash);
    if (
      humanOwner
      || (existingSponsor && (
        existingSponsor.humanHash !== input.humanHash
        || existingSponsor.nullifierHash !== input.nullifierHash
      ))
    ) return { accepted: false, reason: "human_bound_elsewhere", managedAgentCount: 0, maxManagedAgents: input.maxManagedAgents };

    this.worldIdSponsorBindings.set(sponsorKey, {
      humanHash: input.humanHash,
      nullifierHash: input.nullifierHash,
    });
    request.consumedAt = new Date();
    return this.bindExistingWorldIdSponsor(input);
  }

  async createChallenge(input: {
    agentId: Hex;
    signer: Address;
    nonce: string;
    challengeHash: Hex;
    expiresAt: Date;
  }): Promise<void> {
    void input.challengeHash;
    this.challenges.set(input.nonce, { ...input, consumed: false });
  }

  async isChallengeActive(agentId: Hex, signer: Address, nonce: string): Promise<boolean> {
    const value = this.challenges.get(nonce);
    return Boolean(
      value && !value.consumed && value.expiresAt > new Date() && value.agentId === agentId
        && value.signer.toLowerCase() === signer.toLowerCase(),
    );
  }

  async consumeChallenge(agentId: Hex, signer: Address, nonce: string): Promise<boolean> {
    const value = this.challenges.get(nonce);
    if (
      !value || value.consumed || value.expiresAt <= new Date() || value.agentId !== agentId
      || value.signer.toLowerCase() !== signer.toLowerCase()
    ) return false;
    value.consumed = true;
    return true;
  }

  async createSession(input: NewSession): Promise<AgentSession> {
    const session: AgentSession = {
      id: randomUUID(),
      agentId: input.agentId,
      signer: input.signer,
      sponsor: input.sponsor,
      expiresAt: input.expiresAt,
      revokedAt: null,
    };
    this.sessions.set(session.id, session);
    this.tokenToSession.set(input.tokenHash, session.id);
    return session;
  }

  async getSession(tokenHash: Hex): Promise<AgentSession | null> {
    const id = this.tokenToSession.get(tokenHash);
    if (!id) return null;
    return this.sessions.get(id) ?? null;
  }

  async touchSession(_id: string): Promise<void> {}

  async revokeAgentSessions(agentId: Hex): Promise<void> {
    for (const session of this.sessions.values()) {
      if (session.agentId === agentId && !session.revokedAt) session.revokedAt = new Date();
    }
  }

  async recordHeartbeat(input: {
    sessionId: string;
    agentId: Hex;
    runtimeVersion: string;
    capabilities: string[];
  }): Promise<void> {
    const profile = this.profiles.get(input.agentId.toLowerCase());
    if (profile) profile.status = profile.status === "active" ? "active" : profile.status;
    await this.appendEvent({
      type: "heartbeat",
      agentId: input.agentId,
      occurredAt: new Date(),
      payload: { runtimeVersion: input.runtimeVersion, capabilities: input.capabilities },
    });
  }

  async reserveIdempotency(scope: string, key: string, requestHash: Hex): Promise<IdempotencyResult> {
    const mapKey = `${scope}:${key}`;
    const found = this.idempotency.get(mapKey);
    if (!found) {
      this.idempotency.set(mapKey, { requestHash, state: "processing" });
      return { kind: "acquired" };
    }
    if (found.requestHash !== requestHash) return { kind: "conflict" };
    if (found.state === "processing") return { kind: "processing" };
    return { kind: "replay", statusCode: found.statusCode, body: found.body };
  }

  async completeIdempotency(scope: string, key: string, statusCode: number, body: unknown): Promise<void> {
    const found = this.idempotency.get(`${scope}:${key}`);
    if (!found) throw new Error("idempotency reservation missing");
    Object.assign(found, { state: "completed", statusCode, body });
  }

  async failIdempotency(scope: string, key: string, statusCode: number, body: unknown): Promise<void> {
    const found = this.idempotency.get(`${scope}:${key}`);
    if (!found) throw new Error("idempotency reservation missing");
    Object.assign(found, { state: "failed", statusCode, body });
  }

  async saveExecutionPlan(request: QuoteRequest, plan: ExecutionPlan): Promise<void> {
    this.plans.set(plan.quoteId, { request, plan });
  }

  async getExecutionPlan(quoteId: string): Promise<{ request: QuoteRequest; plan: ExecutionPlan } | null> {
    return this.plans.get(quoteId) ?? null;
  }

  async saveIntent(intent: IntentRecord): Promise<void> {
    const duplicate = [...this.intents.values()].find((existing) =>
      existing.chainId === intent.chainId
      && existing.controller.toLowerCase() === intent.controller.toLowerCase()
      && existing.intent.nonce === intent.intent.nonce
    );
    if (duplicate) throw new Error("unique controller_address nonce constraint");
    this.intents.set(intent.id, structuredClone(intent));
    await this.appendEvent({
      type: "intent",
      agentId: intent.agentId,
      occurredAt: new Date(),
      payload: { intentId: intent.id, state: intent.state },
    });
  }

  async getIntent(id: string): Promise<IntentRecord | null> {
    return this.intents.get(id) ?? null;
  }

  async enqueueIntent(intentId: string): Promise<ExecutionJob> {
    const existing = [...this.jobs.values()].find((job) => job.intentId === intentId);
    if (existing) return existing;
    const job: ExecutionJob = {
      id: randomUUID(),
      intentId,
      state: "queued",
      attempts: 0,
      availableAt: new Date(),
      transactionHash: null,
      signedTransaction: null,
      chainNonce: null,
    };
    this.jobs.set(job.id, job);
    const intent = this.intents.get(intentId);
    if (intent) intent.state = "queued";
    return job;
  }

  async listEvents(agentId: Hex, cursor: string | null, limit: number): Promise<AgentEvent[]> {
    const after = cursor ? Number(cursor) : 0;
    return this.events.filter((event) => event.agentId === agentId && Number(event.cursor) > after).slice(0, limit);
  }

  async appendEvent(event: Omit<AgentEvent, "cursor">): Promise<AgentEvent> {
    const created = { ...event, cursor: String(this.events.length + 1) };
    this.events.push(created);
    return created;
  }

  async recordDecision(input: AgentDecisionInput): Promise<string> {
    const id = randomUUID();
    this.decisions.push({ ...structuredClone(input), id });
    return id;
  }

  async recordWorldAttestation(input: WorldAttestationRecord): Promise<void> {
    this.worldAttestations.push(structuredClone(input));
  }

  async createVaultJob(input: NewVaultJob): Promise<{ id: string; state: string }> {
    const value: VaultJobRecord = {
      id: randomUUID(),
      agentId: input.agentId,
      sponsor: input.sponsor,
      request: structuredClone(input.request),
      state: "requested",
      controller: null,
      fund: null,
      stakeEscrow: null,
      transactionHashes: [],
      deploymentPlan: null,
      nonceStart: null,
      attempts: 0,
      availableAt: new Date(),
      lockedBy: null,
      errorCode: null,
    };
    this.vaultJobs.set(value.id, value);
    return value;
  }

  async getVaultJob(id: string): Promise<VaultJobRecord | null> {
    return this.vaultJobs.get(id) ?? null;
  }

  async getVaultJobForAgent(agentId: Hex): Promise<VaultJobRecord | null> {
    return [...this.vaultJobs.values()].find((job) => job.agentId.toLowerCase() === agentId.toLowerCase() && job.state !== "failed") ?? null;
  }

  async claimVaultJobs(workerId: string, limit: number): Promise<VaultJobRecord[]> {
    const now = new Date();
    const jobs = [...this.vaultJobs.values()]
      .filter((job) => ["requested", "preparing", "deploying_controller", "deploying_fund", "registering"].includes(job.state))
      .filter((job) => job.availableAt <= now && job.attempts < 20 && !job.lockedBy)
      .filter((job) => {
        const profile = this.profiles.get(job.agentId.toLowerCase());
        return profile?.status === "active" && profile.worldBacked && Boolean(profile.worldBackedUntil && profile.worldBackedUntil > now);
      })
      .slice(0, limit);
    for (const job of jobs) {
      job.lockedBy = workerId;
      job.attempts++;
    }
    return jobs;
  }

  async reserveVaultNonceRange(jobId: string, _chainId: number, deployer: Address, observedNonce: bigint): Promise<bigint> {
    const job = this.requireVaultJob(jobId);
    if (job.nonceStart != null) return job.nonceStart;
    const highest = [...this.vaultJobs.values()].reduce((value, item) => {
      if (!item.deploymentPlan || item.deploymentPlan.deployer.toLowerCase() !== deployer.toLowerCase()) return value;
      return item.nonceStart == null ? value : (item.nonceStart + 3n > value ? item.nonceStart + 3n : value);
    }, observedNonce);
    job.nonceStart = highest;
    job.state = "preparing";
    return highest;
  }

  async releaseUnusedVaultNonceRange(jobId: string, _chainId: number, _deployer: Address): Promise<void> {
    const job = this.requireVaultJob(jobId);
    if (job.deploymentPlan) throw new Error("cannot release a persisted deployment plan nonce");
    job.nonceStart = null;
  }

  async persistVaultDeploymentPlan(jobId: string, workerId: string, plan: VaultDeploymentPlan): Promise<void> {
    const job = this.requireVaultJob(jobId);
    if (job.lockedBy !== workerId) throw new Error("vault job is not owned by worker");
    job.deploymentPlan = structuredClone(plan);
    job.controller = plan.controller;
    job.fund = plan.fund;
    job.transactionHashes = plan.transactions.map((tx) => tx.hash);
    job.state = "deploying_controller";
  }

  async updateVaultJobState(
    jobId: string,
    workerId: string,
    state: VaultJobState,
    options: { stakeEscrow?: Address; errorCode?: string; retryAt?: Date; terminal?: boolean } = {},
  ): Promise<void> {
    const job = this.requireVaultJob(jobId);
    if (job.lockedBy !== workerId) throw new Error("vault job is not owned by worker");
    job.state = options.terminal ? "failed" : state;
    job.errorCode = options.errorCode ?? null;
    job.stakeEscrow = options.stakeEscrow ?? job.stakeEscrow;
    job.availableAt = options.retryAt ?? new Date();
    job.lockedBy = null;
  }

  async markVaultJobReady(agentId: Hex, controller: Address, fund: Address, stakeEscrow: Address): Promise<void> {
    const job = await this.getVaultJobForAgent(agentId);
    if (!job || job.controller?.toLowerCase() !== controller.toLowerCase() || job.fund?.toLowerCase() !== fund.toLowerCase()) {
      throw new Error("vault job deployment does not match controller");
    }
    job.stakeEscrow = stakeEscrow;
    job.state = "ready";
    job.lockedBy = null;
  }

  async claimExecutionJobs(workerId: string, limit: number): Promise<ExecutionJob[]> {
    const now = new Date();
    const claimed = [...this.jobs.values()]
      .filter((job) => job.state === "queued" && job.availableAt <= now)
      .sort((a, b) => a.availableAt.getTime() - b.availableAt.getTime())
      .slice(0, limit);
    for (const job of claimed) {
      job.state = "processing";
      job.attempts++;
      this.attempts.push({ jobId: job.id, workerId, phase: "claimed", attempt: job.attempts });
    }
    return claimed;
  }

  async getIntentForJob(job: ExecutionJob): Promise<IntentRecord | null> {
    return this.intents.get(job.intentId) ?? null;
  }

  async persistSignedTransaction(jobId: string, tx: { hash: Hex; serialized: Hex; nonce: bigint }): Promise<void> {
    const job = this.requireJob(jobId);
    job.transactionHash = tx.hash;
    job.signedTransaction = tx.serialized;
    job.chainNonce = tx.nonce;
    job.state = "submitted";
  }

  async markJobSubmitted(jobId: string, hash: Hex): Promise<void> {
    const job = this.requireJob(jobId);
    job.transactionHash = hash;
    job.state = "submitted";
    const intent = this.intents.get(job.intentId);
    if (intent) {
      intent.state = "submitted";
      intent.transactionHash = hash;
      intent.updatedAt = new Date();
    }
  }

  async markJobConfirmed(jobId: string, hash: Hex, blockNumber: bigint): Promise<void> {
    const job = this.requireJob(jobId);
    job.state = "confirmed";
    job.transactionHash = hash;
    const intent = this.intents.get(job.intentId);
    if (intent) {
      intent.state = "confirmed";
      intent.transactionHash = hash;
      intent.blockNumber = blockNumber;
      intent.updatedAt = new Date();
    }
  }

  async markJobFailed(jobId: string, code: string, retryAt: Date | null): Promise<void> {
    const job = this.requireJob(jobId);
    job.state = retryAt && job.attempts < 20 ? "queued" : job.attempts >= 20 ? "dead_letter" : "failed";
    if (retryAt) job.availableAt = retryAt;
    const intent = this.intents.get(job.intentId);
    if (intent && !retryAt) {
      intent.state = "failed";
      intent.failureCode = code;
      intent.updatedAt = new Date();
    }
  }

  async appendExecutionAttempt(input: {
    jobId: string;
    attempt: number;
    phase: "claimed" | "simulated" | "broadcast" | "receipt" | "reorg_check" | "failed";
    transactionHash?: Hex;
    receiptStatus?: "success" | "reverted" | "not_found";
    errorCode?: string;
  }): Promise<void> {
    this.attempts.push(input);
  }

  private requireJob(jobId: string): ExecutionJob {
    const job = this.jobs.get(jobId);
    if (!job) throw new Error(`unknown job ${jobId}`);
    return job;
  }

  private requireVaultJob(jobId: string): VaultJobRecord {
    const job = this.vaultJobs.get(jobId);
    if (!job) throw new Error(`unknown vault job ${jobId}`);
    return job;
  }
}
