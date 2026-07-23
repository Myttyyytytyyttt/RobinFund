import postgres, { type Sql } from "postgres";
import type { Address, Hex } from "viem";
import { hexToBytes, stableJson } from "./crypto.js";
import type {
  AgentEvent,
  AgentDecisionInput,
  AgentPolicy,
  AgentProfile,
  AgentSession,
  ExecutionJob,
  ExecutionPlan,
  IdempotencyResult,
  IntentRecord,
  ManagedSignerRecord,
  QuoteRequest,
  TradeIntentV1,
  WorldAttestationRecord,
  WorldIdAgentBinding,
  WorldIdRequestRecord,
  WorldIdVerificationInput,
  WorldIdVerificationResult,
  VaultDeploymentPlan,
  VaultJobRecord,
  VaultJobState,
} from "./domain.js";
import type { ControlPlaneStore, NewSession, NewVaultJob } from "./store.js";

type Row = Record<string, unknown>;

function jsonValue(value: unknown): unknown {
  return JSON.parse(stableJson(value)) as unknown;
}

function date(value: unknown): Date {
  return value instanceof Date ? value : new Date(String(value));
}

function nullableDate(value: unknown): Date | null {
  return value == null ? null : date(value);
}

function hex(value: unknown): Hex {
  return String(value) as Hex;
}

function address(value: unknown): Address {
  return String(value).toLowerCase() as Address;
}

function numeric(value: unknown): bigint {
  return BigInt(String(value));
}

function bytesHex(value: unknown): Hex {
  if (value instanceof Uint8Array || Buffer.isBuffer(value)) {
    return `0x${Buffer.from(value).toString("hex")}`;
  }
  return hex(value);
}

function policy(value: unknown): AgentPolicy {
  const item = value as Record<string, unknown>;
  return {
    maxTradeBps: Number(item.maxTradeBps ?? 1_000),
    maxConcentrationBps: Number(item.maxConcentrationBps ?? 3_500),
    dailyTurnoverBps: Number(item.dailyTurnoverBps ?? 5_000),
    maxSlippageBps: Number(item.maxSlippageBps ?? 75),
    maxTradesPerDay: Number(item.maxTradesPerDay ?? 24),
    minTradeInterval: Number(item.minTradeInterval ?? 300),
    maxIntentLifetime: Number(item.maxIntentLifetime ?? 300),
    allowedAssets: Array.isArray(item.allowedAssets)
      ? item.allowedAssets.map((entry) => address(entry))
      : [],
  };
}

function mapProfile(row: Row): AgentProfile {
  return {
    agentId: hex(row.agent_id),
    sponsor: address(row.sponsor_wallet),
    signer: address(row.signer_address),
    vault: row.vault_address == null ? null : address(row.vault_address),
    controller: row.controller_address == null ? null : address(row.controller_address),
    policyHash: row.policy_hash == null ? null : hex(row.policy_hash),
    policy: policy(row.policy),
    worldBacked: Boolean(row.world_backed),
    worldBackedUntil: nullableDate(row.world_backed_until),
    runtimeKind: String(row.runtime_kind) as AgentProfile["runtimeKind"],
    status: String(row.status) as AgentProfile["status"],
  };
}

function mapManagedSigner(row: Row): ManagedSignerRecord {
  return {
    agentId: hex(row.agent_id),
    sponsor: address(row.sponsor_wallet),
    signer: address(row.signer_address),
    provisioningKey: String(row.provisioning_key),
    provider: String(row.provider) as ManagedSignerRecord["provider"],
    status: String(row.status) as ManagedSignerRecord["status"],
    createdAt: date(row.created_at),
  };
}

function mapWorldIdRequest(row: Row): WorldIdRequestRecord {
  return {
    id: String(row.id),
    agentId: hex(row.agent_id),
    sponsor: address(row.sponsor_wallet),
    signer: address(row.signer_address),
    rpNonceHash: hex(row.rp_nonce_hash),
    signalHash: hex(row.signal_hash),
    action: String(row.action),
    expiresAt: date(row.expires_at),
    consumedAt: nullableDate(row.consumed_at),
  };
}

function mapWorldIdAgentBinding(row: Row): WorldIdAgentBinding {
  return {
    agentId: hex(row.agent_id),
    sponsor: address(row.sponsor_wallet),
    signer: address(row.signer_address),
    humanHash: hex(row.human_hash),
    verifiedAt: date(row.verified_at),
    revokedAt: nullableDate(row.revoked_at),
  };
}

function mapSession(row: Row): AgentSession {
  return {
    id: String(row.id),
    agentId: hex(row.agent_id),
    signer: address(row.signer_address),
    sponsor: address(row.sponsor_wallet),
    expiresAt: date(row.expires_at),
    revokedAt: nullableDate(row.revoked_at),
  };
}

function mapJob(row: Row): ExecutionJob {
  return {
    id: String(row.id),
    intentId: String(row.intent_id),
    state: String(row.state) as ExecutionJob["state"],
    attempts: Number(row.attempts),
    availableAt: date(row.available_at),
    transactionHash: row.transaction_hash == null ? null : hex(row.transaction_hash),
    signedTransaction: row.signed_transaction == null ? null : hex(row.signed_transaction),
    chainNonce: row.chain_nonce == null ? null : numeric(row.chain_nonce),
  };
}

function mapVaultPlan(value: unknown): VaultDeploymentPlan | null {
  if (!value || typeof value !== "object") return null;
  const item = value as Record<string, unknown>;
  const transactions = Array.isArray(item.transactions) ? item.transactions : [];
  return {
    chainId: Number(item.chainId),
    deployer: address(item.deployer),
    controller: address(item.controller),
    fund: address(item.fund),
    transactions: transactions.map((entry) => {
      const tx = entry as Record<string, unknown>;
      return {
        step: String(tx.step) as VaultDeploymentPlan["transactions"][number]["step"],
        nonce: numeric(tx.nonce),
        hash: hex(tx.hash),
        serialized: hex(tx.serialized),
        contractAddress: tx.contractAddress == null ? null : address(tx.contractAddress),
      };
    }),
  };
}

