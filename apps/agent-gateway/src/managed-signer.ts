import { deriveManagedSignerIdentity } from "@nuvem/managed-signer";
import type { Address, Hex } from "viem";
import { AgentAuthError } from "./agentkit.js";
import type { ManagedSignerRecord } from "./domain.js";
import type { ControlPlaneStore } from "./store.js";

export class ManagedSignerService {
  constructor(
    private readonly store: ControlPlaneStore,
    private readonly secret: string | undefined,
  ) {}

  async provision(sponsor: Address, provisioningKey: string): Promise<ManagedSignerRecord> {
    if (!this.secret) {
      throw new AgentAuthError(
        "MANAGED_SIGNER_UNAVAILABLE",
        "Nuvem-managed signing is not configured on this environment",
        503,
      );
    }
    const identity = deriveManagedSignerIdentity(this.secret, sponsor, provisioningKey);
    return this.store.upsertManagedSigner({
      ...identity,
      sponsor,
      provisioningKey,
      status: "provisioned",
      createdAt: new Date(),
    });
  }

  async assertVaultBinding(agentId: Hex, sponsor: Address, signer: Address): Promise<void> {
    const managed = await this.store.getManagedSigner(agentId);
    if (
      !managed
      || managed.sponsor.toLowerCase() !== sponsor.toLowerCase()
      || managed.signer.toLowerCase() !== signer.toLowerCase()
      || managed.status === "retired"
    ) {
      throw new AgentAuthError(
        "MANAGED_SIGNER_MISMATCH",
        "Nuvem reference vault must use the sponsor-owned managed signer provisioned by the gateway",
        409,
      );
    }
    await this.store.markManagedSignerBound(agentId, sponsor, signer);
  }
}
