import { randomUUID } from "node:crypto";
import { hashSignal } from "@worldcoin/idkit-core/hashing";
import { signRequest, type RpSignature } from "@worldcoin/idkit-core/signing";
import { type Address, type Hex } from "viem";
import { z } from "zod";
import { AgentAuthError } from "./agentkit.js";
import type { AgentChainReader } from "./chain.js";
import { hmacSha256, requestHash, sha256 } from "./crypto.js";
import type {
  WorldIdentityAttribute,
  WorldIdentityEnvironment,
  WorldIdentityPolicy,
} from "./domain.js";
import type { ControlPlaneStore } from "./store.js";
import type { WorldIdRpContext } from "./world-id.js";

export const AI_VAULT_IDENTITY_POLICY_ID = "ai-vault-eligibility-v1";
export const AI_VAULT_IDENTITY_POLICY_VERSION = 1;

const policyAttributes: WorldIdentityAttribute[] = [
  { type: "document_type", value: "passport" },
  { type: "minimum_age", value: 18 },
];
const expectedCredential = {
  identifier: "passport",
  issuerSchemaId: 9_303,
} as const;
const requireUserPresence = false;

function policyDefinition(): WorldIdentityPolicy {
  const attributes = structuredClone(policyAttributes);
  return {
    id: AI_VAULT_IDENTITY_POLICY_ID,
    version: AI_VAULT_IDENTITY_POLICY_VERSION,
    attributes,
    hash: requestHash({
      domain: "nuvem-world-identity-policy-v1",
      id: AI_VAULT_IDENTITY_POLICY_ID,
      version: AI_VAULT_IDENTITY_POLICY_VERSION,
      attributes,
      credential: expectedCredential,
      requireUserPresence,
    }),
    requireUserPresence,
  };
}

export const AI_VAULT_IDENTITY_POLICY = policyDefinition();

const nonEmptyStringSchema = z.string().min(1);
const v4ResponseSchema = z.object({
  identifier: nonEmptyStringSchema,
  signal_hash: nonEmptyStringSchema.optional(),
  proof: z.array(nonEmptyStringSchema).length(5),
  nullifier: nonEmptyStringSchema,
  issuer_schema_id: z.number().int().nonnegative(),
  expires_at_min: z.number().int().nonnegative(),
}).passthrough();

const identityProofSchema = z.object({
  protocol_version: z.literal("4.0"),
  nonce: nonEmptyStringSchema,
  action: nonEmptyStringSchema,
  responses: z.array(v4ResponseSchema).min(1),
  user_presence_completed: z.boolean(),
  environment: z.enum(["staging", "production"]),
  identity_attested: z.boolean(),
}).passthrough();

const portalResultSchema = z.object({
  identifier: nonEmptyStringSchema,
  success: z.boolean(),
  nullifier: nonEmptyStringSchema,
}).passthrough();

const portalResponseSchema = z.object({
  success: z.literal(true),
  results: z.array(portalResultSchema).min(1),
  action: nonEmptyStringSchema,
  environment: z.enum(["staging", "production"]),
}).passthrough();

function numericField(value: string): bigint | null {
  if (!/^(?:0x[0-9a-f]+|[0-9]+)$/i.test(value)) return null;
  try {
    return BigInt(value);
  } catch {
    return null;
  }
}

function canonicalNumericField(value: string): Hex | null {
  const parsed = numericField(value);
  return parsed === null ? null : `0x${parsed.toString(16)}` as Hex;
}

function sameNumericField(left: string | undefined, right: string): boolean {
  if (!left) return false;
  const leftValue = numericField(left);
  const rightValue = numericField(right);
  return leftValue !== null && rightValue !== null && leftValue === rightValue;
}