function mapVaultJob(row: Row): VaultJobRecord {
  const hashes = Array.isArray(row.transaction_hashes) ? row.transaction_hashes : [];
  return {
    id: String(row.id),
    agentId: hex(row.agent_id),
    sponsor: address(row.sponsor_wallet),
    request: (row.request ?? {}) as Record<string, unknown>,
    state: String(row.state) as VaultJobState,
    controller: row.controller_address == null ? null : address(row.controller_address),
    fund: row.fund_address == null ? null : address(row.fund_address),
    stakeEscrow: row.stake_escrow_address == null ? null : address(row.stake_escrow_address),
    transactionHashes: hashes.map((entry) => hex(entry)),
    deploymentPlan: mapVaultPlan(row.deployment_plan),
    nonceStart: row.nonce_start == null ? null : numeric(row.nonce_start),
    attempts: Number(row.attempts ?? 0),
    availableAt: date(row.available_at ?? row.created_at),
    lockedBy: row.locked_by == null ? null : String(row.locked_by),
    errorCode: row.error_code == null ? null : String(row.error_code),
  };
}

function mapTradeIntent(typedData: unknown): TradeIntentV1 {
  const root = typedData as Record<string, unknown>;
  const message = root.message as Record<string, unknown>;
  if (!message) throw new Error("stored typed data has no message");
  return {
    agentId: hex(message.agentId),
    fund: address(message.fund),
    tokenIn: address(message.tokenIn),
    tokenOut: address(message.tokenOut),
    amountIn: numeric(message.amountIn),
    minAmountOut: numeric(message.minAmountOut),
    maxSlippageBps: Number(message.maxSlippageBps),
    policyHash: hex(message.policyHash),
    executionHash: hex(message.executionHash),
    evidenceHash: hex(message.evidenceHash),
    nonce: numeric(message.nonce),
    validAfter: Number(message.validAfter),
    deadline: Number(message.deadline),
  };
}

function mapIntent(row: Row): IntentRecord {
  const typedData = row.typed_data as Record<string, unknown>;
  return {
    id: String(row.id),
    proposalId: String(row.proposal_id),
    quoteId: String(row.quote_id),
    agentId: hex(row.agent_id),
    sponsor: address(row.sponsor_wallet),
    controller: address(row.controller_address),
    fund: address(row.fund_address),
    chainId: Number(row.chain_id),
    intent: mapTradeIntent(typedData),
    typedData,
    adapterData: hex(row.adapter_data),
    signature: hex(row.signature),
    state: String(row.state) as IntentRecord["state"],
    transactionHash: row.transaction_hash == null ? null : hex(row.transaction_hash),
    blockNumber: row.block_number == null ? null : numeric(row.block_number),
    failureCode: row.failure_code == null ? null : String(row.failure_code),
    expiresAt: date(row.expires_at),
    createdAt: date(row.created_at),
    updatedAt: date(row.updated_at),
  };
}

export class PostgresControlPlaneStore implements ControlPlaneStore {
  constructor(readonly sql: Sql) {}

  static connect(connectionString: string): PostgresControlPlaneStore {
    return new PostgresControlPlaneStore(postgres(connectionString, {
      max: process.env.VERCEL === "1" ? 1 : 10,
      idle_timeout: 20,
      connect_timeout: 10,
      prepare: false,
    }));
  }

  async close(): Promise<void> {
    await this.sql.end({ timeout: 5 });
  }

  async getAgentProfile(agentId: Hex): Promise<AgentProfile | null> {
    const rows = await this.sql`select * from public.agent_profiles where agent_id = ${agentId.toLowerCase()} limit 1`;
    return rows[0] ? mapProfile(rows[0] as Row) : null;
  }

  async upsertAgentProfile(
    profile: AgentProfile & { displayName?: string; strategySummary?: string; metadataUri?: string },
  ): Promise<void> {
    const displayName = profile.displayName ?? `Agent ${profile.agentId.slice(2, 8)}`;
    const strategySummary = profile.strategySummary ?? "";
    await this.sql`
      insert into public.agent_profiles (
        agent_id, sponsor_wallet, signer_address, vault_address, controller_address,
        display_name, strategy_summary, metadata_uri, policy, policy_hash, world_backed,
        world_backed_until, runtime_kind, status
      ) values (
        ${profile.agentId.toLowerCase()}, ${profile.sponsor.toLowerCase()}, ${profile.signer.toLowerCase()},
        ${profile.vault?.toLowerCase() ?? null}, ${profile.controller?.toLowerCase() ?? null},
        ${displayName}, ${strategySummary}, ${profile.metadataUri ?? ""}, ${this.sql.json(jsonValue(profile.policy) as never)},
        ${profile.policyHash?.toLowerCase() ?? null}, ${profile.worldBacked}, ${profile.worldBackedUntil},
        ${profile.runtimeKind}, ${profile.status}
      )
      on conflict (agent_id) do update set
        sponsor_wallet = excluded.sponsor_wallet,
        signer_address = excluded.signer_address,
        vault_address = excluded.vault_address,
        controller_address = excluded.controller_address,
        metadata_uri = excluded.metadata_uri,
        policy = excluded.policy,
        policy_hash = excluded.policy_hash,
        world_backed = excluded.world_backed,
        world_backed_until = excluded.world_backed_until,
        runtime_kind = excluded.runtime_kind,
        status = excluded.status
    `;
  }

  async upsertManagedSigner(input: ManagedSignerRecord): Promise<ManagedSignerRecord> {
    const rows = await this.sql`
      insert into agent_private.managed_signers (
        agent_id, sponsor_wallet, signer_address, provisioning_key, provider, status, created_at
      ) values (
        ${input.agentId.toLowerCase()}, ${input.sponsor.toLowerCase()}, ${input.signer.toLowerCase()},
        ${input.provisioningKey}::uuid, ${input.provider}, ${input.status}, ${input.createdAt}
      )
      on conflict (sponsor_wallet, provisioning_key) do update set
        updated_at = now()
      where agent_private.managed_signers.agent_id = excluded.agent_id
        and agent_private.managed_signers.signer_address = excluded.signer_address
        and agent_private.managed_signers.provider = excluded.provider
      returning *
    `;
    if (!rows[0]) throw new Error("managed signer provisioning identity collision");
    return mapManagedSigner(rows[0] as Row);
  }

