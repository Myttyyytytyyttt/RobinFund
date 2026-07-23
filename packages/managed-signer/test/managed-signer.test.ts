import { describe, expect, it } from "vitest";
import { type Address } from "viem";
import {
  deriveManagedAgentAccount,
  deriveManagedAgentId,
  deriveManagedSignerIdentity,
} from "../src/index.js";

const secret = "nuvem-managed-signer-test-secret-that-is-long-enough";
const sponsor = "0x1000000000000000000000000000000000000001" as Address;

describe("managed signer derivation", () => {
  it("is deterministic and creates an isolated valid signer", async () => {
    const first = deriveManagedSignerIdentity(secret, sponsor, "018f9a38-59ff-7f30-a3ee-91cddfc6dc3d");
    const second = deriveManagedSignerIdentity(secret, sponsor, "018f9a38-59ff-7f30-a3ee-91cddfc6dc3d");
    expect(second).toEqual(first);
    expect(first.agentId).toMatch(/^0x[0-9a-f]{64}$/);
    expect(first.signer).toMatch(/^0x[0-9a-f]{40}$/);
    expect(first.signer).not.toBe(sponsor.toLowerCase());

    const account = deriveManagedAgentAccount(secret, first.agentId, sponsor);
    const signature = await account.signMessage({ message: "nuvem managed signer test" });
    expect(signature).toMatch(/^0x[0-9a-f]{130}$/);
  });

  it("separates sponsors, provisioning keys and the public agent id", () => {
    const base = deriveManagedAgentId(secret, sponsor, "launch-a");
    expect(deriveManagedAgentId(secret, sponsor, "launch-b")).not.toBe(base);
    expect(deriveManagedAgentId(secret, "0x2000000000000000000000000000000000000002", "launch-a")).not.toBe(base);
    expect(deriveManagedAgentId(`${secret}-rotated`, sponsor, "launch-a")).not.toBe(base);
  });

  it("rejects an unsafe short master secret", () => {
    expect(() => deriveManagedAgentId("short", sponsor, "launch-a")).toThrow(/32 characters/);
  });
});
