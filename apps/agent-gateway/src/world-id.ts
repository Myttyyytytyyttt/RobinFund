import { randomUUID } from "node:crypto";
import { hashSignal } from "@worldcoin/idkit-core/hashing";
import { signRequest, type RpSignature } from "@worldcoin/idkit-core/signing";
import { type Address, type Hex } from "viem";
import { z } from "zod";
import { AgentAuthError } from "./agentkit.js";
import type { AgentChainReader } from "./chain.js";
import { hmacSha256, requestHash, sha256 } from "./crypto.js";
import type { ControlPlaneStore } from "./store.js";

const hexSchema = z.string().regex(/^0x[0-9a-fA-F]+$/);
const responseSchema = z.object({
  identifier: z.literal("proof_of_human"),
  signal_hash: hexSchema,
  proof: z.array(hexSchema).length(5),
  nullifier: hexSchema,
  issuer_schema_id: z.literal(1),
  expires_at_min: z.number().int().nonnegative(),
}).passthrough();

const proofSchema = z.object({
  protocol_version: z.literal("4.0"),
  nonce: z.string().min(1),
  action: z.string().min(1),
  responses: z.array(responseSchema).min(1),
  user_presence_completed: z.boolean(),
  environment: z.literal("production"),
}).passthrough();

const portalResponseSchema = z.object({
  success: z.literal(true),
}).passthrough();

export type WorldIdRpContext = {
  rp_id: string;
  nonce: string;
  created_at: number;
  expires_at: number;
  signature: string;
};

export type WorldIdRequestResponse =
  | { verified: true; reused: boolean }
  | {
      verified: false;
      reused: false;
      requestId: string;
      appId: `app_${string}`;
      action: string;
      signal: Hex;
      rpContext: WorldIdRpContext;
      allowLegacyProofs: false;
      expiresAt: string;
    };

export interface WorldIdServiceOptions {
  appId: `app_${string}`;
  rpId: string;
  rpSigningKey: Hex;
  action: string;
  worldIdPepper: string;
  verifyBaseUrl?: string;
  requestLifetimeSeconds?: number;
  maxManagedAgentsPerHuman?: number;
}

export interface WorldIdServiceDependencies {
  sign(params: { signingKeyHex: string; action: string; ttl: number }): RpSignature;
  fetch(input: string, init: RequestInit): Promise<Response>;
}

export class WorldIdSponsorService {
  private readonly dependencies: WorldIdServiceDependencies;

