import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { hashSignal } from "@worldcoin/idkit-core/hashing";
import type { Hex } from "viem";
import { PostgresControlPlaneStore } from "../src/postgres-store.js";
import { WorldIdSponsorService, type WorldIdRequestResponse } from "../src/world-id.js";
import { FakeChain, profile, signer, sponsor } from "./fixtures.js";

const integration = process.env.SUPABASE_E2E === "1" ? describe : describe.skip;
const firstId = `0x${"d1".repeat(32)}` as Hex;
const secondId = `0x${"d2".repeat(32)}` as Hex;
const nullifier = `0x${"cd".repeat(32)}`;

integration("World ID Postgres persistence", () => {
  let config: {
    DATABASE_URL: string;
    WORLD_APP_ID: `app_${string}`;
    WORLD_RP_ID: string;
    WORLD_RP_SIGNING_KEY: Hex;
    WORLD_ID_ACTION: string;
    WORLD_ID_PEPPER: string;
  };
  let store: PostgresControlPlaneStore;
  let admin: ReturnType<typeof postgres>;
  let service: WorldIdSponsorService;
  const chain = new FakeChain();
  const portal = vi.fn(async () => new Response(JSON.stringify({ success: true }), {
    status: 200,
    headers: { "content-type": "application/json" },
  }));
  let sequence = 0;
  async function cleanup() {
    await admin`delete from public.agent_profiles where agent_id in (${firstId}, ${secondId})`;
    await admin`delete from agent_private.world_id_sponsors where sponsor_wallet = ${sponsor.toLowerCase()}`;
  }

  beforeAll(async () => {
    const required = ["DATABASE_URL", "WORLD_APP_ID", "WORLD_RP_ID", "WORLD_RP_SIGNING_KEY", "WORLD_ID_ACTION", "WORLD_ID_PEPPER"] as const;
    for (const name of required) if (!process.env[name]) throw new Error(`Missing ${name} for World ID Postgres integration test`);
    config = {
      DATABASE_URL: process.env.DATABASE_URL!,
      WORLD_APP_ID: process.env.WORLD_APP_ID! as `app_${string}`,
      WORLD_RP_ID: process.env.WORLD_RP_ID!,
      WORLD_RP_SIGNING_KEY: process.env.WORLD_RP_SIGNING_KEY! as Hex,
      WORLD_ID_ACTION: process.env.WORLD_ID_ACTION!,
      WORLD_ID_PEPPER: process.env.WORLD_ID_PEPPER!,
    };
    store = PostgresControlPlaneStore.connect(config.DATABASE_URL);
    admin = postgres(config.DATABASE_URL, { max: 1, prepare: true });
    service = new WorldIdSponsorService(store, chain, {
      appId: config.WORLD_APP_ID as `app_${string}`,
      rpId: config.WORLD_RP_ID,
      rpSigningKey: config.WORLD_RP_SIGNING_KEY,
      action: config.WORLD_ID_ACTION,
      worldIdPepper: config.WORLD_ID_PEPPER,
      maxManagedAgentsPerHuman: 3,
    }, {
      sign: () => {
        sequence += 1;
        const now = Math.floor(Date.now() / 1_000);
        return { sig: `0x${"12".repeat(65)}`, nonce: `postgres-${sequence}`, createdAt: now, expiresAt: now + 300 };
      },
      fetch: portal,
    });
    await cleanup();
    await store.upsertAgentProfile(profile({
      agentId: firstId,
      vault: null,
      controller: null,
      policyHash: null,
      status: "pending_backing",
      worldBacked: false,
    }));
  });

  afterAll(async () => {
    await cleanup();
    await store.close();
    await admin.end();
  });

  it("writes only hashes and reuses the sponsor binding for a second agent", async () => {
    const request = await service.request(firstId, sponsor);
    if (request.verified) throw new Error("expected a proof request");
    const proof = proofFor(request, config.WORLD_ID_ACTION);
    await service.verify(firstId, sponsor, request.requestId, proof);

    const rows = await admin`
      select request.proof_hash, request.rp_nonce_hash, sponsor_row.human_hash,
             sponsor_row.nullifier_hash, binding.signer_address
      from agent_private.world_id_requests request
      join agent_private.world_id_agent_bindings binding on binding.source_request_id = request.id
      join agent_private.world_id_sponsors sponsor_row on sponsor_row.sponsor_wallet = binding.sponsor_wallet
      where request.agent_id = ${firstId}
    `;
    expect(rows).toHaveLength(1);
    expect(JSON.stringify(rows)).not.toContain(nullifier);
    expect(String(rows[0]?.signer_address)).toBe(signer.toLowerCase());

    await store.upsertAgentProfile(profile({
      agentId: secondId,
      vault: null,
      controller: null,
      policyHash: null,
      status: "pending_backing",
      worldBacked: false,
    }));
    await expect(service.request(secondId, sponsor)).resolves.toEqual({ verified: true, reused: true });
    const binding = await store.getWorldIdAgentBinding(secondId);
    expect(binding?.humanHash).toBe(String(rows[0]?.human_hash));
  });
});

function proofFor(request: Extract<WorldIdRequestResponse, { verified: false }>, action: string) {
  return {
    protocol_version: "4.0",
    nonce: request.rpContext.nonce,
    action,
    responses: [{
      identifier: "proof_of_human",
      signal_hash: hashSignal(request.signal),
      proof: Array.from({ length: 5 }, (_, index) => `0x${String(index + 1).padStart(64, "0")}`),
      nullifier,
      issuer_schema_id: 1,
      expires_at_min: Math.floor(Date.now() / 1_000) + 3_600,
    }],
    user_presence_completed: true,
    environment: "production",
  };
}
