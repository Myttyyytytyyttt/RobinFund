import { createPublicClient, http, type Address, type Hex } from "viem";
import { worldchain } from "viem/chains";
import { AgentAuthError } from "./agentkit.js";
import type { AgentChainReader } from "./chain.js";
import type { ControlPlaneStore } from "./store.js";

export const CANONICAL_AGENTBOOK = "0xA23aB2712eA7BBa896930544C7d6636a96b944dA" as Address;
export const AGENTBOOK_WORLD_APP_ID = "app_a7c3e2b6b83927251a0db5345bd7146a";
export const AGENTBOOK_WORLD_ACTION = "agentbook-registration";

const agentBookAbi = [
  {
    type: "function",
    name: "getNextNonce",
    stateMutability: "view",
    inputs: [{ type: "address", name: "agent" }],
    outputs: [{ type: "uint256", name: "nonce" }],
  },
  {
    type: "function",
    name: "lookupHuman",
    stateMutability: "view",
    inputs: [{ type: "address", name: "agent" }],
    outputs: [{ type: "uint256", name: "humanId" }],
  },
] as const;

export type AgentBookRegistrationProof = {
  root: string;
  nonce: bigint;
  nullifierHash: string;
  proof: readonly Hex[];
};

export type AgentBookRegistrationStatus = {
  agentId: Hex;
  signer: Address;
  registered: boolean;
  contract: Address;
  lookupNetwork: "eip155:480";
  appId: string;
  action: string;
  nextNonce: string | null;
  command: string;
};

interface WorldRegistrationDependencies {
  getNextNonce(signer: Address): Promise<bigint>;
  lookupHuman(signer: Address): Promise<bigint>;
  submitRelay(payload: Record<string, unknown>): Promise<{ txHash?: Hex }>;
}

export class WorldRegistrationService {
  private readonly dependencies: WorldRegistrationDependencies;

  constructor(
    private readonly store: ControlPlaneStore,
    private readonly chain: AgentChainReader,
    worldRpcUrl: string,
    relayUrl: string,
    dependencies?: Partial<WorldRegistrationDependencies>,
  ) {
    const client = createPublicClient({ chain: worldchain, transport: http(worldRpcUrl, { retryCount: 2 }) });
    const read = (functionName: "getNextNonce" | "lookupHuman", signer: Address): Promise<bigint> =>
      client.readContract({
        address: CANONICAL_AGENTBOOK,
        abi: agentBookAbi,
        functionName,
        args: [signer],
      } as never) as Promise<bigint>;
    this.dependencies = {
      getNextNonce: dependencies?.getNextNonce ?? ((signer) => read("getNextNonce", signer)),
      lookupHuman: dependencies?.lookupHuman ?? ((signer) => read("lookupHuman", signer)),
      submitRelay: dependencies?.submitRelay ?? ((payload) => submitToRelay(relayUrl, payload)),
    };
  }

  async status(agentId: Hex, sponsor: Address): Promise<AgentBookRegistrationStatus> {
    const signer = await this.assertSponsor(agentId, sponsor);
    const human = await this.dependencies.lookupHuman(signer);
    const registered = human !== 0n;
    const nextNonce = registered ? null : (await this.dependencies.getNextNonce(signer)).toString();
    return {
      agentId,
      signer,
      registered,
      contract: CANONICAL_AGENTBOOK,
      lookupNetwork: "eip155:480",
      appId: AGENTBOOK_WORLD_APP_ID,
      action: AGENTBOOK_WORLD_ACTION,
      nextNonce,
      command: `npx @worldcoin/agentkit-cli@0.2.0 register ${signer}`,
    };
  }

  async submit(agentId: Hex, sponsor: Address, registration: AgentBookRegistrationProof): Promise<{
    registered: boolean;
    txHash: Hex | null;
  }> {
    const signer = await this.assertSponsor(agentId, sponsor);
    if (await this.dependencies.lookupHuman(signer) !== 0n) return { registered: true, txHash: null };

    const expectedNonce = await this.dependencies.getNextNonce(signer);
    if (registration.nonce !== expectedNonce) {
      throw new AgentAuthError("AGENTBOOK_NONCE_CHANGED", "AgentBook nonce changed; restart World verification", 409);
    }

    let relay: { txHash?: Hex };
    try {
      relay = await this.dependencies.submitRelay({
        agent: signer,
        root: registration.root,
        nonce: registration.nonce.toString(),
        nullifierHash: registration.nullifierHash,
        proof: registration.proof,
        contract: CANONICAL_AGENTBOOK,
      });
    } catch (error) {
      if (error instanceof AgentAuthError) throw error;
      throw new AgentAuthError("AGENTBOOK_RELAY_UNAVAILABLE", "World AgentBook relay is unavailable", 503);
    }
    const txHash = relay.txHash ?? null;
    await this.store.appendEvent({
      type: "agent",
      agentId,
      occurredAt: new Date(),
      payload: { action: "agentbook_registration_submitted", transactionHash: txHash },
    });
    return { registered: false, txHash };
  }

  private async assertSponsor(agentId: Hex, sponsor: Address): Promise<Address> {
    const [profile, chainAgent] = await Promise.all([
      this.store.getAgentProfile(agentId),
      this.chain.getAgent(agentId),
    ]);
    if (
      !profile
      || profile.sponsor.toLowerCase() !== sponsor.toLowerCase()
      || chainAgent.sponsor.toLowerCase() !== sponsor.toLowerCase()
      || profile.signer.toLowerCase() !== chainAgent.signer.toLowerCase()
    ) throw new AgentAuthError("NOT_SPONSOR", "Wallet does not own this AgentBook registration", 403);
    return chainAgent.signer;
  }
}

async function submitToRelay(relayUrl: string, payload: Record<string, unknown>): Promise<{ txHash?: Hex }> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20_000);
  try {
    const response = await fetch(new URL("/register", relayUrl), {
      method: "POST",
      headers: { "content-type": "application/json", "user-agent": "nuvem-agent-gateway/0.1" },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new AgentAuthError(
        response.status === 429 ? "AGENTBOOK_RELAY_RATE_LIMITED" : "AGENTBOOK_REGISTRATION_REJECTED",
        response.status === 429 ? "World AgentBook relay rate limit reached" : "World AgentBook relay rejected the proof",
        response.status === 429 ? 429 : 502,
      );
    }
    const body = await response.json() as { txHash?: unknown };
    if (body.txHash !== undefined && (typeof body.txHash !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(body.txHash))) {
      throw new AgentAuthError("AGENTBOOK_RELAY_BAD_RESPONSE", "World AgentBook relay returned an invalid transaction hash", 502);
    }
    return body.txHash ? { txHash: body.txHash.toLowerCase() as Hex } : {};
  } finally {
    clearTimeout(timeout);
  }
}
