import { createPublicClient, defineChain, http, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { AgentAuthError, AgentSessionService } from "./agentkit.js";
import type { AgentChainReader } from "./chain.js";
import { requestHash } from "./crypto.js";
import type { ControlPlaneStore } from "./store.js";

const worldChain = defineChain({
  id: 480,
  name: "World Chain",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: ["https://worldchain-mainnet.g.alchemy.com/public"] } },
});

export type WorldBackingPayload = {
  agentId: Hex;
  sponsor: Address;
  signer: Address;
  backingHash: Hex;
  agentBookBlock: bigint;
  validUntil: number;
  nonce: bigint;
};

export interface WorldBlockReader {
  getBlockNumber(): Promise<bigint>;
}

export class WorldBackingService {
  private readonly verifier;
  private readonly worldClient: WorldBlockReader;

  constructor(
    private readonly store: ControlPlaneStore,
    private readonly chain: AgentChainReader,
    private readonly sessions: AgentSessionService,
    verifierPrivateKey: Hex,
    worldRpcUrl: string,
    worldClient?: WorldBlockReader,
  ) {
    this.verifier = privateKeyToAccount(verifierPrivateKey);
    this.worldClient = worldClient
      ?? createPublicClient({ chain: worldChain, transport: http(worldRpcUrl, { retryCount: 2 }) });
  }

  async issue(agentId: Hex, sponsor: Address): Promise<{ backing: WorldBackingPayload; signature: Hex; registry: Address }> {
    const [profile, agent, configuredVerifier, agentBookBlock, nonce, worldIdBinding] = await Promise.all([
      this.store.getAgentProfile(agentId),
      this.chain.getAgent(agentId),
      this.chain.getWorldVerifier(),
      this.worldClient.getBlockNumber(),
      this.chain.getBackingNonce(agentId),
      this.store.getWorldIdAgentBinding(agentId),
    ]);
    if (!profile) throw new AgentAuthError("UNKNOWN_AGENT", "Agent profile does not exist", 404);
    if (profile.sponsor.toLowerCase() !== sponsor.toLowerCase() || agent.sponsor.toLowerCase() !== sponsor.toLowerCase()) {
      throw new AgentAuthError("NOT_SPONSOR", "Wallet is not this agent's sponsor", 403);
    }
    if (profile.signer.toLowerCase() !== agent.signer.toLowerCase()) {
      throw new AgentAuthError("PROFILE_DRIFT", "Agent signer differs from AgentRegistry", 409);
    }
    if (configuredVerifier.toLowerCase() !== this.verifier.address.toLowerCase()) {
      throw new AgentAuthError("VERIFIER_MISCONFIGURED", "World verifier key does not match AgentRegistry", 503);
    }
    if (
      !worldIdBinding
      || worldIdBinding.revokedAt
      || worldIdBinding.sponsor.toLowerCase() !== sponsor.toLowerCase()
      || worldIdBinding.signer.toLowerCase() !== agent.signer.toLowerCase()
    ) throw new AgentAuthError("NUVEM_WORLD_ID_REQUIRED", "Complete the Nuvem World ID sponsor check first", 403);
    const identity = await this.sessions.worldIdentityForSigner(agentId, agent.signer);
    const backingHash = requestHash({
      domain: "nuvem-world-backing-v2",
      worldIdHumanHash: worldIdBinding.humanHash,
      agentBookBackingHash: identity.backingHash,
      agentId: agentId.toLowerCase(),
      signer: agent.signer.toLowerCase(),
    });
    const validUntil = Math.floor(Date.now() / 1_000) + 7 * 24 * 60 * 60;
    const backing: WorldBackingPayload = {
      agentId,
      sponsor,
      signer: agent.signer,
      backingHash,
      agentBookBlock,
      validUntil,
      nonce,
    };
    const signature = await this.verifier.signTypedData({
      domain: {
        name: "Nuvem AgentRegistry",
        version: "1",
        chainId: this.chain.chainId,
        verifyingContract: this.chain.registryAddress,
      },
      types: { WorldBacking: [
        { name: "agentId", type: "bytes32" },
        { name: "sponsor", type: "address" },
        { name: "signer", type: "address" },
        { name: "backingHash", type: "bytes32" },
        { name: "agentBookBlock", type: "uint64" },
        { name: "validUntil", type: "uint48" },
        { name: "nonce", type: "uint256" },
      ] },
      primaryType: "WorldBacking",
      message: backing,
    });
    await this.store.recordWorldAttestation({
      agentId,
      sponsor,
      signer: agent.signer,
      backingHash,
      agentBookBlock,
      validUntil: new Date(validUntil * 1_000),
      signature,
    });
    return { backing, signature, registry: this.chain.registryAddress };
  }
}