  async getManagedSigner(agentId: Hex): Promise<ManagedSignerRecord | null> {
    const rows = await this.sql`
      select * from agent_private.managed_signers
      where agent_id = ${agentId.toLowerCase()} limit 1
    `;
    return rows[0] ? mapManagedSigner(rows[0] as Row) : null;
  }

  async markManagedSignerBound(agentId: Hex, sponsor: Address, signer: Address): Promise<void> {
    const rows = await this.sql`
      update agent_private.managed_signers set status = 'bound', updated_at = now()
      where agent_id = ${agentId.toLowerCase()}
        and sponsor_wallet = ${sponsor.toLowerCase()}
        and signer_address = ${signer.toLowerCase()}
        and status <> 'retired'
      returning agent_id
    `;
    if (!rows[0]) throw new Error("managed signer binding mismatch");
  }

  async createWorldIdRequest(input: WorldIdRequestRecord): Promise<void> {
    await this.sql`
      insert into agent_private.world_id_requests (
        id, agent_id, sponsor_wallet, signer_address, rp_nonce_hash, signal_hash,
        action, expires_at, consumed_at
      ) values (
        ${input.id}::uuid, ${input.agentId.toLowerCase()}, ${input.sponsor.toLowerCase()},
        ${input.signer.toLowerCase()}, ${input.rpNonceHash.toLowerCase()},
        ${input.signalHash.toLowerCase()}, ${input.action}, ${input.expiresAt}, ${input.consumedAt}
      )
    `;
  }

  async getWorldIdRequest(id: string): Promise<WorldIdRequestRecord | null> {
    const rows = await this.sql`
      select * from agent_private.world_id_requests where id = ${id}::uuid limit 1
    `;
    return rows[0] ? mapWorldIdRequest(rows[0] as Row) : null;
  }

  async getWorldIdAgentBinding(agentId: Hex): Promise<WorldIdAgentBinding | null> {
    const rows = await this.sql`
      select * from agent_private.world_id_agent_bindings
      where agent_id = ${agentId.toLowerCase()} and revoked_at is null limit 1
    `;
    return rows[0] ? mapWorldIdAgentBinding(rows[0] as Row) : null;
  }

  async bindExistingWorldIdSponsor(input: {
    agentId: Hex;
    sponsor: Address;
    signer: Address;
    maxManagedAgents: number;
  }): Promise<WorldIdVerificationResult> {
    return this.sql.begin(async (tx) => {
      const sponsorRows = await tx`
        select human_hash from agent_private.world_id_sponsors
        where sponsor_wallet = ${input.sponsor.toLowerCase()} and revoked_at is null limit 1
      `;
      const humanHash = String(sponsorRows[0]?.human_hash ?? "").toLowerCase();
      if (!/^0x[0-9a-f]{64}$/.test(humanHash)) {
        return { accepted: false, reason: "sponsor_unverified", managedAgentCount: 0, maxManagedAgents: input.maxManagedAgents };
      }
      await tx`select pg_advisory_xact_lock(hashtextextended(${humanHash}, 1))`;
      const profileRows = await tx`
        select runtime_kind, status, sponsor_wallet, signer_address from public.agent_profiles
        where agent_id = ${input.agentId.toLowerCase()} limit 1
      `;
      const profile = profileRows[0] as Row | undefined;
      if (
        !profile
        || String(profile.sponsor_wallet).toLowerCase() !== input.sponsor.toLowerCase()
        || String(profile.signer_address).toLowerCase() !== input.signer.toLowerCase()
      ) return { accepted: false, reason: "request_invalid", managedAgentCount: 0, maxManagedAgents: input.maxManagedAgents };

      const existingRows = await tx`
        select * from agent_private.world_id_agent_bindings
        where agent_id = ${input.agentId.toLowerCase()} limit 1
      `;
      const existing = existingRows[0] as Row | undefined;
      if (existing) {
        const matches = existing.revoked_at == null
          && String(existing.sponsor_wallet).toLowerCase() === input.sponsor.toLowerCase()
          && String(existing.signer_address).toLowerCase() === input.signer.toLowerCase()
          && String(existing.human_hash).toLowerCase() === humanHash;
        return {
          accepted: matches,
          reason: matches ? "already_verified" : "request_invalid",
          managedAgentCount: 0,
          maxManagedAgents: input.maxManagedAgents,
        };
      }

      const peerRows = await tx`
        select count(*)::integer as count
        from agent_private.world_id_agent_bindings as binding
        join public.agent_profiles as candidate on candidate.agent_id = binding.agent_id
        where binding.human_hash = ${humanHash}
          and binding.revoked_at is null
          and candidate.runtime_kind = 'nuvem_reference'
          and candidate.status <> 'retired'
      `;
      const peers = Number(peerRows[0]?.count ?? 0);
      const managed = String(profile.runtime_kind) === "nuvem_reference";
      if (managed && peers >= input.maxManagedAgents) {
        return {
          accepted: false,
          reason: "managed_agent_limit",
          managedAgentCount: peers,
          maxManagedAgents: input.maxManagedAgents,
        };
      }
      await tx`
        insert into agent_private.world_id_agent_bindings (
          agent_id, sponsor_wallet, signer_address, human_hash, verified_at
        ) values (
          ${input.agentId.toLowerCase()}, ${input.sponsor.toLowerCase()},
          ${input.signer.toLowerCase()}, ${humanHash}, now()
        )
      `;
      return {
        accepted: true,
        reason: "verified",
        managedAgentCount: peers + (managed ? 1 : 0),
        maxManagedAgents: input.maxManagedAgents,
      };
    });
  }