  constructor(
    private readonly store: ControlPlaneStore,
    private readonly chain: AgentChainReader,
    private readonly options: WorldIdServiceOptions,
    dependencies?: Partial<WorldIdServiceDependencies>,
  ) {
    this.dependencies = {
      sign: dependencies?.sign ?? ((params) => signRequest(params)),
      fetch: dependencies?.fetch ?? ((input, init) => fetch(input, init)),
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
    return { profile, agent };
  }

  async request(agentId: Hex, sponsor: Address): Promise<WorldIdRequestResponse> {
    const { agent } = await this.assertSponsorAgent(agentId, sponsor);
    const existing = await this.store.getWorldIdAgentBinding(agentId);
    if (
      existing
      && existing.sponsor.toLowerCase() === sponsor.toLowerCase()
      && existing.signer.toLowerCase() === agent.signer.toLowerCase()
      && !existing.revokedAt
    ) return { verified: true, reused: true };

    const reused = await this.store.bindExistingWorldIdSponsor({
      agentId,
      sponsor,
      signer: agent.signer,
      maxManagedAgents: this.options.maxManagedAgentsPerHuman ?? 3,
    });
    if (reused.accepted) return { verified: true, reused: true };
    if (reused.reason === "managed_agent_limit") {
      throw new AgentAuthError(
        "MANAGED_AGENT_LIMIT",
        `This anonymous World human already backs the maximum of ${reused.maxManagedAgents} Nuvem-managed agents`,
        409,
      );
    }
    if (reused.reason !== "sponsor_unverified") {
      throw new AgentAuthError("WORLD_ID_BINDING_CONFLICT", "Existing World sponsor binding does not match this agent", 409);
    }

    const ttl = this.options.requestLifetimeSeconds ?? 300;
    const signature = this.dependencies.sign({
      signingKeyHex: this.options.rpSigningKey,
      action: this.options.action,
      ttl,
    });
    const signal = requestHash({
      domain: "nuvem-world-sponsor-v1",
      chainId: this.chain.chainId,
      agentId: agentId.toLowerCase(),
      sponsor: sponsor.toLowerCase(),
      signer: agent.signer.toLowerCase(),
      action: this.options.action,
    });
    const signalHash = hashSignal(signal).toLowerCase() as Hex;
    const requestId = randomUUID();
    const expiresAt = new Date(signature.expiresAt * 1_000);
    await this.store.createWorldIdRequest({
      id: requestId,
      agentId,
      sponsor,
      signer: agent.signer,
      rpNonceHash: sha256(signature.nonce),
      signalHash,
      action: this.options.action,
      expiresAt,
      consumedAt: null,
    });
    return {
      verified: false,
      reused: false,
      requestId,
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
      expiresAt: expiresAt.toISOString(),
    };
  }

  async verify(
    agentId: Hex,
    sponsor: Address,
    requestId: string,
    rawProof: unknown,
  ): Promise<{ verified: true; reused: false; action: string; verifiedAt: string }> {
    const { agent } = await this.assertSponsorAgent(agentId, sponsor);
    const pending = await this.store.getWorldIdRequest(requestId);
    if (
      !pending
      || pending.consumedAt
      || pending.expiresAt <= new Date()
      || pending.agentId.toLowerCase() !== agentId.toLowerCase()
      || pending.sponsor.toLowerCase() !== sponsor.toLowerCase()
      || pending.signer.toLowerCase() !== agent.signer.toLowerCase()
    ) throw new AgentAuthError("WORLD_ID_REQUEST_INVALID", "World ID request is missing, expired or already consumed", 409);

    const parsed = proofSchema.safeParse(rawProof);
    if (!parsed.success) throw new AgentAuthError("WORLD_ID_PROOF_INVALID", "World App returned an invalid World ID 4.0 proof", 400);
    const proof = parsed.data;
    const proofOfHuman = proof.responses.find((entry) => entry.identifier === "proof_of_human");
    if (
      proof.action !== pending.action
      || sha256(proof.nonce) !== pending.rpNonceHash
      || !proofOfHuman
      || proofOfHuman.signal_hash.toLowerCase() !== pending.signalHash.toLowerCase()
    ) throw new AgentAuthError("WORLD_ID_PROOF_MISMATCH", "World proof is not bound to this sponsor and agent", 409);

    let response: Response;
    try {
      response = await this.dependencies.fetch(
        `${(this.options.verifyBaseUrl ?? "https://developer.worldcoin.org").replace(/\/$/, "")}/api/v4/verify/${this.options.rpId}`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(rawProof),
        },
      );
    } catch {
      throw new AgentAuthError("WORLD_ID_UNAVAILABLE", "World proof verification is temporarily unavailable", 503);
    }
    let portalPayload: unknown;
    try {
      portalPayload = await response.json();
    } catch {
      portalPayload = null;
    }
    if (!response.ok || !portalResponseSchema.safeParse(portalPayload).success) {
      throw new AgentAuthError("WORLD_ID_REJECTED", "World rejected this proof", response.status === 429 ? 429 : 403);
    }

    const nullifier = proofOfHuman.nullifier.toLowerCase();
    const result = await this.store.recordWorldIdVerification({
      requestId,
      agentId,
      sponsor,
      signer: agent.signer,
      rpNonceHash: sha256(proof.nonce),
      signalHash: proofOfHuman.signal_hash.toLowerCase() as Hex,
      humanHash: hmacSha256(this.options.worldIdPepper, `world-id-v4-human:${nullifier}`),
      nullifierHash: hmacSha256(this.options.worldIdPepper, `world-id-v4-nullifier:${nullifier}`),
      proofHash: requestHash(rawProof),
      action: pending.action,
      maxManagedAgents: this.options.maxManagedAgentsPerHuman ?? 3,
    });
    if (!result.accepted) {
      if (result.reason === "managed_agent_limit") {
        throw new AgentAuthError(
          "MANAGED_AGENT_LIMIT",
          `This anonymous World human already backs the maximum of ${result.maxManagedAgents} Nuvem-managed agents`,
          409,
        );
      }
      if (result.reason === "human_bound_elsewhere") {
        throw new AgentAuthError("WORLD_HUMAN_ALREADY_BOUND", "This World identity is already bound to another sponsor wallet", 409);
      }
      throw new AgentAuthError("WORLD_ID_REPLAY", "World proof request was already consumed or changed", 409);
    }
    return { verified: true, reused: false, action: pending.action, verifiedAt: new Date().toISOString() };
  }
}
