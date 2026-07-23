import { getAddress, type Address, type Hex } from "viem";
import type { AgentChainReader } from "./chain.js";
import type { AgentProfile, GraphProvenance, VaultContext } from "./domain.js";

export class GraphDataError extends Error {
  constructor(readonly code: string, message: string, readonly status = 503) {
    super(message);
  }
}

export interface VaultListItem {
  address: Address;
  controller: Address | null;
  managerType: "human" | "agent";
  navWad: bigint;
  state: number;
}

export interface VaultIntelligence {
  listVaults(limit?: number): Promise<{ vaults: VaultListItem[]; provenance: GraphProvenance }>;
  getVaultContext(profile: AgentProfile): Promise<VaultContext>;
  getMarketLiquidity(tokenIn: Address, tokenOut: Address): Promise<Record<string, unknown>>;
}

interface GraphClientOptions {
  url: string;
  deploymentId: string;
  maxBlockLag?: bigint;
  maxAgeSeconds?: number;
}

type JsonObject = Record<string, unknown>;

function obj(value: unknown, label: string): JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new GraphDataError("GRAPH_BAD_RESPONSE", `${label} missing`);
  }
  return value as JsonObject;
}

function addr(value: unknown): Address {
  return getAddress(String(value)).toLowerCase() as Address;
}

function timestamp(value: unknown): Date {
  const numeric = Number(value);
  if (Number.isFinite(numeric) && numeric > 0) return new Date(numeric * 1_000);
  const parsed = new Date(String(value));
  if (Number.isNaN(parsed.getTime())) throw new GraphDataError("GRAPH_BAD_RESPONSE", "Invalid block timestamp");
  return parsed;
}

export class GraphVaultIntelligence implements VaultIntelligence {
  constructor(
    private readonly options: GraphClientOptions,
    private readonly chain: AgentChainReader,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async listVaults(limit = 100): Promise<{ vaults: VaultListItem[]; provenance: GraphProvenance }> {
    const data = await this.query(`
      query ListVaults($first: Int!) {
        _meta { deployment block { number timestamp } }
        vaults(first: $first, orderBy: createdAt, orderDirection: desc) {
          id controller managerType navWad state
        }
      }
    `, { first: Math.max(1, Math.min(limit, 100)) });
    const provenance = await this.provenance(obj(data._meta, "_meta"));
    const rows = Array.isArray(data.vaults) ? data.vaults : [];
    return {
      vaults: rows.map((entry) => {
        const row = obj(entry, "vault");
        return {
          address: addr(row.id),
          controller: row.controller ? addr(row.controller) : null,
          managerType: row.managerType === "agent" ? "agent" : "human",
          navWad: BigInt(String(row.navWad ?? 0)),
          state: Number(row.state ?? 0),
        };
      }),
      provenance,
    };
  }

  async getVaultContext(profile: AgentProfile): Promise<VaultContext> {
    if (!profile.vault || !profile.controller || !profile.policyHash) {
      throw new GraphDataError("AGENT_VAULT_NOT_READY", "Agent vault is not bound", 409);
    }
    const data = await this.query(`
      query VaultContext($id: ID!) {
        _meta { deployment block { number timestamp } }
        vault(id: $id) {
          id controller navWad
          holdings(first: 64, orderBy: valueWad, orderDirection: desc) {
            token balance valueWad
          }
          trades(first: 50, orderBy: timestamp, orderDirection: desc) {
            transactionHash tokenIn tokenOut spent received timestamp
          }
        }
      }
    `, { id: profile.vault.toLowerCase() });
    const provenance = await this.provenance(obj(data._meta, "_meta"));
    const vault = obj(data.vault, "vault");
    if (addr(vault.id) !== profile.vault.toLowerCase() || addr(vault.controller) !== profile.controller.toLowerCase()) {
      throw new GraphDataError("GRAPH_CONTROLLER_DRIFT", "Graph vault/controller binding disagrees with profile", 409);
    }
    const holdings = Array.isArray(vault.holdings) ? vault.holdings : [];
    const trades = Array.isArray(vault.trades) ? vault.trades : [];
    return {
      agentId: profile.agentId,
      vault: profile.vault,
      controller: profile.controller,
      policyHash: profile.policyHash,
      navWad: BigInt(String(vault.navWad ?? 0)),
      holdings: holdings.map((entry) => {
        const row = obj(entry, "holding");
        return { token: addr(row.token), balance: BigInt(String(row.balance)), valueWad: BigInt(String(row.valueWad)) };
      }),
      recentTrades: trades.map((entry) => {
        const row = obj(entry, "trade");
        return {
          transactionHash: String(row.transactionHash) as Hex,
          tokenIn: addr(row.tokenIn),
          tokenOut: addr(row.tokenOut),
          spent: BigInt(String(row.spent)),
          received: BigInt(String(row.received)),
          timestamp: timestamp(row.timestamp),
        };
      }),
      provenance,
    };
  }

  async getMarketLiquidity(tokenIn: Address, tokenOut: Address): Promise<Record<string, unknown>> {
    const data = await this.query(`
      query MarketLiquidity($tokenIn: Bytes!, $tokenOut: Bytes!) {
        _meta { deployment block { number timestamp } }
        marketLiquidity(tokenIn: $tokenIn, tokenOut: $tokenOut) {
          source poolAddress liquidityWad observedAt
        }
      }
    `, { tokenIn: tokenIn.toLowerCase(), tokenOut: tokenOut.toLowerCase() });
    const provenance = await this.provenance(obj(data._meta, "_meta"));
    return { marketLiquidity: data.marketLiquidity ?? null, provenance };
  }

  private async provenance(meta: JsonObject): Promise<GraphProvenance> {
    const block = obj(meta.block, "_meta.block");
    const blockNumber = BigInt(String(block.number));
    const blockTimestamp = timestamp(block.timestamp);
    const [chainHeadBlock] = await Promise.all([this.chain.getBlockNumber()]);
    const observedAt = new Date();
    const blockLag = chainHeadBlock > blockNumber ? chainHeadBlock - blockNumber : 0n;
    const ageSeconds = Math.max(0, (observedAt.getTime() - blockTimestamp.getTime()) / 1_000);
    if (blockLag > (this.options.maxBlockLag ?? 20n) || ageSeconds > (this.options.maxAgeSeconds ?? 120)) {
      throw new GraphDataError(
        "GRAPH_STALE",
        `Subgraph is stale (lag=${blockLag.toString()} blocks, age=${Math.floor(ageSeconds)}s)`,
        409,
      );
    }
    return {
      deploymentId: String(meta.deployment ?? this.options.deploymentId),
      blockNumber,
      blockTimestamp,
      chainHeadBlock,
      observedAt,
    };
  }

  private async query(query: string, variables: Record<string, unknown>): Promise<JsonObject> {
    let response: Response;
    try {
      response = await this.fetchImpl(this.options.url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ query, variables }),
        signal: AbortSignal.timeout(10_000),
      });
    } catch {
      throw new GraphDataError("GRAPH_UNAVAILABLE", "The Graph endpoint is unavailable");
    }
    if (!response.ok) throw new GraphDataError("GRAPH_HTTP_ERROR", `The Graph returned ${response.status}`);
    const envelope = obj(await response.json(), "Graph response");
    if (Array.isArray(envelope.errors) && envelope.errors.length > 0) {
      throw new GraphDataError("GRAPH_QUERY_ERROR", "The Graph rejected the query");
    }
    return obj(envelope.data, "Graph data");
  }
}
