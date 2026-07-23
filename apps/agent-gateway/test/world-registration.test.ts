import { describe, expect, it, vi } from "vitest";
import type { Hex } from "viem";
import { MemoryControlPlaneStore } from "../src/store.js";
import { CANONICAL_AGENTBOOK, WorldRegistrationService } from "../src/world-registration.js";
import { agentId, FakeChain, profile, signer, sponsor } from "./fixtures.js";

function setup() {
  const store = new MemoryControlPlaneStore();
  void store.upsertAgentProfile(profile({ status: "pending_backing", worldBacked: false }));
  const chain = new FakeChain();
  let human = 0n;
  const submitRelay = vi.fn(async () => ({ txHash: `0x${"ef".repeat(32)}` as Hex }));
  const service = new WorldRegistrationService(
    store,
    chain,
    "https://world.invalid",
    "https://relay.invalid",
    {
      getNextNonce: async () => 7n,
      lookupHuman: async () => human,
      submitRelay,
    },
  );
  return { store, service, submitRelay, setHuman: (value: bigint) => { human = value; } };
}

describe("WorldRegistrationService", () => {
  it("returns the official QR configuration without exposing a human id", async () => {
    const { service } = setup();
    const status = await service.status(agentId, sponsor);
    expect(status).toMatchObject({
      signer,
      registered: false,
      contract: CANONICAL_AGENTBOOK,
      lookupNetwork: "eip155:480",
      action: "agentbook-registration",
      nextNonce: "7",
    });
    expect(status.command).toContain(signer);
    expect(JSON.stringify(status)).not.toContain("humanId");
  });

  it("relays only a proof bound to the current AgentBook nonce", async () => {
    const { service, submitRelay } = setup();
    const result = await service.submit(agentId, sponsor, {
      root: "123",
      nonce: 7n,
      nullifierHash: "456",
      proof: Array.from({ length: 8 }, (_, index) => `0x${String(index + 1).padStart(64, "0")}` as Hex),
    });
    expect(result.txHash).toMatch(/^0x[0-9a-f]{64}$/);
    expect(submitRelay).toHaveBeenCalledWith(expect.objectContaining({ agent: signer, nonce: "7", contract: CANONICAL_AGENTBOOK }));
  });

  it("rejects stale proof nonce before spending relay gas", async () => {
    const { service, submitRelay } = setup();
    await expect(service.submit(agentId, sponsor, {
      root: "123", nonce: 6n, nullifierHash: "456",
      proof: Array.from({ length: 8 }, () => `0x${"01".repeat(32)}` as Hex),
    })).rejects.toMatchObject({ code: "AGENTBOOK_NONCE_CHANGED", status: 409 });
    expect(submitRelay).not.toHaveBeenCalled();
  });

  it("polls to registered state without returning the anonymous identifier", async () => {
    const { service, setHuman } = setup();
    setHuman(123456n);
    const status = await service.status(agentId, sponsor);
    expect(status.registered).toBe(true);
    expect(status.nextNonce).toBeNull();
    expect(JSON.stringify(status)).not.toContain("123456");
  });
});
