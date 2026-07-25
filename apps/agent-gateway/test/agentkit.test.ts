import { createAgentkitClient } from "@worldcoin/agentkit";
import { privateKeyToAccount } from "viem/accounts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentAuthError, AgentSessionService } from "../src/agentkit.js";
import { MemoryControlPlaneStore } from "../src/store.js";
import { AI_VAULT_IDENTITY_POLICY } from "../src/world-identity.js";
import { agentId, FakeChain, profile, sponsor } from "./fixtures.js";

const account = privateKeyToAccount(`0x${"01".repeat(32)}`);

afterEach(() => vi.useRealTimers());

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

function setupStaging(withBinding = true) {
  const store = new MemoryControlPlaneStore();
  const chain = new FakeChain();
  chain.chainId = 46_630;
  chain.agent.signer = account.address.toLowerCase() as typeof chain.agent.signer;
  void store.upsertAgentProfile(profile({ signer: chain.agent.signer }));
  const identityGate = {
    appId: "app_5fe197d24d83c55573c5d9d0356f3d6e" as const,
    rpId: "rp_db7d77ff9edef255",
    environment: "staging" as const,
    policyId: AI_VAULT_IDENTITY_POLICY.id,
    policyVersion: AI_VAULT_IDENTITY_POLICY.version,
    policyHash: AI_VAULT_IDENTITY_POLICY.hash,
    action: "sponsor-ai-vault",
  };
  if (withBinding) {
    store.worldIdentityAgentBindings.set(agentId, {
      agentId,
      sponsor,
      signer: chain.agent.signer,
      sponsorBindingId: "11111111-1111-4111-8111-111111111111",
      subjectHash: `0x${"55".repeat(32)}`,
      nullifierHash: `0x${"66".repeat(32)}`,
      appId: identityGate.appId,
      rpId: identityGate.rpId,
      environment: identityGate.environment,
      policyId: identityGate.policyId,
      policyVersion: identityGate.policyVersion,
      policyHash: identityGate.policyHash,
      attributesHash: `0x${"77".repeat(32)}`,
      action: identityGate.action,
      credentialIdentifier: "identity_check",
      issuerSchemaId: 9_303,
      verifiedAt: new Date(),
      validUntil: new Date(Date.now() + 3_600_000),
      revokedAt: null,
    });
  }
  const lookupHuman = vi.fn(async () => null);
  const service = new AgentSessionService(store, chain, {
    publicBaseUrl: "https://agents-staging.nuvem.fund",
    rpcUrl: "https://rpc.testnet.example",
    sessionSecret: "s".repeat(32),
    worldIdPepper: "w".repeat(32),
    humanBackingMode: "staging-identity",
    identityGate,
  }, {
    verifySignature: async () => ({ valid: true, address: account.address }),
    lookupHuman,
  });
  const client = createAgentkitClient({
    signer: {
      address: account.address,
      chainId: "eip155:46630",
      type: "eip191",
      signMessage: (message) => account.signMessage({ message }),
    },
  });
  return { store, chain, service, client, lookupHuman };
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

  it("uses the documented millisecond maxAge so a normal signing delay is accepted", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-25T12:00:00.000Z"));
    const { service, client } = setup();
    const header = await client.createHeader(await service.createChallenge(agentId));
    vi.advanceTimersByTime(2_000);

    await expect(service.createSession(agentId, header)).resolves.toMatchObject({ agentId });
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

  it("uses an active staging Identity Check binding on Robinhood testnet without claiming AgentBook", async () => {
    const { service, client, lookupHuman } = setupStaging();
    const header = await client.createHeader(await service.createChallenge(agentId));
    await expect(service.createSession(agentId, header)).resolves.toMatchObject({ agentId });
    await expect(service.worldIdentityForSigner(agentId, account.address))
      .resolves.toMatchObject({ mode: "staging-identity", canonical: false });
    expect(lookupHuman).not.toHaveBeenCalled();
  });

  it("fails closed when the staging Identity Check binding is absent", async () => {
    const { service, client } = setupStaging(false);
    const header = await client.createHeader(await service.createChallenge(agentId));
    await expect(service.createSession(agentId, header)).rejects.toMatchObject({
      code: "WORLD_IDENTITY_STAGING_REQUIRED",
    });
  });

  it("rejects a proof signed for a chain not advertised by the challenge", async () => {
    const { service, client } = setup();
    const header = await client.createHeader(await service.createChallenge(agentId));
    const payload = JSON.parse(Buffer.from(header, "base64").toString("utf8")) as Record<string, unknown>;
    payload.chainId = "eip155:1";
    const wrongChainHeader = Buffer.from(JSON.stringify(payload)).toString("base64");

    await expect(service.createSession(agentId, wrongChainHeader)).rejects.toMatchObject({
      code: "UNSUPPORTED_AGENTKIT_CHAIN",
    });
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

  it("revokes an issued session as soon as on-chain backing expires", async () => {
    const { service, client, chain, store } = setup();
    const header = await client.createHeader(await service.createChallenge(agentId));
    const result = await service.createSession(agentId, header);
    chain.agent.active = false;
    chain.agent.backedUntil = Math.floor(Date.now() / 1_000) - 1;

    await expect(service.authenticateBearer(`Bearer ${result.token}`)).rejects.toMatchObject({
      code: "WORLD_BACKING_INACTIVE",
    });
    expect([...store.sessions.values()][0]?.revokedAt).toBeInstanceOf(Date);
  });

  it("revokes an issued session after signer rotation", async () => {
    const { service, client, chain, store } = setup();
    const header = await client.createHeader(await service.createChallenge(agentId));
    const result = await service.createSession(agentId, header);
    chain.agent.signer = "0x9999999999999999999999999999999999999999";

    await expect(service.authenticateBearer(`Bearer ${result.token}`)).rejects.toMatchObject({
      code: "STALE_AGENT_SIGNER",
    });
    expect([...store.sessions.values()][0]?.revokedAt).toBeInstanceOf(Date);
  });
});