  async recordWorldIdVerification(input: WorldIdVerificationInput): Promise<WorldIdVerificationResult> {
    return this.sql.begin(async (tx) => {
      const requestRows = await tx`
        select * from agent_private.world_id_requests
        where id = ${input.requestId}::uuid for update
      `;
      const request = requestRows[0] as Row | undefined;
      if (
        !request
        || request.consumed_at != null
        || date(request.expires_at) <= new Date()
        || String(request.agent_id).toLowerCase() !== input.agentId.toLowerCase()
        || String(request.sponsor_wallet).toLowerCase() !== input.sponsor.toLowerCase()
        || String(request.signer_address).toLowerCase() !== input.signer.toLowerCase()
        || String(request.rp_nonce_hash).toLowerCase() !== input.rpNonceHash.toLowerCase()
        || String(request.signal_hash).toLowerCase() !== input.signalHash.toLowerCase()
        || String(request.action) !== input.action
      ) return { accepted: false, reason: "request_invalid", managedAgentCount: 0, maxManagedAgents: input.maxManagedAgents };

      await tx`select pg_advisory_xact_lock(hashtextextended(${input.humanHash.toLowerCase()}, 1))`;
      const profileRows = await tx`
        select runtime_kind, status, sponsor_wallet, signer_address from public.agent_profiles
        where agent_id = ${input.agentId.toLowerCase()} limit 1
      `;
      const profile = profileRows[0] as Row | undefined;
      if (
        !profile
        || String(profile.sponsor_wallet).toLowerCase() !== input.sponsor.toLowerCase()
        || String(profile.signer_address).toLowerCase() !== input.signer.toLowerCase()
      ) return { accepted: false, reason: "request_invalid", managedAgentCount: 0, maxManagedAgents: input.maxManagedAgents };

      const sponsorRows = await tx`
        select * from agent_private.world_id_sponsors
        where sponsor_wallet = ${input.sponsor.toLowerCase()} for update
      `;
      const sponsorBinding = sponsorRows[0] as Row | undefined;
      const ownerRows = await tx`
        select sponsor_wallet from agent_private.world_id_sponsors
        where human_hash = ${input.humanHash.toLowerCase()}
          and sponsor_wallet <> ${input.sponsor.toLowerCase()}
          and revoked_at is null limit 1
      `;
      if (
        ownerRows[0]
        || (sponsorBinding && (
          String(sponsorBinding.human_hash).toLowerCase() !== input.humanHash.toLowerCase()
          || String(sponsorBinding.nullifier_hash).toLowerCase() !== input.nullifierHash.toLowerCase()
        ))
      ) return { accepted: false, reason: "human_bound_elsewhere", managedAgentCount: 0, maxManagedAgents: input.maxManagedAgents };

      await tx`
        insert into agent_private.world_id_sponsors (
          sponsor_wallet, human_hash, nullifier_hash, action, first_verified_at, last_verified_at
        ) values (
          ${input.sponsor.toLowerCase()}, ${input.humanHash.toLowerCase()},
          ${input.nullifierHash.toLowerCase()}, ${input.action}, now(), now()
        ) on conflict (sponsor_wallet) do update set
          last_verified_at = now(), revoked_at = null
      `;
      await tx`
        update agent_private.world_id_requests
        set consumed_at = now(), proof_hash = ${input.proofHash.toLowerCase()}
        where id = ${input.requestId}::uuid
      `;

      const existingRows = await tx`
        select * from agent_private.world_id_agent_bindings
        where agent_id = ${input.agentId.toLowerCase()} limit 1
      `;
      const existing = existingRows[0] as Row | undefined;
      if (existing) {
        const matches = existing.revoked_at == null
          && String(existing.sponsor_wallet).toLowerCase() === input.sponsor.toLowerCase()
          && String(existing.signer_address).toLowerCase() === input.signer.toLowerCase()
          && String(existing.human_hash).toLowerCase() === input.humanHash.toLowerCase();
        return {
          accepted: matches,
          reason: matches ? "already_verified" : "request_invalid",
          managedAgentCount: 0,
          maxManagedAgents: input.maxManagedAgents,
        };
      }

      const peerRows = await tx`
        select count(*)::integer as count
        from agent_private.world_id_agent_bindings as binding
        join public.agent_profiles as candidate on candidate.agent_id = binding.agent_id
        where binding.human_hash = ${input.humanHash.toLowerCase()}
          and binding.revoked_at is null
          and candidate.runtime_kind = 'nuvem_reference'
          and candidate.status <> 'retired'
      `;
      const peers = Number(peerRows[0]?.count ?? 0);
      const managed = String(profile.runtime_kind) === "nuvem_reference";
      if (managed && peers >= input.maxManagedAgents) {
        return {
          accepted: false,
          reason: "managed_agent_limit",
          managedAgentCount: peers,
          maxManagedAgents: input.maxManagedAgents,
        };
      }
      await tx`
        insert into agent_private.world_id_agent_bindings (
          agent_id, sponsor_wallet, signer_address, human_hash, source_request_id, verified_at
        ) values (
          ${input.agentId.toLowerCase()}, ${input.sponsor.toLowerCase()},
          ${input.signer.toLowerCase()}, ${input.humanHash.toLowerCase()},
          ${input.requestId}::uuid, now()
        )
      `;
      return {
        accepted: true,
        reason: "verified",
        managedAgentCount: peers + (managed ? 1 : 0),
        maxManagedAgents: input.maxManagedAgents,
      };
    });
  }

  async createChallenge(input: {
    agentId: Hex;
    signer: Address;
    nonce: string;
    challengeHash: Hex;
    expiresAt: Date;
  }): Promise<void> {
    await this.sql`
      insert into agent_private.session_challenges (
        agent_id, signer_address, challenge_hash, agentkit_nonce, expires_at
      ) values (
        ${input.agentId.toLowerCase()}, ${input.signer.toLowerCase()},
        ${hexToBytes(input.challengeHash)}, ${input.nonce}, ${input.expiresAt}
      )
    `;
  }

  async isChallengeActive(agentId: Hex, signer: Address, nonce: string): Promise<boolean> {
    const rows = await this.sql`
      select 1 from agent_private.session_challenges
      where agent_id = ${agentId.toLowerCase()}
        and signer_address = ${signer.toLowerCase()}
        and agentkit_nonce = ${nonce}
        and consumed_at is null and expires_at > now()
      limit 1
    `;
    return rows.length === 1;
  }

  async consumeChallenge(agentId: Hex, signer: Address, nonce: string): Promise<boolean> {
    const rows = await this.sql`
      update agent_private.session_challenges
      set consumed_at = now()
      where agent_id = ${agentId.toLowerCase()}
        and signer_address = ${signer.toLowerCase()}
        and agentkit_nonce = ${nonce}
        and consumed_at is null and expires_at > now()
      returning id
    `;
    return rows.length === 1;
  }

