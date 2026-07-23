import {
  buildAgentkitSchema,
  createAgentBookVerifier,
  parseAgentkitHeader,
  validateAgentkitMessage,
  verifyAgentkitSignature,
  type AgentkitExtension,
  type AgentkitPayload,
} from "@worldcoin/agentkit-core";
import { getAddress, type Address, type Hex } from "viem";
import type { AgentChainReader } from "./chain.js";
import { hmacSha256, randomNonce, randomOpaqueToken, requestHash, sha256 } from "./crypto.js";
import type { AgentSession } from "./domain.js";
import type { ControlPlaneStore } from "./store.js";

export class AgentAuthError extends Error {
  constructor(readonly code: string, message: string, readonly status = 401) {
    super(message);
  }
}

export interface SessionResult {
  token: string;
  tokenType: "Bearer";
  expiresAt: string;
  agentId: Hex;
}

export interface AgentkitDependencies {
  verifySignature(payload: AgentkitPayload, rpcUrl: string): Promise<{ valid: boolean; address?: string; error?: string }>;
  lookupHuman(address: string): Promise<string | null>;
}

export interface AgentSessionServiceOptions {
  publicBaseUrl: string;
  rpcUrl: string;
  worldRpcUrl?: string;
  sessionSecret: string;
  worldIdPepper: string;
  challengeLifetimeSeconds?: number;
  sessionLifetimeSeconds?: number;
}

function normalizeAddress(value: string): Address {
  try {
    return getAddress(value).toLowerCase() as Address;
  } catch {
    throw new AgentAuthError("INVALID_SIGNER", "AgentKit signer is not an EVM address");
  }
}

export class AgentSessionService {
  private readonly dependencies: AgentkitDependencies;
  private readonly sessionUri: string;
  private readonly domain: string;

  constructor(
    private readonly store: ControlPlaneStore,
    private readonly chain: AgentChainReader,
    private readonly options: AgentSessionServiceOptions,
    dependencies?: Partial<AgentkitDependencies>,
  ) {
    const base = new URL(options.publicBaseUrl);
    this.sessionUri = new URL("/v1/agent-sessions", base).toString();
    this.domain = base.host;
    const agentBook = createAgentBookVerifier({ rpcUrl: options.worldRpcUrl });
    this.dependencies = {
      verifySignature: dependencies?.verifySignature
        ?? ((payload, rpcUrl) => verifyAgentkitSignature(payload, rpcUrl)),
      lookupHuman: dependencies?.lookupHuman ?? ((address) => agentBook.lookupHuman(address)),
    };
  }

  async createChallenge(agentId: Hex): Promise<AgentkitExtension> {
    const profile = await this.store.getAgentProfile(agentId);
    if (!profile) throw new AgentAuthError("UNKNOWN_AGENT", "Agent is not registered", 404);
    const chainAgent = await this.chain.getAgent(agentId);
    if (
      chainAgent.signer.toLowerCase() !== profile.signer.toLowerCase()
      || chainAgent.sponsor.toLowerCase() !== profile.sponsor.toLowerCase()
    ) throw new AgentAuthError("PROFILE_DRIFT", "Agent profile does not match AgentRegistry", 409);

    const issuedAt = new Date();
    const expiresAt = new Date(issuedAt.getTime() + (this.options.challengeLifetimeSeconds ?? 300) * 1_000);
    const nonce = randomNonce();
    const extension: AgentkitExtension = {
      info: {
        domain: this.domain,
        uri: this.sessionUri,
        statement: "Open a revocable Nuvem agent session. This does not authorize a trade.",
        version: "1",
        nonce,
        issuedAt: issuedAt.toISOString(),
        expirationTime: expiresAt.toISOString(),
        requestId: agentId,
        resources: [`urn:nuvem:agent:${agentId.toLowerCase()}`],
      },
      supportedChains: [
        { chainId: `eip155:${this.chain.chainId}`, type: "eip191" },
        { chainId: `eip155:${this.chain.chainId}`, type: "eip1271" },
      ],
      schema: buildAgentkitSchema(),
    };
    await this.store.createChallenge({
      agentId,
      signer: chainAgent.signer,
      nonce,
      challengeHash: requestHash(extension),
      expiresAt,
    });
    return extension;
  }

