import {
  createPublicClient,
  defineChain,
  getAddress,
  http,
  type Address,
  type Hex,
} from "viem";
import type { IntelligenceSource, PolicyView, Provenance, VaultState } from "./types.js";

type Json = Record<string, unknown>;
interface ChainCursor {
  getBlockNumber(): Promise<bigint>;
  getChainId(): Promise<number>;
}

export interface SubgraphSourceOptions {
  graphUrl: string;
  rpcUrl: string;
  deploymentId: string;
  expectedChainId: number;
  maxBlockLag?: bigint;
  maxAgeSeconds?: number;
  requestTimeoutMs?: number;
}

export class IntelligenceError extends Error {
  constructor(readonly code: string, message: string, readonly status = 503) {
    super(message);
    this.name = "IntelligenceError";
  }
}

function object(value: unknown, label: string): Json {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new IntelligenceError("BAD_SUBGRAPH_RESPONSE", `${label} missing`);
  }
  return value as Json;
}

function address(value: unknown): Address {
  try {
    return getAddress(String(value)).toLowerCase() as Address;
  } catch {
    throw new IntelligenceError("BAD_SUBGRAPH_RESPONSE", "Invalid EVM address");
  }
}

function date(value: unknown): Date {
  const numeric = Number(value);
  const parsed = Number.isFinite(numeric) && numeric > 0
    ? new Date(numeric * 1_000)
    : new Date(String(value));
  if (Number.isNaN(parsed.getTime())) {
    throw new IntelligenceError("BAD_SUBGRAPH_RESPONSE", "Invalid timestamp");
  }
  return parsed;
}

function optionalDate(value: unknown): Date | null {
  return value == null ? null : date(value);
}

function bigint(value: unknown): bigint {
  try {
    return BigInt(String(value ?? 0));
  } catch {
    throw new IntelligenceError("BAD_SUBGRAPH_RESPONSE", "Invalid integer");
  }
}

export class SubgraphIntelligenceSource implements IntelligenceSource {
  private readonly client: ChainCursor;

  constructor(
    private readonly options: SubgraphSourceOptions,
    private readonly fetchImpl: typeof fetch = fetch,
    chainClient?: ChainCursor,
  ) {
    const chain = defineChain({
      id: options.expectedChainId,
      name: options.expectedChainId === 46630 ? "Robinhood Chain Testnet" : "Robinhood Chain",
      nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
      rpcUrls: { default: { http: [options.rpcUrl] } },
    });
    this.client = chainClient
      ?? createPublicClient({ chain, transport: http(options.rpcUrl, { retryCount: 2 }) });
  }

  async listVaults(limit: number): Promise<{ data: VaultState[]; provenance: Provenance }> {
    const result = await this.query(`
      query ListVaults($first: Int!) {
        ${metaFields}
        vaults(first: $first, orderBy: createdAt, orderDirection: desc) {
          ${vaultFields}
        }
      }
    `, { first: Math.max(1, Math.min(limit, 100)) });
    const provenance = await this.provenance(object(result._meta, "_meta"));
    return {
      data: (Array.isArray(result.vaults) ? result.vaults : [])
        .map((entry) => this.mapVault(object(entry, "vault"))),
      provenance,
    };
  }

  async vault(vaultAddress: Address): Promise<{ data: VaultState; provenance: Provenance }> {
    const result = await this.query(`
      query Vault($id: ID!) {
        ${metaFields}
        vault(id: $id) { ${vaultFields} }
      }
    `, { id: vaultAddress.toLowerCase() });
    const provenance = await this.provenance(object(result._meta, "_meta"));
    if (result.vault == null) {
      throw new IntelligenceError("VAULT_NOT_INDEXED", "Vault is not indexed by this deployment", 404);
    }
    const data = this.mapVault(object(result.vault, "vault"));
    this.assertSnapshotFresh(data);
    return {
      data,
      provenance,
    };
  }

  private assertSnapshotFresh(vault: VaultState): void {
    const now = Date.now();
    const maxAgeMs = (this.options.maxAgeSeconds ?? 300) * 1_000;
    const navAgeMs = Math.max(0, now - vault.navObservedAt.getTime());
    if (navAgeMs > maxAgeMs) {
      throw new IntelligenceError(
        "VAULT_SNAPSHOT_STALE",
        `Vault NAV observation age=${Math.floor(navAgeMs / 1_000)}s`,
        409,
      );
    }
    const staleHolding = vault.holdings.find((holding) =>
      holding.balance > 0n && Math.max(0, now - holding.observedAt.getTime()) > maxAgeMs
    );
    if (staleHolding) {
      throw new IntelligenceError(
        "HOLDING_SNAPSHOT_STALE",
        "A non-zero holding observation exceeds the configured age limit",
        409,
      );
    }
  }