function proofShape(rawProof: unknown): Record<string, unknown> {
  if (!rawProof || typeof rawProof !== "object" || Array.isArray(rawProof)) {
    return { kind: Array.isArray(rawProof) ? "array" : typeof rawProof };
  }
  const proof = rawProof as Record<string, unknown>;
  const responses = Array.isArray(proof.responses) ? proof.responses : [];
  return {
    protocolVersion: typeof proof.protocol_version === "string" ? proof.protocol_version : typeof proof.protocol_version,
    environment: typeof proof.environment === "string" ? proof.environment : typeof proof.environment,
    hasNonce: typeof proof.nonce === "string" && proof.nonce.length > 0,
    hasAction: typeof proof.action === "string" && proof.action.length > 0,
    identityAttested: proof.identity_attested === true,
    userPresenceCompleted: proof.user_presence_completed === true,
    responseCount: responses.length,
    responses: responses.slice(0, 4).map((entry) => {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) return { kind: typeof entry };
      const response = entry as Record<string, unknown>;
      return {
        identifier: typeof response.identifier === "string" ? response.identifier : typeof response.identifier,
        issuerSchemaId: typeof response.issuer_schema_id === "number" ? response.issuer_schema_id : undefined,
        proofItems: Array.isArray(response.proof) ? response.proof.length : undefined,
        hasNullifier: typeof response.nullifier === "string" && response.nullifier.length > 0,
      };
    }),
  };
}

export type WorldIdentityRequestResponse =
  | {
      credential: "identity_check";
      verified: true;
      reused: true;
      environment: WorldIdentityEnvironment;
      action: string;
      policy: Pick<WorldIdentityPolicy, "id" | "version" | "hash">;
      identityAttested: true;
      verifiedAt: string;
      validUntil: string;
    }
  | {
      credential: "identity_check";
      verified: false;
      reused: false;
      requestId: string;
      environment: WorldIdentityEnvironment;
      policy: WorldIdentityPolicy;
      appId: `app_${string}`;
      action: string;
      signal: Hex;
      rpContext: WorldIdRpContext;
      allowLegacyProofs: false;
      requireUserPresence: boolean;
      expiresAt: string;
    };

export interface WorldIdentityCheckServiceOptions {
  environment: WorldIdentityEnvironment;
  appId: `app_${string}`;
  rpId: string;
  rpSigningKey: Hex;
  action: string;
  worldIdPepper: string;
  verifyBaseUrl?: string;
  requestLifetimeSeconds?: number;
  attestationLifetimeSeconds?: number;
  verifyTimeoutMs?: number;
  maxManagedAgentsPerHuman?: number;
}

export interface WorldIdentityCheckServiceDependencies {
  sign(params: { signingKeyHex: string; action: string; ttl: number }): RpSignature;
  fetch(input: string, init: RequestInit): Promise<Response>;
  now(): Date;
}

export class WorldIdentityCheckService {
  private readonly dependencies: WorldIdentityCheckServiceDependencies;

  constructor(
    private readonly store: ControlPlaneStore,
    private readonly chain: AgentChainReader,
    private readonly options: WorldIdentityCheckServiceOptions,
    dependencies?: Partial<WorldIdentityCheckServiceDependencies>,
  ) {
    this.dependencies = {
      sign: dependencies?.sign ?? ((params) => signRequest(params)),
      fetch: dependencies?.fetch ?? ((input, init) => fetch(input, init)),
      now: dependencies?.now ?? (() => new Date()),
    };
  }

  private async assertSponsorAgent(agentId: Hex, sponsor: Address) {
    const [profile, agent] = await Promise.all([
      this.store.getAgentProfile(agentId),
      this.chain.getAgent(agentId),
    ]);
    if (!profile) throw new AgentAuthError("UNKNOWN_AGENT", "Agent profile does not exist", 404);
    if (
      profile.sponsor.toLowerCase() !== sponsor.toLowerCase()
      || agent.sponsor.toLowerCase() !== sponsor.toLowerCase()
    ) throw new AgentAuthError("NOT_SPONSOR", "Wallet is not this agent's sponsor", 403);
    if (profile.signer.toLowerCase() !== agent.signer.toLowerCase()) {
      throw new AgentAuthError("PROFILE_DRIFT", "Agent signer differs from AgentRegistry", 409);
    }
    return { agent };
  }

