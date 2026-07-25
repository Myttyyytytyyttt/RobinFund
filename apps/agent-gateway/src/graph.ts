import {
  IntelligenceError,
  type IntelligenceSource,
  type Provenance,
  type VaultState,
} from "@nuvem/vault-intelligence-mcp";
import type { Address } from "viem";
import type { AgentProfile, GraphProvenance, VaultContext } from "./domain.js";

export class GraphDataError extends Error {
  constructor(readonly code: string, message: string, readonly status = 503) {
    super(message);
    this.name = "GraphDataError";
  }
}

export interface VaultListItem {
  address: Address;
  controller: Address | null;
  managerType: "human" | "agent";
  navWad: bigint;
  navValid: boolean;
  state: number;
}

export interface VaultIntelligence {
  listVaults(limit?: number): Promise<{ vaults: VaultListItem[]; provenance: GraphProvenance }>;
  getVaultContext(profile: AgentProfile): Promise<VaultContext>;
}

function provenance(value: Provenance): GraphProvenance {
  return {
    deploymentId: value.deploymentId,
    chainId: value.chainId,
    blockNumber: value.blockNumber,
    blockHash: value.blockHash,
    blockTimestamp: value.blockTimestamp,
    chainHeadBlock: value.chainHeadBlock,
    blockLag: value.blockLag,
    indexingErrors: value.indexingErrors,
    observedAt: value.observedAt,
    ageSeconds: value.ageSeconds,
  };
}

function graphError(error: unknown): never {
  if (error instanceof IntelligenceError) {
    throw new GraphDataError(error.code, error.message, error.status);
  }
  throw error;
}

export class GraphVaultIntelligence implements VaultIntelligence {
  constructor(private readonly source: IntelligenceSource) {}

  async listVaults(limit = 100): Promise<{ vaults: VaultListItem[]; provenance: GraphProvenance }> {
    try {
      const value = await this.source.listVaults(limit);
      return {
        vaults: value.data.map((vault) => ({
          address: vault.address,
          controller: vault.controller,
          managerType: vault.managerType,
          navWad: vault.navWad,
          navValid: vault.navValid,
          state: vault.state,
        })),
        provenance: provenance(value.provenance),
      };
    } catch (error) {
      graphError(error);
    }
  }

  async getVaultContext(profile: AgentProfile): Promise<VaultContext> {
    if (!profile.vault || !profile.controller || !profile.policyHash) {
      throw new GraphDataError("AGENT_VAULT_NOT_READY", "Agent vault is not bound", 409);
    }
    let value: { data: VaultState; provenance: Provenance };
    try {
      value = await this.source.vault(profile.vault);
    } catch (error) {
      graphError(error);
    }
    const vault = value.data;
    if (
      vault.address.toLowerCase() !== profile.vault.toLowerCase()
      || vault.controller?.toLowerCase() !== profile.controller.toLowerCase()
      || vault.agentId?.toLowerCase() !== profile.agentId.toLowerCase()
    ) {
      throw new GraphDataError(
        "GRAPH_BINDING_DRIFT",
        "Indexed vault, controller or agent binding disagrees with the control plane",
        409,
      );
    }
    if (vault.policy?.policyHash.toLowerCase() !== profile.policyHash.toLowerCase()) {
      throw new GraphDataError(
        "GRAPH_POLICY_DRIFT",
        "Indexed active policy disagrees with the control plane",
        409,
      );
    }
    return {
      agentId: profile.agentId,
      vault: profile.vault,
      controller: profile.controller,
      policyHash: profile.policyHash,
      state: vault.state,
      navWad: vault.navWad,
      navValid: vault.navValid,
      navUpdatedAt: vault.navUpdatedAt,
      navObservedAt: vault.navObservedAt,
      controllerEnabled: vault.controllerEnabled,
      controllerPaused: vault.controllerPaused,
      agentStatus: vault.agentStatus,
      backedUntil: vault.backedUntil,
      holdings: vault.holdings,
      recentTrades: vault.recentTrades.map((trade) => ({
        transactionHash: trade.transactionHash,
        tokenIn: trade.tokenIn,
        tokenOut: trade.tokenOut,
        spent: trade.spent,
        received: trade.received,
        timestamp: trade.timestamp,
      })),
      provenance: provenance(value.provenance),
    };
  }
}
