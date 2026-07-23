import { createPublicClient, defineChain, getAddress, http, type Address, type Hex } from "viem";
import type { IntelligenceSource, PolicyView, Provenance, VaultState } from "./types.js";

type Json = Record<string, unknown>;

export class IntelligenceError extends Error {
  constructor(readonly code: string, message: string) { super(message); }
}

function object(value: unknown, label: string): Json {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new IntelligenceError("BAD_SUBGRAPH_RESPONSE", `${label} missing`);
  return value as Json;
}

function address(value: unknown): Address { return getAddress(String(value)).toLowerCase() as Address; }
function date(value: unknown): Date {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric > 0 ? new Date(numeric * 1_000) : new Date(String(value));
}
function bigint(value: unknown): bigint { return BigInt(String(value ?? 0)); }

const robinhood = defineChain({
  id: 4663,
  name: "Robinhood Chain",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: ["https://rpc.robinhoodchain.com"] } },
});

export class SubgraphIntelligenceSource implements IntelligenceSource {
  private readonly client;

  constructor(
    private readonly graphUrl: string,
    rpcUrl: string,
    private readonly deploymentId: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {
    this.client = createPublicClient({ chain: robinhood, transport: http(rpcUrl, { retryCount: 2 }) });
  }

  async listVaults(limit: number): Promise<{ data: VaultState[]; provenance: Provenance }> {
    const result = await this.query(`
      query ListVaults($first: Int!) {
        _meta { deployment block { number timestamp } }
        vaults(first: $first, orderBy: createdAt, orderDirection: desc) {
          ${vaultFields}
        }
      }
    `, { first: Math.max(1, Math.min(limit, 100)) });
    return {
      data: (Array.isArray(result.vaults) ? result.vaults : []).map((entry) => this.mapVault(object(entry, "vault"))),
      provenance: await this.provenance(object(result._meta, "_meta")),
    };
  }

  async vault(vaultAddress: Address): Promise<{ data: VaultState; provenance: Provenance }> {
    const result = await this.query(`
      query Vault($id: ID!) {
        _meta { deployment block { number timestamp } }
        vault(id: $id) { ${vaultFields} }
      }
    `, { id: vaultAddress.toLowerCase() });
    return {
      data: this.mapVault(object(result.vault, "vault")),
      provenance: await this.provenance(object(result._meta, "_meta")),
    };
  }

  async liquidity(tokenIn: Address, tokenOut: Address): Promise<{ data: Record<string, unknown> | null; provenance: Provenance }> {
    const result = await this.query(`
      query Liquidity($pair: ID!) {
        _meta { deployment block { number timestamp } }
        liquiditySnapshot(id: $pair) { id token0 token1 poolAddress liquidityWad observedAt source }
      }
    `, { pair: [tokenIn.toLowerCase(), tokenOut.toLowerCase()].sort().join("-") });
    return {
      data: result.liquiditySnapshot == null ? null : object(result.liquiditySnapshot, "liquiditySnapshot"),
      provenance: await this.provenance(object(result._meta, "_meta")),
    };
  }

  private mapVault(row: Json): VaultState {
    const policyRow = row.policy == null ? null : object(row.policy, "policy");
    const policy: PolicyView | null = policyRow ? {
      maxTradeBps: Number(policyRow.maxTradeBps),
      maxConcentrationBps: Number(policyRow.maxConcentrationBps),
      dailyTurnoverBps: Number(policyRow.dailyTurnoverBps),
      maxSlippageBps: Number(policyRow.maxSlippageBps),
      maxTradesPerDay: Number(policyRow.maxTradesPerDay),
      minTradeInterval: Number(policyRow.minTradeInterval),
    } : null;
    return {
      address: address(row.id),
      controller: row.controller ? address(row.controller) : null,
      agentId: row.agentId ? String(row.agentId) as Hex : null,
      managerType: row.managerType === "agent" ? "agent" : "human",
      state: Number(row.state ?? 0),
      navWad: bigint(row.navWad),
      totalShares: bigint(row.totalShares),
      lastPeWad: bigint(row.lastPeWad),
      lifetimeDeposited6: bigint(row.lifetimeDeposited6),
      lifetimeWithdrawn6: bigint(row.lifetimeWithdrawn6),
      policy,
      turnoverTodayWad: bigint(row.turnoverTodayWad),
      tradesToday: Number(row.tradesToday ?? 0),
      lastTradeAt: row.lastTradeAt ? date(row.lastTradeAt) : null,
      holdings: (Array.isArray(row.holdings) ? row.holdings : []).map((entry) => {
        const holding = object(entry, "holding");
        return { token: address(holding.token), balance: bigint(holding.balance), valueWad: bigint(holding.valueWad) };
      }),
      recentTrades: (Array.isArray(row.trades) ? row.trades : []).map((entry) => {
        const trade = object(entry, "trade");
        return {
          transactionHash: String(trade.transactionHash) as Hex,
          tokenIn: address(trade.tokenIn), tokenOut: address(trade.tokenOut),
          spent: bigint(trade.spent), received: bigint(trade.received),
          spentValueWad: bigint(trade.spentValueWad), receivedValueWad: bigint(trade.receivedValueWad),
          timestamp: date(trade.timestamp),
        };
      }),
    };
  }

  private async provenance(meta: Json): Promise<Provenance> {
    const block = object(meta.block, "_meta.block");
    const blockNumber = bigint(block.number);
    const blockTimestamp = date(block.timestamp);
    const chainHeadBlock = await this.client.getBlockNumber();
    const observedAt = new Date();
    const lag = chainHeadBlock > blockNumber ? chainHeadBlock - blockNumber : 0n;
    const age = (observedAt.getTime() - blockTimestamp.getTime()) / 1_000;
    if (lag > 20n || age > 120) throw new IntelligenceError("GRAPH_STALE", `Subgraph lag=${lag} blocks age=${Math.floor(age)}s`);
    return { deploymentId: String(meta.deployment ?? this.deploymentId), blockNumber, blockTimestamp, chainHeadBlock, observedAt };
  }

  private async query(query: string, variables: Json): Promise<Json> {
    const response = await this.fetchImpl(this.graphUrl, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ query, variables }), signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw new IntelligenceError("GRAPH_UNAVAILABLE", `Subgraph HTTP ${response.status}`);
    const envelope = object(await response.json(), "response");
    if (Array.isArray(envelope.errors) && envelope.errors.length) throw new IntelligenceError("GRAPH_QUERY_ERROR", "Subgraph rejected query");
    return object(envelope.data, "data");
  }
}

const vaultFields = `
  id controller agentId managerType state navWad totalShares lastPeWad
  lifetimeDeposited6 lifetimeWithdrawn6 turnoverTodayWad tradesToday lastTradeAt
  policy { maxTradeBps maxConcentrationBps dailyTurnoverBps maxSlippageBps maxTradesPerDay minTradeInterval }
  holdings(first: 64, orderBy: valueWad, orderDirection: desc) { token balance valueWad }
  trades(first: 50, orderBy: timestamp, orderDirection: desc) {
    transactionHash tokenIn tokenOut spent received spentValueWad receivedValueWad timestamp
  }
`;