  async request(
    agentId: Hex,
    sponsor: Address,
    environment: WorldIdentityEnvironment,
    policyId: string,
  ): Promise<WorldIdentityRequestResponse> {
    if (environment !== this.options.environment) {
      throw new AgentAuthError(
        "WORLD_IDENTITY_ENVIRONMENT_UNAVAILABLE",
        `This deployment only accepts ${this.options.environment} World Identity proofs`,
        409,
      );
    }
    if (policyId !== AI_VAULT_IDENTITY_POLICY.id) {
      throw new AgentAuthError("WORLD_IDENTITY_POLICY_UNSUPPORTED", "Unsupported World Identity policy", 400);
    }
    const { agent } = await this.assertSponsorAgent(agentId, sponsor);
    const existing = await this.store.getWorldIdentityAgentBinding({
      agentId,
      appId: this.options.appId,
      rpId: this.options.rpId,
      environment,
      policyId: AI_VAULT_IDENTITY_POLICY.id,
      policyVersion: AI_VAULT_IDENTITY_POLICY.version,
      policyHash: AI_VAULT_IDENTITY_POLICY.hash,
      action: this.options.action,
    });
    if (
      existing
      && existing.sponsor.toLowerCase() === sponsor.toLowerCase()
      && existing.signer.toLowerCase() === agent.signer.toLowerCase()
      && existing.validUntil > this.dependencies.now()
    ) {
      return {
        credential: "identity_check",
        verified: true,
        reused: true,
        environment,
        action: existing.action,
        policy: {
          id: existing.policyId,
          version: existing.policyVersion,
          hash: existing.policyHash,
        },
        identityAttested: true,
        verifiedAt: existing.verifiedAt.toISOString(),
        validUntil: existing.validUntil.toISOString(),
      };
    }
    const reused = await this.store.bindExistingWorldIdentitySponsor({
      agentId,
      sponsor,
      signer: agent.signer,
      appId: this.options.appId,
      rpId: this.options.rpId,
      environment,
      policyId: AI_VAULT_IDENTITY_POLICY.id,
      policyVersion: AI_VAULT_IDENTITY_POLICY.version,
      policyHash: AI_VAULT_IDENTITY_POLICY.hash,
      action: this.options.action,
      maxManagedAgents: this.options.maxManagedAgentsPerHuman ?? 3,
    });
    if (reused.accepted && reused.binding) {
      return {
        credential: "identity_check",
        verified: true,
        reused: true,
        environment,
        action: reused.binding.action,
        policy: {
          id: reused.binding.policyId,
          version: reused.binding.policyVersion,
          hash: reused.binding.policyHash,
        },
        identityAttested: true,
        verifiedAt: reused.binding.verifiedAt.toISOString(),
        validUntil: reused.binding.validUntil.toISOString(),
      };
    }
    if (reused.reason === "managed_agent_limit") {
      throw new AgentAuthError(
        "MANAGED_AGENT_LIMIT",
        `This anonymous World identity already backs the maximum of ${reused.maxManagedAgents} Nuvem-managed agents`,
        409,
      );
    }
    if (reused.reason !== "sponsor_unverified") {
      throw new AgentAuthError(
        "WORLD_IDENTITY_BINDING_CONFLICT",
        "Existing World Identity binding does not match this agent",
        409,
      );
    }
    const ttl = this.options.requestLifetimeSeconds ?? 600;
    const signature = this.dependencies.sign({
      signingKeyHex: this.options.rpSigningKey,
      action: this.options.action,
      ttl,
    });
    const requestId = randomUUID();
    const expiresAt = new Date(signature.expiresAt * 1_000);
    const attributes = structuredClone(AI_VAULT_IDENTITY_POLICY.attributes);
    const attributesHash = requestHash({
      domain: "nuvem-world-identity-attributes-v1",
      policyId: AI_VAULT_IDENTITY_POLICY.id,
      policyVersion: AI_VAULT_IDENTITY_POLICY.version,
      attributes,
    });
    const signal = requestHash({
      domain: "nuvem-world-identity-agent-v1",
      chainId: this.chain.chainId,
      agentId: agentId.toLowerCase(),
      sponsor: sponsor.toLowerCase(),
      signer: agent.signer.toLowerCase(),
      environment,
      action: this.options.action,
      policyHash: AI_VAULT_IDENTITY_POLICY.hash,
    });
    await this.store.createWorldIdentityRequest({
      id: requestId,
      agentId,
      sponsor,
      signer: agent.signer,
      rpNonceHash: sha256(signature.nonce),
      signalHash: hashSignal(signal).toLowerCase() as Hex,
      appId: this.options.appId,
      rpId: this.options.rpId,
      environment,
      policyId: AI_VAULT_IDENTITY_POLICY.id,
      policyVersion: AI_VAULT_IDENTITY_POLICY.version,
      policyHash: AI_VAULT_IDENTITY_POLICY.hash,
      attributes,
      attributesHash,
      action: this.options.action,
      requireUserPresence: AI_VAULT_IDENTITY_POLICY.requireUserPresence,
      expiresAt,
      consumedAt: null,
    });
    return {
      credential: "identity_check",
      verified: false,
      reused: false,
      requestId,
      environment,
      policy: policyDefinition(),
      appId: this.options.appId,
      action: this.options.action,
      signal,
      rpContext: {
        rp_id: this.options.rpId,
        nonce: signature.nonce,
        created_at: signature.createdAt,
        expires_at: signature.expiresAt,
        signature: signature.sig,
      },
      allowLegacyProofs: false,
      requireUserPresence: AI_VAULT_IDENTITY_POLICY.requireUserPresence,
      expiresAt: expiresAt.toISOString(),
    };
  }

