import { describe, expect, it } from "vitest";
import { ManagedSignerService } from "../src/managed-signer.js";
import { MemoryControlPlaneStore } from "../src/store.js";
import { sponsor } from "./fixtures.js";

describe("ManagedSignerService", () => {
  it("provisions an idempotent sponsor-owned identity without returning key material", async () => {
    const store = new MemoryControlPlaneStore();
    const service = new ManagedSignerService(store, "m".repeat(32));
    const first = await service.provision(sponsor, "018f9a38-59ff-7f30-a3ee-91cddfc6dc3d");
    const second = await service.provision(sponsor, "018f9a38-59ff-7f30-a3ee-91cddfc6dc3d");
    expect(second).toEqual(first);
    expect(first.agentId).toMatch(/^0x[0-9a-f]{64}$/);
    expect(first.signer).toMatch(/^0x[0-9a-f]{40}$/);
    expect(JSON.stringify(first)).not.toContain("private");
  });

  it("fails closed when managed custody is not configured", async () => {
    const service = new ManagedSignerService(new MemoryControlPlaneStore(), undefined);
    await expect(service.provision(sponsor, "018f9a38-59ff-7f30-a3ee-91cddfc6dc3d"))
      .rejects.toMatchObject({ code: "MANAGED_SIGNER_UNAVAILABLE", status: 503 });
  });
});