  async createSession(input: NewSession): Promise<AgentSession> {
    const rows = await this.sql`
      insert into agent_private.agent_sessions (
        agent_id, signer_address, sponsor_wallet, token_hash, agentkit_proof_hash, expires_at
      ) values (
        ${input.agentId.toLowerCase()}, ${input.signer.toLowerCase()}, ${input.sponsor.toLowerCase()},
        ${hexToBytes(input.tokenHash)}, ${input.proofHash.toLowerCase()}, ${input.expiresAt}
      ) returning *
    `;
    return mapSession(rows[0] as Row);
  }

  async getSession(tokenHash: Hex): Promise<AgentSession | null> {
    const rows = await this.sql`
      select * from agent_private.agent_sessions
      where token_hash = ${hexToBytes(tokenHash)} and revoked_at is null and expires_at > now()
      limit 1
    `;
    return rows[0] ? mapSession(rows[0] as Row) : null;
  }

  async touchSession(id: string): Promise<void> {
    await this.sql`update agent_private.agent_sessions set last_seen_at = now() where id = ${id}`;
  }

  async revokeAgentSessions(agentId: Hex): Promise<void> {
    await this.sql`
      update agent_private.agent_sessions set revoked_at = coalesce(revoked_at, now())
      where agent_id = ${agentId.toLowerCase()} and revoked_at is null
    `;
  }

  async recordHeartbeat(input: {
    sessionId: string;
    agentId: Hex;
    runtimeVersion: string;
    capabilities: string[];
  }): Promise<void> {
    await this.sql.begin(async (tx) => {
      await tx`
        insert into agent_private.heartbeats (agent_id, session_id, runtime_version, capabilities)
        values (${input.agentId.toLowerCase()}, ${input.sessionId}, ${input.runtimeVersion},
          ${tx.json(input.capabilities as never)})
      `;
      await tx`
        update public.agent_profiles set last_heartbeat_at = now()
        where agent_id = ${input.agentId.toLowerCase()}
      `;
      await tx`
        insert into agent_private.agent_events (agent_id, event_type, payload)
        values (${input.agentId.toLowerCase()}, 'heartbeat',
          ${tx.json({ runtimeVersion: input.runtimeVersion, capabilities: input.capabilities } as never)})
      `;
    });
  }

  async reserveIdempotency(scope: string, key: string, requestHash: Hex): Promise<IdempotencyResult> {
    return this.sql.begin(async (tx) => {
      const inserted = await tx`
        insert into agent_private.idempotency_keys (scope, idempotency_key, request_hash)
        values (${scope}, ${key}, ${hexToBytes(requestHash)})
        on conflict do nothing returning state
      `;
      if (inserted.length === 1) return { kind: "acquired" };

      const rows = await tx`
        select request_hash, state, status_code, response_body
        from agent_private.idempotency_keys
        where scope = ${scope} and idempotency_key = ${key}
        for update
      `;
      const row = rows[0] as Row | undefined;
      if (!row) throw new Error("idempotency row disappeared");
      if (bytesHex(row.request_hash).toLowerCase() !== requestHash.toLowerCase()) return { kind: "conflict" };
      if (row.state === "processing") return { kind: "processing" };
      return { kind: "replay", statusCode: Number(row.status_code), body: row.response_body };
    });
  }

  async completeIdempotency(scope: string, key: string, statusCode: number, body: unknown): Promise<void> {
    await this.finishIdempotency(scope, key, "completed", statusCode, body);
  }

  async failIdempotency(scope: string, key: string, statusCode: number, body: unknown): Promise<void> {
    await this.finishIdempotency(scope, key, "failed", statusCode, body);
  }

  private async finishIdempotency(
    scope: string,
    key: string,
    state: "completed" | "failed",
    statusCode: number,
    body: unknown,
  ): Promise<void> {
    const rows = await this.sql`
      update agent_private.idempotency_keys
      set state = ${state}, status_code = ${statusCode}, response_body = ${this.sql.json(jsonValue(body) as never)}
      where scope = ${scope} and idempotency_key = ${key} and state = 'processing'
      returning scope
    `;
    if (rows.length !== 1) throw new Error("idempotency reservation missing or already completed");
  }

  async saveExecutionPlan(request: QuoteRequest, plan: ExecutionPlan): Promise<void> {
    const proposal = {
      tokenIn: request.tokenIn,
      tokenOut: request.tokenOut,
      amountIn: request.amountIn,
      maxSlippageBps: request.maxSlippageBps,
      summary: request.summary,
    };
    await this.sql.begin(async (tx) => {
      await tx`
        insert into agent_private.proposals (
          id, agent_id, vault_address, proposal, evidence_hash, reasoning_hash,
          graph_deployment_id, graph_block_number, graph_block_timestamp
          , graph_chain_head_block, graph_observed_at
        ) values (
          ${plan.proposalId}, ${request.agentId.toLowerCase()}, ${plan.fund.toLowerCase()},
          ${tx.json(jsonValue(proposal) as never)}, ${request.evidenceHash.toLowerCase()},
          ${request.reasoningHash.toLowerCase()}, ${request.provenance.deploymentId},
          ${request.provenance.blockNumber.toString()}, ${request.provenance.blockTimestamp},
          ${request.provenance.chainHeadBlock.toString()}, ${request.provenance.observedAt}
        )
      `;
      await tx`
        insert into agent_private.quotes (
          id, proposal_id, route_type, chain_id, token_in, token_out, amount_in,
          quoted_amount_out, min_amount_out, approval_proxy, adapter_address, adapter_id,
          fund_address, controller_address, route_calldata, adapter_data, quote_hash, execution_hash, expires_at
        ) values (
          ${plan.quoteId}, ${plan.proposalId}, 'CLASSIC', ${plan.chainId},
          ${plan.tokenIn.toLowerCase()}, ${plan.tokenOut.toLowerCase()}, ${plan.amountIn.toString()},
          ${plan.quotedAmountOut.toString()}, ${plan.minAmountOut.toString()},
          ${plan.approvalProxy.toLowerCase()}, ${plan.adapter.toLowerCase()}, ${plan.adapterId.toString()},
          ${plan.fund.toLowerCase()}, ${plan.controller.toLowerCase()}, ${plan.routeCalldata},
          ${plan.adapterData}, ${plan.quoteHash.toLowerCase()}, ${plan.executionHash.toLowerCase()}, ${plan.expiresAt}
        )
      `;
    });
  }