  async verify(
    agentId: Hex,
    sponsor: Address,
    requestId: string,
    rawProof: unknown,
  ): Promise<{
    credential: "identity_check";
    verified: true;
    reused: false;
    environment: WorldIdentityEnvironment;
    action: string;
    policy: Pick<WorldIdentityPolicy, "id" | "version" | "hash">;
    identityAttested: true;
    verifiedAt: string;
    validUntil: string;
  }> {
    const { agent } = await this.assertSponsorAgent(agentId, sponsor);
    const pending = await this.store.getWorldIdentityRequest(requestId);
    const now = this.dependencies.now();
    if (
      !pending
      || pending.consumedAt
      || pending.expiresAt <= now
      || pending.agentId.toLowerCase() !== agentId.toLowerCase()
      || pending.sponsor.toLowerCase() !== sponsor.toLowerCase()
      || pending.signer.toLowerCase() !== agent.signer.toLowerCase()
      || pending.appId !== this.options.appId
      || pending.rpId !== this.options.rpId
      || pending.environment !== this.options.environment
      || pending.policyId !== AI_VAULT_IDENTITY_POLICY.id
      || pending.policyVersion !== AI_VAULT_IDENTITY_POLICY.version
      || pending.policyHash !== AI_VAULT_IDENTITY_POLICY.hash
    ) {
      throw new AgentAuthError(
        "WORLD_IDENTITY_REQUEST_INVALID",
        "World Identity request is missing, expired, changed or already consumed",
        409,
      );
    }

    const parsed = identityProofSchema.safeParse(rawProof);
    if (!parsed.success) {
      console.warn("[world-identity] rejected unsupported proof shape", {
        shape: proofShape(rawProof),
        issues: parsed.error.issues.map((issue) => ({
          code: issue.code,
          path: issue.path.map(String).join("."),
        })),
      });
      throw new AgentAuthError(
        "WORLD_IDENTITY_PROOF_INVALID",
        "World App did not return a valid World ID 4.0 Identity Check proof",
        400,
      );
    }
    const proof = parsed.data;
    const credential = proof.responses.find((entry) => (
      entry.identifier.toLowerCase() === expectedCredential.identifier
      && entry.issuer_schema_id === expectedCredential.issuerSchemaId
    ));
    if (
      proof.environment !== pending.environment
      || proof.action !== pending.action
      || sha256(proof.nonce) !== pending.rpNonceHash
      || proof.identity_attested !== true
      || (pending.requireUserPresence && proof.user_presence_completed !== true)
      || !credential
      || !sameNumericField(credential.signal_hash, pending.signalHash)
    ) {
      throw new AgentAuthError(
        "WORLD_IDENTITY_PROOF_MISMATCH",
        "World Identity proof does not satisfy this agent's policy request",
        409,
      );
    }
    const nullifier = canonicalNumericField(credential.nullifier);
    if (!nullifier) {
      throw new AgentAuthError(
        "WORLD_IDENTITY_PROOF_INVALID",
        "World Identity proof contains an invalid nullifier",
        400,
      );
    }

    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(),
      this.options.verifyTimeoutMs ?? 10_000,
    );
    timeout.unref?.();
    let response: Response;
    let portalPayload: unknown;
    try {
      response = await this.dependencies.fetch(
        `${(this.options.verifyBaseUrl ?? "https://developer.world.org").replace(/\/$/, "")}/api/v4/verify/${encodeURIComponent(pending.rpId)}`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "user-agent": "nuvem-agent-gateway/0.1 world-identity-check",
          },
          body: JSON.stringify(rawProof),
          signal: controller.signal,
        },
      );
      if (response.status < 500 && response.status !== 429 && (response.ok || response.status >= 400)) {
        portalPayload = await response.json();
      }
    } catch {
      throw new AgentAuthError(
        "WORLD_IDENTITY_UNAVAILABLE",
        "World Identity verification is temporarily unavailable",
        503,
      );
    } finally {
      clearTimeout(timeout);
    }

    if (response.status === 429) {
      throw new AgentAuthError(
        "WORLD_IDENTITY_RATE_LIMITED",
        "World Identity verification is temporarily rate limited",
        429,
      );
    }
    if (response.status >= 500 || (!response.ok && response.status < 400)) {
      throw new AgentAuthError(
        "WORLD_IDENTITY_UNAVAILABLE",
        "World Identity verification is temporarily unavailable",
        503,
      );
    }
    if (response.status >= 400) {
      throw new AgentAuthError(
        "WORLD_IDENTITY_REJECTED",
        "World rejected this Identity Check proof",
        403,
      );
    }
    const portal = portalResponseSchema.safeParse(portalPayload);
    const verifiedCredential = portal.success
      ? portal.data.results.find((entry) => (
        entry.identifier.toLowerCase() === expectedCredential.identifier
        && entry.success
        && sameNumericField(entry.nullifier, credential.nullifier)
      ))
      : undefined;
    if (
      !portal.success
      || !verifiedCredential
      || portal.data.action !== pending.action
      || portal.data.environment !== pending.environment
    ) {
      throw new AgentAuthError(
        "WORLD_IDENTITY_REJECTED",
        "World rejected this Identity Check proof",
        403,
      );
    }

    const verifiedAt = this.dependencies.now();
    const validUntil = new Date(
      verifiedAt.getTime() + (this.options.attestationLifetimeSeconds ?? 7 * 24 * 60 * 60) * 1_000,
    );
    const result = await this.store.recordWorldIdentityVerification({
      requestId,
      agentId,
      sponsor,
      signer: agent.signer,
      rpNonceHash: sha256(proof.nonce),
      signalHash: pending.signalHash,
      appId: pending.appId,
      rpId: pending.rpId,
      environment: pending.environment,
      policyId: pending.policyId,
      policyVersion: pending.policyVersion,
      policyHash: pending.policyHash,
      attributesHash: pending.attributesHash,
      action: pending.action,
      subjectHash: hmacSha256(
        this.options.worldIdPepper,
        `world-identity-v4-subject:${pending.environment}:${pending.rpId}:${pending.action}:${nullifier}`,
      ),
      nullifierHash: hmacSha256(
        this.options.worldIdPepper,
        `world-identity-v4-nullifier:${pending.environment}:${pending.rpId}:${pending.action}:${nullifier}`,
      ),
      proofHash: requestHash(rawProof),
      credentialIdentifier: expectedCredential.identifier,
      issuerSchemaId: expectedCredential.issuerSchemaId,
      verifiedAt,
      validUntil,
      maxManagedAgents: this.options.maxManagedAgentsPerHuman ?? 3,
    });
    if (!result.accepted || !result.binding) {
      if (result.reason === "managed_agent_limit") {
        throw new AgentAuthError(
          "MANAGED_AGENT_LIMIT",
          `This anonymous World identity already backs the maximum of ${result.maxManagedAgents} Nuvem-managed agents`,
          409,
        );
      }
      if (result.reason === "human_bound_elsewhere") {
        throw new AgentAuthError(
          "WORLD_IDENTITY_ALREADY_BOUND",
          "This World identity is already bound to another sponsor wallet",
          409,
        );
      }
      throw new AgentAuthError(
        result.reason === "binding_conflict" ? "WORLD_IDENTITY_BINDING_CONFLICT" : "WORLD_IDENTITY_REPLAY",
        result.reason === "binding_conflict"
          ? "Existing World Identity binding does not match this agent"
          : "World Identity request was already consumed or changed",
        409,
      );
    }
    return {
      credential: "identity_check",
      verified: true,
      reused: false,
      environment: pending.environment,
      action: pending.action,
      policy: {
        id: pending.policyId,
        version: pending.policyVersion,
        hash: pending.policyHash,
      },
      identityAttested: true,
      verifiedAt: result.binding.verifiedAt.toISOString(),
      validUntil: result.binding.validUntil.toISOString(),
    };
  }
}