  private mapVault(row: Json): VaultState {
    const policyRow = row.policy == null ? null : object(row.policy, "policy");
    const controller = row.controllerRecord == null ? null : object(row.controllerRecord, "controllerRecord");
    const agent = row.agent == null ? null : object(row.agent, "agent");
    const policy: PolicyView | null = policyRow ? {
      policyHash: String(policyRow.policyHash) as Hex,
      maxTradeBps: Number(policyRow.maxTradeBps),
      maxConcentrationBps: Number(policyRow.maxConcentrationBps),
      dailyTurnoverBps: Number(policyRow.dailyTurnoverBps),
      maxSlippageBps: Number(policyRow.maxSlippageBps),
      maxTradesPerDay: Number(policyRow.maxTradesPerDay),
      minTradeInterval: Number(policyRow.minTradeInterval),
      maxIntentLifetime: Number(policyRow.maxIntentLifetime),
    } : null;
    return {
      address: address(row.id),
      controller: row.controller ? address(row.controller) : null,
      controllerEnabled: controller?.enabled === true,
      controllerPaused: controller?.paused === true,
      agentId: row.agentId ? String(row.agentId) as Hex : null,
      agentStatus: agent == null ? null : Number(agent.status),
      backedUntil: agent == null ? null : optionalDate(agent.backedUntil),
      managerType: row.managerType === "agent" ? "agent" : "human",
      state: Number(row.state ?? 0),
      navWad: bigint(row.navWad),
      navValid: row.navValid === true,
      navUpdatedAt: optionalDate(row.navUpdatedAt),
      navObservedAt: date(row.navObservedAt),
      totalShares: bigint(row.totalShares),
      lastPeWad: bigint(row.lastPeWad),
      lifetimeDeposited6: bigint(row.lifetimeDeposited6),
      lifetimeWithdrawn6: bigint(row.lifetimeWithdrawn6),
      policy,
      turnoverTodayWad: bigint(row.turnoverTodayWad),
      tradesToday: Number(row.tradesToday ?? 0),
      lastTradeAt: optionalDate(row.lastTradeAt),
      holdings: (Array.isArray(row.holdings) ? row.holdings : []).map((entry) => {
        const holding = object(entry, "holding");
        return {
          token: address(holding.token),
          balance: bigint(holding.balance),
          valueWad: bigint(holding.valueWad),
          valid: holding.valid === true,
          observedAt: date(holding.observedAt),
        };
      }),
      recentTrades: (Array.isArray(row.trades) ? row.trades : []).map((entry) => {
        const trade = object(entry, "trade");
        return {
          transactionHash: String(trade.transactionHash) as Hex,
          tokenIn: address(trade.tokenIn),
          tokenOut: address(trade.tokenOut),
          spent: bigint(trade.spent),
          received: bigint(trade.received),
          spentValueWad: bigint(trade.spentValueWad),
          receivedValueWad: bigint(trade.receivedValueWad),
          timestamp: date(trade.timestamp),
        };
      }),
    };
  }

  private async provenance(meta: Json): Promise<Provenance> {
    if (meta.hasIndexingErrors === true) {
      throw new IntelligenceError("GRAPH_INDEXING_ERRORS", "Subgraph reports indexing errors", 409);
    }
    const deploymentId = String(meta.deployment ?? "");
    if (!deploymentId || deploymentId !== this.options.deploymentId) {
      throw new IntelligenceError(
        "GRAPH_DEPLOYMENT_MISMATCH",
        "Subgraph deployment does not match the runtime-pinned deployment",
        409,
      );
    }
    const block = object(meta.block, "_meta.block");
    const blockNumber = bigint(block.number);
    const blockTimestamp = date(block.timestamp);
    const [chainHeadBlock, chainId] = await Promise.all([
      this.client.getBlockNumber(),
      this.client.getChainId(),
    ]);
    if (chainId !== this.options.expectedChainId) {
      throw new IntelligenceError(
        "RPC_CHAIN_MISMATCH",
        `RPC chain ${chainId} does not match expected ${this.options.expectedChainId}`,
        409,
      );
    }
    const observedAt = new Date();
    const blockLag = chainHeadBlock >= blockNumber
      ? chainHeadBlock - blockNumber
      : blockNumber - chainHeadBlock;
    const ageSeconds = Math.max(0, (observedAt.getTime() - blockTimestamp.getTime()) / 1_000);
    if (
      blockLag > (this.options.maxBlockLag ?? 50n)
      || ageSeconds > (this.options.maxAgeSeconds ?? 300)
    ) {
      throw new IntelligenceError(
        "GRAPH_STALE",
        `Subgraph lag=${blockLag.toString()} blocks age=${Math.floor(ageSeconds)}s`,
        409,
      );
    }
    return {
      deploymentId,
      chainId,
      blockNumber,
      blockHash: block.hash ? String(block.hash) as Hex : null,
      blockTimestamp,
      chainHeadBlock,
      blockLag,
      indexingErrors: false,
      observedAt,
      ageSeconds,
    };
  }

  private async query(query: string, variables: Json): Promise<Json> {
    let response: Response;
    try {
      response = await this.fetchImpl(this.options.graphUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ query, variables }),
        signal: AbortSignal.timeout(this.options.requestTimeoutMs ?? 10_000),
      });
    } catch {
      throw new IntelligenceError("GRAPH_UNAVAILABLE", "Subgraph endpoint is unavailable");
    }
    if (!response.ok) {
      throw new IntelligenceError("GRAPH_HTTP_ERROR", `Subgraph returned HTTP ${response.status}`);
    }
    const envelope = object(await response.json(), "response");
    if (Array.isArray(envelope.errors) && envelope.errors.length) {
      throw new IntelligenceError("GRAPH_QUERY_ERROR", "Subgraph rejected the query");
    }
    return object(envelope.data, "data");
  }
}

const metaFields = `
  _meta { deployment hasIndexingErrors block { number hash timestamp } }
`;

const vaultFields = `
  id controller agentId managerType state navWad navValid navUpdatedAt navObservedAt
  totalShares lastPeWad lifetimeDeposited6 lifetimeWithdrawn6
  turnoverTodayWad tradesToday lastTradeAt
  controllerRecord { id enabled paused policyHash }
  agent { id status backedUntil }
  policy {
    policyHash maxTradeBps maxConcentrationBps dailyTurnoverBps maxSlippageBps
    maxTradesPerDay minTradeInterval maxIntentLifetime
  }
  holdings(first: 64, orderBy: valueWad, orderDirection: desc) {
    token balance valueWad valid observedAt
  }
  trades(first: 50, orderBy: timestamp, orderDirection: desc) {
    transactionHash tokenIn tokenOut spent received
    spentValueWad receivedValueWad timestamp
  }
`;