  async getExecutionPlan(quoteId: string): Promise<{ request: QuoteRequest; plan: ExecutionPlan } | null> {
    const rows = await this.sql`
      select
        proposal.agent_id, proposal.proposal, proposal.evidence_hash, proposal.reasoning_hash,
        proposal.graph_deployment_id, proposal.graph_block_number, proposal.graph_block_timestamp,
        proposal.graph_chain_head_block, proposal.graph_observed_at,
        quote.id as quote_id, quote.proposal_id, quote.quote_hash, quote.adapter_address,
        quote.approval_proxy, quote.adapter_id, quote.fund_address, quote.controller_address,
        quote.chain_id, quote.token_in, quote.token_out, quote.amount_in, quote.execution_hash,
        quote.quoted_amount_out, quote.min_amount_out, quote.route_calldata,
        quote.adapter_data, quote.expires_at
      from agent_private.quotes as quote
      join agent_private.proposals as proposal on proposal.id = quote.proposal_id
      where quote.id = ${quoteId}
      limit 1
    `;
    const row = rows[0] as Row | undefined;
    if (!row) return null;
    const storedProposal = row.proposal as Record<string, unknown>;
    const request: QuoteRequest = {
      agentId: hex(row.agent_id),
      tokenIn: address(row.token_in),
      tokenOut: address(row.token_out),
      amountIn: numeric(row.amount_in),
      maxSlippageBps: Number(storedProposal.maxSlippageBps),
      evidenceHash: hex(row.evidence_hash),
      reasoningHash: hex(row.reasoning_hash),
      summary: String(storedProposal.summary),
      provenance: {
        deploymentId: String(row.graph_deployment_id),
        blockNumber: numeric(row.graph_block_number),
        blockTimestamp: date(row.graph_block_timestamp),
        chainHeadBlock: numeric(row.graph_chain_head_block),
        observedAt: date(row.graph_observed_at),
      },
    };
    const plan: ExecutionPlan = {
      proposalId: String(row.proposal_id),
      quoteId: String(row.quote_id),
      quoteHash: hex(row.quote_hash),
      adapter: address(row.adapter_address),
      approvalProxy: address(row.approval_proxy),
      adapterId: numeric(row.adapter_id),
      fund: address(row.fund_address),
      controller: address(row.controller_address),
      chainId: Number(row.chain_id),
      tokenIn: address(row.token_in),
      tokenOut: address(row.token_out),
      amountIn: numeric(row.amount_in),
      quotedAmountOut: numeric(row.quoted_amount_out),
      minAmountOut: numeric(row.min_amount_out),
      routeCalldata: hex(row.route_calldata),
      adapterData: hex(row.adapter_data),
      executionHash: hex(row.execution_hash),
      expiresAt: date(row.expires_at),
    };
    return { request, plan };
  }

  async saveIntent(intent: IntentRecord): Promise<void> {
    await this.sql.begin(async (tx) => {
      await tx`
        insert into agent_private.intents (
          id, proposal_id, quote_id, agent_id, sponsor_wallet, controller_address,
          fund_address, chain_id, onchain_nonce, typed_data, signature, policy_hash,
          execution_hash, evidence_hash, state, transaction_hash, block_number,
          failure_code, expires_at
        ) values (
          ${intent.id}, ${intent.proposalId}, ${intent.quoteId}, ${intent.agentId.toLowerCase()},
          ${intent.sponsor.toLowerCase()}, ${intent.controller.toLowerCase()}, ${intent.fund.toLowerCase()},
          ${intent.chainId}, ${intent.intent.nonce.toString()},
          ${tx.json(jsonValue(intent.typedData) as never)}, ${intent.signature},
          ${intent.intent.policyHash.toLowerCase()}, ${intent.intent.executionHash.toLowerCase()},
          ${intent.intent.evidenceHash.toLowerCase()}, ${intent.state}, ${intent.transactionHash},
          ${intent.blockNumber?.toString() ?? null}, ${intent.failureCode}, ${intent.expiresAt}
        )
      `;
      await tx`
        insert into agent_private.policy_evaluations (intent_id, approved, policy_hash, checks)
        values (${intent.id}, true, ${intent.intent.policyHash.toLowerCase()},
          ${tx.json({ gateway: "approved", onchainRevalidation: true } as never)})
      `;
      await tx`
        insert into agent_private.agent_events (agent_id, event_type, payload)
        values (${intent.agentId.toLowerCase()}, 'intent',
          ${tx.json({ intentId: intent.id, state: intent.state } as never)})
      `;
      await tx`
        insert into public.agent_decisions (
          id, agent_id, vault_address, decision, summary, evidence_refs, policy_result,
          token_in, token_out, amount_in, min_amount_out, quoted_amount_out,
          slippage_bps, chain_id, occurred_at
        )
        select
          ${intent.id}, ${intent.agentId.toLowerCase()}, ${intent.fund.toLowerCase()}, 'approved',
          coalesce(proposal.proposal->>'summary', 'Policy-approved trade intent'),
          jsonb_build_array(jsonb_build_object(
            'deploymentId', proposal.graph_deployment_id,
            'blockNumber', proposal.graph_block_number::text,
            'blockTimestamp', proposal.graph_block_timestamp,
            'evidenceHash', proposal.evidence_hash
          )),
          'approved', quote.token_in, quote.token_out, quote.amount_in::text,
          quote.min_amount_out::text, quote.quoted_amount_out::text,
          (proposal.proposal->>'maxSlippageBps')::integer, quote.chain_id, now()
        from agent_private.proposals as proposal
        join agent_private.quotes as quote on quote.proposal_id = proposal.id
        where proposal.id = ${intent.proposalId} and quote.id = ${intent.quoteId}
      `;
    });
  }

  async getIntent(id: string): Promise<IntentRecord | null> {
    const rows = await this.sql`
      select intent.*, quote.adapter_data
      from agent_private.intents as intent
      join agent_private.quotes as quote on quote.id = intent.quote_id
      where intent.id = ${id}
      limit 1
    `;
    return rows[0] ? mapIntent(rows[0] as Row) : null;
  }

