import { createHash } from "node:crypto";
import type { AgentkitExtension } from "@worldcoin/agentkit";
import { privateKeyToAccount } from "viem/accounts";
import { describe, expect, it } from "vitest";
import { NuvemAgentClient } from "../src/client.js";

const account = privateKeyToAccount(`0x${"01".repeat(32)}`);
const agentId = `0x${"11".repeat(32)}` as const;

function challenge(sequence: number): AgentkitExtension {
  const issuedAt = new Date();
  return {
    info: {
      domain: "agents.nuvem.fund",
      uri: "https://agents.nuvem.fund/v1/agent-sessions",
      version: "1",
      nonce: createHash("sha256").update(String(sequence)).digest("hex").slice(0, 16),
      issuedAt: issuedAt.toISOString(),
      expirationTime: new Date(issuedAt.getTime() + 300_000).toISOString(),
      requestId: agentId,
    },
    supportedChains: [{ chainId: "eip155:46630", type: "eip191" }],
    schema: {
      $schema: "https://json-schema.org/draft/2020-12/schema",
      type: "object",
      properties: {
        domain: { type: "string" },
        address: { type: "string" },
        uri: { type: "string", format: "uri" },
        version: { type: "string" },
        chainId: { type: "string" },
        type: { type: "string" },
        nonce: { type: "string" },
        issuedAt: { type: "string", format: "date-time" },
        signature: { type: "string" },
      },
      required: ["domain", "address", "uri", "version", "chainId", "type", "nonce", "issuedAt", "signature"],
    },
  };
}

describe("AgentKit session lifecycle", () => {
  it("renews once and retries when the gateway reports an expired session", async () => {
    let challenges = 0;
    let sessions = 0;
    let heartbeats = 0;
    const fetchImpl: typeof fetch = async (input) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith("/challenge")) {
        challenges += 1;
        return Response.json({ agentkit: challenge(challenges) }, { status: 201 });
      }
      if (url.pathname === "/v1/agent-sessions") {
        sessions += 1;
        return Response.json({
          token: `session-${sessions}`,
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
        }, { status: 201 });
      }
      if (url.pathname.endsWith("/heartbeat")) {
        heartbeats += 1;
        if (heartbeats === 1) {
          return Response.json({ error: { code: "SESSION_EXPIRED", message: "expired" } }, { status: 401 });
        }
        return Response.json({ accepted: true });
      }
      return Response.json({ error: { code: "NOT_FOUND" } }, { status: 404 });
    };
    const client = new NuvemAgentClient("https://agents.nuvem.fund", agentId, {
      address: account.address,
      chainId: 46630,
      signMessage: (message) => account.signMessage({ message }),
      signTypedData: (typedData) => account.signTypedData(typedData as never),
    }, fetchImpl);

    await client.connect();
    await client.heartbeat("test/1.0.0", ["agentkit"]);

    expect({ challenges, sessions, heartbeats }).toEqual({
      challenges: 2,
      sessions: 2,
      heartbeats: 2,
    });
  });
});