  async createSession(agentId: Hex, header: string): Promise<SessionResult> {
    let payload: AgentkitPayload;
    try {
      payload = parseAgentkitHeader(header);
    } catch {
      throw new AgentAuthError("BAD_AGENTKIT_HEADER", "Malformed AgentKit header");
    }
    if (payload.requestId?.toLowerCase() !== agentId.toLowerCase()) {
      throw new AgentAuthError("AGENT_MISMATCH", "AgentKit challenge belongs to another agent");
    }
    const signer = normalizeAddress(payload.address);
    const validation = await validateAgentkitMessage(payload, this.sessionUri, {
      maxAge: this.options.challengeLifetimeSeconds ?? 300,
      checkNonce: (nonce) => this.store.isChallengeActive(agentId, signer, nonce),
    });
    if (!validation.valid) {
      throw new AgentAuthError("INVALID_AGENTKIT_MESSAGE", validation.error ?? "AgentKit message rejected");
    }

    const [profile, chainAgent, signature] = await Promise.all([
      this.store.getAgentProfile(agentId),
      this.chain.getAgent(agentId),
      this.dependencies.verifySignature(payload, this.options.rpcUrl),
    ]);
    if (!profile) throw new AgentAuthError("UNKNOWN_AGENT", "Agent is not registered", 404);
    if (!signature.valid || !signature.address) {
      throw new AgentAuthError("INVALID_AGENTKIT_SIGNATURE", signature.error ?? "AgentKit signature rejected");
    }
    if (normalizeAddress(signature.address) !== signer) {
      throw new AgentAuthError("SIGNER_RECOVERY_MISMATCH", "Recovered AgentKit signer differs from payload");
    }
    if (
      signer !== chainAgent.signer.toLowerCase()
      || signer !== profile.signer.toLowerCase()
      || chainAgent.sponsor.toLowerCase() !== profile.sponsor.toLowerCase()
    ) throw new AgentAuthError("STALE_AGENT_SIGNER", "Agent signer was rotated or profile is stale");
    if (!chainAgent.active || chainAgent.backedUntil <= Math.floor(Date.now() / 1_000)) {
      throw new AgentAuthError("WORLD_BACKING_INACTIVE", "AgentRegistry World backing is not active", 403);
    }

    // AgentBook returns an anonymous identifier. It is used only in memory and immediately HMACed.
    const humanId = await this.dependencies.lookupHuman(signer);
    if (!humanId) throw new AgentAuthError("AGENTBOOK_NOT_BACKED", "Signer has no active AgentBook backing", 403);

    // Atomic consumption is the final replay barrier after all remote verification work.
    if (!await this.store.consumeChallenge(agentId, signer, payload.nonce)) {
      throw new AgentAuthError("AGENTKIT_REPLAY", "AgentKit challenge was already consumed");
    }

    const token = randomOpaqueToken();
    const tokenHash = hmacSha256(this.options.sessionSecret, token);
    const proofHash = hmacSha256(this.options.worldIdPepper, humanId);
    const expiresAt = new Date(Date.now() + (this.options.sessionLifetimeSeconds ?? 900) * 1_000);
    await this.store.createSession({
      agentId,
      signer,
      sponsor: chainAgent.sponsor,
      tokenHash,
      proofHash,
      expiresAt,
    });
    await this.store.appendEvent({
      type: "agent",
      agentId,
      occurredAt: new Date(),
      payload: { action: "session_opened", expiresAt: expiresAt.toISOString() },
    });
    return { token, tokenType: "Bearer", expiresAt: expiresAt.toISOString(), agentId };
  }

  async authenticateBearer(value: string | undefined): Promise<AgentSession> {
    if (!value?.startsWith("Bearer ")) throw new AgentAuthError("SESSION_REQUIRED", "Bearer session required");
    const token = value.slice("Bearer ".length).trim();
    if (!token) throw new AgentAuthError("SESSION_REQUIRED", "Bearer session required");
    const session = await this.store.getSession(hmacSha256(this.options.sessionSecret, token));
    if (!session || session.revokedAt || session.expiresAt <= new Date()) {
      throw new AgentAuthError("SESSION_EXPIRED", "Agent session expired or revoked");
    }
    await this.store.touchSession(session.id);
    return session;
  }

  async backingHashForSigner(agentId: Hex, signer: Address): Promise<Hex> {
    return (await this.worldIdentityForSigner(agentId, signer)).backingHash;
  }

  async worldIdentityForSigner(agentId: Hex, signer: Address): Promise<{ humanHash: Hex; backingHash: Hex }> {
    const humanId = await this.dependencies.lookupHuman(signer);
    if (!humanId) throw new AgentAuthError("AGENTBOOK_NOT_BACKED", "Signer has no active AgentBook backing", 403);
    return {
      humanHash: hmacSha256(this.options.worldIdPepper, humanId),
      backingHash: hmacSha256(this.options.worldIdPepper, `${humanId}:${agentId.toLowerCase()}:${signer.toLowerCase()}`),
    };
  }

  proofForDebugOnly(value: string): Hex {
    return sha256(value);
  }
}
