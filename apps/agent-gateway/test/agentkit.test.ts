import { createAgentkitClient } from "@worldcoin/agentkit";
import { privateKeyToAccount } from "viem/accounts";
import { describe, expect, it } from "vitest";
import { AgentAuthError, AgentSessionService } from "../src/agentkit.js";
import { MemoryControlPlaneStore } from "../src/store.js";
import { agentId, FakeChain, profile } from "./fixtures.js";

const account = privateKeyToAccount(`0x${"01".repeat(32)}`);

function setup(lookupHuman: (address: string) => Promise<string | null> = async () => "anonymous-human") {
  const store = new MemoryControlPlaneStore();
  const chain = new FakeChain();
  chain.agent.signer = account.address.toLowerCase() as typeof chain.agent.signer;
  const current = profile({ signer: chain.agent.signer });
  void store.upsertAgentProfile(current);
  const service = new AgentSessionService(store, chain, {
    publicBaseUrl: "https://agents.nuvem.fund",
    rpcUrl: "https://rpc.example",
    sessionSecret: "s".repeat(32),
    worldIdPepper: "w".repeat(32),
  }, {
    verifySignature: async () => ({ valid: true, address: account.address }),
    lookupHuman,
  });
  const client = createAgentkitClient({
    signer: {
      address: account.address,
      chainId: "eip155:4663",
      type: "eip191",
      signMessage: (message) => account.signMessage({ message }),
    },
  });
  return { store, chain, service, client };
}

describe("AgentKit session boundary", () => {
  it("issues a 15-minute opaque session after a real AgentKit message", async () => {
    const { store, service, client } = setup();
    const challenge = await service.createChallenge(agentId);
    const header = await client.createHeader(challenge);
    const result = await service.createSession(agentId, header);
    expect(result.token).not.toMatch(/^0x/);
    const session = await service.authenticateBearer(`Bearer ${result.token}`);
    expect(session.agentId).toBe(agentId);
    expect([...store.sessions.values()]).toHaveLength(1);
  });

  it("atomically rejects replay of the same AgentKit challenge", async () => {
    const { service, client } = setup();
    const header = await client.createHeader(await service.createChallenge(agentId));
    await service.createSession(agentId, header);
    await expect(service.createSession(agentId, header)).rejects.toMatchObject({ code: "INVALID_AGENTKIT_MESSAGE" });
  });

  it("rejects a signer with no AgentBook human backing", async () => {
    const { service, client } = setup(async () => null);
    const header = await client.createHeader(await service.createChallenge(agentId));
    await expect(service.createSession(agentId, header)).rejects.toMatchObject({ code: "AGENTBOOK_NOT_BACKED" });
  });

  it("rejects a rotated signer before issuing the session", async () => {
    const { service, client, chain } = setup();
    const header = await client.createHeader(await service.createChallenge(agentId));
    chain.agent.signer = "0x9999999999999999999999999999999999999999";
    await expect(service.createSession(agentId, header)).rejects.toMatchObject({ code: "STALE_AGENT_SIGNER" });
  });

  it("rejects inactive on-chain World backing", async () => {
    const { service, client, chain } = setup();
    const header = await client.createHeader(await service.createChallenge(agentId));
    chain.agent.active = false;
    await expect(service.createSession(agentId, header)).rejects.toMatchObject({ code: "WORLD_BACKING_INACTIVE" });
  });

  it("does not accept an arbitrary bearer token", async () => {
    const { service } = setup();
    await expect(service.authenticateBearer("Bearer attacker-token")).rejects.toBeInstanceOf(AgentAuthError);
  });
});