  async enqueueIntent(intentId: string): Promise<ExecutionJob> {
    return this.sql.begin(async (tx) => {
      const rows = await tx`
        insert into agent_private.execution_jobs (intent_id)
        values (${intentId})
        on conflict (intent_id) do update set intent_id = excluded.intent_id
        returning *
      `;
      await tx`
        update agent_private.intents set state = 'queued', updated_at = now()
        where id = ${intentId} and state in ('signed', 'queued')
      `;
      return mapJob(rows[0] as Row);
    });
  }

  async listEvents(agentId: Hex, cursor: string | null, limit: number): Promise<AgentEvent[]> {
    const after = cursor == null ? 0n : BigInt(cursor);
    const rows = await this.sql`
      select id, agent_id, event_type, payload, occurred_at
      from agent_private.agent_events
      where agent_id = ${agentId.toLowerCase()} and id > ${after.toString()}
      order by id asc limit ${Math.max(1, Math.min(limit, 100))}
    `;
    return rows.map((entry) => {
      const row = entry as Row;
      return {
        cursor: String(row.id),
        type: String(row.event_type) as AgentEvent["type"],
        agentId: hex(row.agent_id),
        occurredAt: date(row.occurred_at),
        payload: row.payload as Record<string, unknown>,
      };
    });
  }

  async appendEvent(event: Omit<AgentEvent, "cursor">): Promise<AgentEvent> {
    const rows = await this.sql`
      insert into agent_private.agent_events (agent_id, event_type, payload, occurred_at)
      values (${event.agentId.toLowerCase()}, ${event.type},
        ${this.sql.json(jsonValue(event.payload) as never)}, ${event.occurredAt})
      returning id, agent_id, event_type, payload, occurred_at
    `;
    const row = rows[0] as Row;
    return {
      cursor: String(row.id),
      type: String(row.event_type) as AgentEvent["type"],
      agentId: hex(row.agent_id),
      occurredAt: date(row.occurred_at),
      payload: row.payload as Record<string, unknown>,
    };
  }

  async recordDecision(input: AgentDecisionInput): Promise<string> {
    const rows = await this.sql`
      insert into public.agent_decisions (
        agent_id, vault_address, decision, summary, evidence_refs, policy_result, chain_id
      ) values (
        ${input.agentId.toLowerCase()}, ${input.vault.toLowerCase()}, ${input.decision},
        ${input.summary}, ${this.sql.json(jsonValue(input.evidenceRefs) as never)},
        ${input.policyResult}, ${input.chainId}
      ) returning id
    `;
    return String(rows[0]?.id);
  }

  async recordWorldAttestation(input: WorldAttestationRecord): Promise<void> {
    await this.sql`
      insert into agent_private.world_attestations (
        agent_id, sponsor_wallet, signer_address, backing_hash, agentbook_block,
        valid_until, verifier_signature
      ) values (
        ${input.agentId.toLowerCase()}, ${input.sponsor.toLowerCase()}, ${input.signer.toLowerCase()},
        ${input.backingHash.toLowerCase()}, ${input.agentBookBlock.toString()}, ${input.validUntil}, ${input.signature}
      ) on conflict (agent_id, backing_hash) do nothing
    `;
  }

  async createVaultJob(input: NewVaultJob): Promise<{ id: string; state: string }> {
    const rows = await this.sql`
      insert into agent_private.vault_jobs (agent_id, sponsor_wallet, request)
      values (${input.agentId.toLowerCase()}, ${input.sponsor.toLowerCase()},
        ${this.sql.json(jsonValue(input.request) as never)})
      returning id, state
    `;
    return { id: String(rows[0]?.id), state: String(rows[0]?.state) };
  }

  async getVaultJob(id: string): Promise<VaultJobRecord | null> {
    const rows = await this.sql`select * from agent_private.vault_jobs where id = ${id} limit 1`;
    return rows[0] ? mapVaultJob(rows[0] as Row) : null;
  }

  async getVaultJobForAgent(agentId: Hex): Promise<VaultJobRecord | null> {
    const rows = await this.sql`
      select * from agent_private.vault_jobs
      where agent_id = ${agentId.toLowerCase()} and state <> 'failed'
      order by created_at desc limit 1
    `;
    return rows[0] ? mapVaultJob(rows[0] as Row) : null;
  }

  async claimVaultJobs(workerId: string, limit: number): Promise<VaultJobRecord[]> {
    const rows = await this.sql`
      select * from agent_private.claim_vault_jobs(${workerId}, ${Math.max(1, Math.min(limit, 10))})
    `;
    return rows.map((row) => mapVaultJob(row as Row));
  }

  async reserveVaultNonceRange(jobId: string, chainId: number, deployer: Address, observedNonce: bigint): Promise<bigint> {
    const rows = await this.sql`
      select agent_private.reserve_vault_nonce_range(
        ${jobId}::uuid, ${chainId}, ${deployer.toLowerCase()}, ${observedNonce.toString()}::bigint
      ) as nonce_start
    `;
    if (!rows[0]) throw new Error("nonce range reservation failed");
    return numeric(rows[0].nonce_start);
  }

  async releaseUnusedVaultNonceRange(jobId: string, chainId: number, deployer: Address): Promise<void> {
    await this.sql`
      select agent_private.release_unused_vault_nonce_range(
        ${jobId}::uuid, ${chainId}, ${deployer.toLowerCase()}
      )
    `;
  }

  async persistVaultDeploymentPlan(jobId: string, workerId: string, plan: VaultDeploymentPlan): Promise<void> {
    const hashes = plan.transactions.map((tx) => tx.hash);
    const rows = await this.sql`
      update agent_private.vault_jobs
      set deployment_plan = ${this.sql.json(jsonValue(plan) as never)},
          controller_address = ${plan.controller.toLowerCase()},
          fund_address = ${plan.fund.toLowerCase()},
          transaction_hashes = ${this.sql.json(hashes as never)},
          state = 'deploying_controller', updated_at = now()
      where id = ${jobId}::uuid and locked_by = ${workerId}
      returning id
    `;
    if (rows.length !== 1) throw new Error("vault job is not owned by worker");
  }

  async updateVaultJobState(
    jobId: string,
    workerId: string,
    state: VaultJobState,
    options: { stakeEscrow?: Address; errorCode?: string; retryAt?: Date; terminal?: boolean } = {},
  ): Promise<void> {
    const nextState = options.terminal ? "failed" : state;
    const rows = await this.sql`
      update agent_private.vault_jobs
      set state = ${nextState},
          stake_escrow_address = coalesce(${options.stakeEscrow?.toLowerCase() ?? null}, stake_escrow_address),
          error_code = ${options.errorCode ?? null},
          available_at = ${options.retryAt ?? new Date()},
          locked_by = null, locked_at = null, updated_at = now()
      where id = ${jobId}::uuid and locked_by = ${workerId}
      returning id
    `;
    if (rows.length !== 1) throw new Error("vault job is not owned by worker");
  }

  async markVaultJobReady(agentId: Hex, controller: Address, fund: Address, stakeEscrow: Address): Promise<void> {
    const rows = await this.sql`
      update agent_private.vault_jobs
      set state = 'ready', stake_escrow_address = ${stakeEscrow.toLowerCase()},
          locked_by = null, locked_at = null, error_code = null, updated_at = now()
      where agent_id = ${agentId.toLowerCase()} and state = 'awaiting_sponsor_bind'
        and controller_address = ${controller.toLowerCase()} and fund_address = ${fund.toLowerCase()}
      returning id
    `;
    if (rows.length !== 1) throw new Error("vault deployment is not awaiting this sponsor binding");
  }

  async claimExecutionJobs(workerId: string, limit: number): Promise<ExecutionJob[]> {
    const rows = await this.sql`
      select * from agent_private.claim_execution_jobs(${workerId}, ${Math.max(1, Math.min(limit, 100))})
    `;
    return rows.map((entry) => mapJob(entry as Row));
  }

  async getIntentForJob(job: ExecutionJob): Promise<IntentRecord | null> {
    return this.getIntent(job.intentId);
  }

  async persistSignedTransaction(
    jobId: string,
    tx: { hash: Hex; serialized: Hex; nonce: bigint },
  ): Promise<void> {
    const rows = await this.sql`
      update agent_private.execution_jobs
      set transaction_hash = ${tx.hash}, signed_transaction = ${tx.serialized},
          chain_nonce = ${tx.nonce.toString()}, state = 'submitted', updated_at = now(),
          locked_by = null, locked_at = null, available_at = now() + interval '15 seconds'
      where id = ${jobId} and state = 'processing'
      returning id
    `;
    if (rows.length !== 1) throw new Error("execution job is not owned in processing state");
  }

  async markJobSubmitted(jobId: string, hash: Hex): Promise<void> {
    await this.sql.begin(async (tx) => {
      const rows = await tx`
        update agent_private.execution_jobs
        set transaction_hash = ${hash}, state = 'submitted', updated_at = now(),
            locked_by = null, locked_at = null, available_at = now() + interval '15 seconds'
        where id = ${jobId} returning intent_id
      `;
      if (!rows[0]) throw new Error("execution job not found");
      await tx`
        update agent_private.intents set state = 'submitted', transaction_hash = ${hash}, updated_at = now()
        where id = ${String(rows[0].intent_id)}
      `;
    });
  }

  async markJobConfirmed(jobId: string, hash: Hex, blockNumber: bigint): Promise<void> {
    await this.sql.begin(async (tx) => {
      const rows = await tx`
        update agent_private.execution_jobs
        set transaction_hash = ${hash}, state = 'confirmed', updated_at = now(),
            locked_by = null, locked_at = null
        where id = ${jobId} returning intent_id
      `;
      if (!rows[0]) throw new Error("execution job not found");
      const intentRows = await tx`
        update agent_private.intents set state = 'confirmed', transaction_hash = ${hash},
          block_number = ${blockNumber.toString()}, updated_at = now()
        where id = ${String(rows[0].intent_id)} returning agent_id, fund_address
      `;
      const intent = intentRows[0] as Row | undefined;
      if (intent) {
        await tx`
          insert into agent_private.agent_events (agent_id, event_type, payload)
          values (${String(intent.agent_id)}, 'receipt',
            ${tx.json({ intentId: String(rows[0].intent_id), transactionHash: hash, blockNumber: blockNumber.toString(), status: "confirmed" } as never)})
        `;
        await tx`
          update public.agent_decisions set decision = 'executed', transaction_hash = ${hash},
            block_number = ${blockNumber.toString()}, occurred_at = now()
          where id = ${String(rows[0].intent_id)}
        `;
      }
    });
  }

  async markJobFailed(jobId: string, code: string, retryAt: Date | null): Promise<void> {
    await this.sql.begin(async (tx) => {
      const rows = await tx`
        update agent_private.execution_jobs
        set state = case
              when ${retryAt}::timestamptz is not null and attempts < 20 then 'queued'
              when attempts >= 20 then 'dead_letter'
              else 'failed'
            end,
            available_at = coalesce(${retryAt}, available_at), last_error_code = ${code},
            locked_by = null, locked_at = null, updated_at = now()
        where id = ${jobId} returning intent_id, state
      `;
      if (!rows[0]) throw new Error("execution job not found");
      if (String(rows[0].state) !== "queued") {
        await tx`
          update agent_private.intents set state = 'failed', failure_code = ${code}, updated_at = now()
          where id = ${String(rows[0].intent_id)}
        `;
        await tx`
          update public.agent_decisions set decision = 'failed', occurred_at = now(),
            summary = left(summary || ' · execution failed: ' || ${code}, 2000)
          where id = ${String(rows[0].intent_id)}
        `;
      }
    });
  }

  async appendExecutionAttempt(input: {
    jobId: string;
    attempt: number;
    phase: "claimed" | "simulated" | "broadcast" | "receipt" | "reorg_check" | "failed";
    transactionHash?: Hex;
    receiptStatus?: "success" | "reverted" | "not_found";
    errorCode?: string;
  }): Promise<void> {
    await this.sql`
      insert into agent_private.execution_attempts (
        job_id, attempt, phase, transaction_hash, receipt_status, error_code
      ) values (
        ${input.jobId}, ${input.attempt}, ${input.phase}, ${input.transactionHash ?? null},
        ${input.receiptStatus ?? null}, ${input.errorCode ?? null}
      ) on conflict (job_id, attempt, phase) do nothing
    `;
  }
}
