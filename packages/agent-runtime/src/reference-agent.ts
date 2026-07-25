import { ToolLoopAgent, gateway, hasToolCall, isStepCount, tool } from "ai";
import {
  type Address,
  keccak256,
  stringToHex,
  type Hex,
} from "viem";
import { z } from "zod";
import type {
  LocalSafetyConfig,
  NuvemAgentClient,
  QuoteInput,
  QuoteResult,
  VaultContext,
} from "@nuvem/agent-sdk";
import type { McpVaultSnapshot } from "./graph-mcp.js";

export interface ReferenceAgentApi {
  context(): Promise<VaultContext>;
  graphVault(vault: Address): Promise<McpVaultSnapshot>;
  quote(input: QuoteInput, context?: VaultContext): Promise<QuoteResult>;
  signAndSubmit(quote: QuoteResult, input: QuoteInput, safety: LocalSafetyConfig): Promise<Record<string, unknown>>;
  heartbeat(runtimeVersion: string, capabilities: string[]): Promise<void>;
  recordDecision?(decision: "hold" | "rejected", summary: string, context: VaultContext): Promise<void>;
}

export interface ReferenceAgentOptions {
  model: string;
  execute: boolean;
  expectedChainId: number;
  expectedFund: Address;
  expectedController: Address;
  expectedApprovalProxy: Address;
  expectedUniversalRouter: Address;
  expectedAdapter?: Address;
  maxSlippageBps: number;
  requoteBeforeMs?: number;
}

function assertTrustedContext(context: VaultContext, options: ReferenceAgentOptions): void {
  if (
    context.vault.toLowerCase() !== options.expectedFund.toLowerCase()
    || context.controller.toLowerCase() !== options.expectedController.toLowerCase()
  ) {
    throw new Error("Gateway context does not match the runtime-pinned Fund/controller");
  }
  if (context.provenance.chainId !== options.expectedChainId) {
    throw new Error("Gateway Graph provenance is for another chain");
  }
}

function assertMcpMatches(
  context: VaultContext,
  snapshot: McpVaultSnapshot,
  options: ReferenceAgentOptions,
): void {
  const blockSkew = context.provenance.blockNumber >= snapshot.provenance.blockNumber
    ? context.provenance.blockNumber - snapshot.provenance.blockNumber
    : snapshot.provenance.blockNumber - context.provenance.blockNumber;
  if (
    snapshot.provenance.deploymentId !== context.provenance.deploymentId
    || snapshot.provenance.chainId !== options.expectedChainId
    || snapshot.provenance.indexingErrors
    || blockSkew > 60n
    || snapshot.data.address.toLowerCase() !== context.vault.toLowerCase()
    || snapshot.data.controller?.toLowerCase() !== context.controller.toLowerCase()
    || snapshot.data.agentId?.toLowerCase() !== context.agentId.toLowerCase()
  ) {
    throw new Error("The Graph MCP snapshot does not match the gateway's pinned context");
  }
}

async function trustedContext(
  api: ReferenceAgentApi,
  options: ReferenceAgentOptions,
): Promise<{ context: VaultContext; snapshot: McpVaultSnapshot }> {
  const context = await api.context();
  assertTrustedContext(context, options);
  const snapshot = await api.graphVault(context.vault);
  assertMcpMatches(context, snapshot, options);
  return { context, snapshot };
}

export function evidenceHash(
  context: VaultContext,
  proposal: { tokenIn: Address; tokenOut: Address; amountIn: bigint },
): Hex {
  return keccak256(stringToHex(JSON.stringify({
    deploymentId: context.provenance.deploymentId,
    blockNumber: context.provenance.blockNumber.toString(),
    blockTimestamp: context.provenance.blockTimestamp.toISOString(),
    vault: context.vault,
    tokenIn: proposal.tokenIn,
    tokenOut: proposal.tokenOut,
    amountIn: proposal.amountIn.toString(),
  })));
}

function serializable(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value, (_, entry) => {
    if (typeof entry === "bigint") return entry.toString();
    if (entry instanceof Date) return entry.toISOString();
    return entry;
  })) as unknown;
}

export function createReferenceTools(api: ReferenceAgentApi, options: ReferenceAgentOptions) {
  const pending = new Map<string, { quote: QuoteResult; input: QuoteInput; context: VaultContext }>();
  return {
    readVault: tool({
      description: "Read fresh Graph-backed NAV, holdings, recent trades and data provenance. Always call this first.",
      inputSchema: z.object({}),
      execute: async () => {
        const { context, snapshot } = await trustedContext(api, options);
        return serializable({
          ...context,
          mcpVerification: {
            verified: true,
            deploymentId: snapshot.provenance.deploymentId,
            blockNumber: snapshot.provenance.blockNumber,
            chainId: snapshot.provenance.chainId,
          },
        });
      },
    }),
    quoteTrade: tool({
      description: "Request an exact-input CLASSIC Uniswap quote. This is a dry run and does not sign or spend funds.",
      inputSchema: z.object({
        tokenIn: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
        tokenOut: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
        amountIn: z.string().regex(/^[1-9][0-9]*$/),
        maxSlippageBps: z.number().int().min(10).max(options.maxSlippageBps),
        summary: z.string().min(1).max(2_000),
        reasoning: z.string().min(1).max(4_000),
      }),
      execute: async ({ tokenIn, tokenOut, amountIn, maxSlippageBps, summary, reasoning }) => {
        const { context, snapshot } = await trustedContext(api, options);
        if (
          !context.navValid
          || !snapshot.data.navValid
          || context.state !== 0
          || snapshot.data.state !== 0
          || !snapshot.data.controllerEnabled
          || snapshot.data.controllerPaused
          || snapshot.data.agentStatus !== 1
          || snapshot.data.backedUntil == null
          || snapshot.data.backedUntil <= new Date()
        ) {
          throw new Error("The Graph MCP reports a vault state that is not safe to quote");
        }
        const trade = {
          tokenIn: tokenIn.toLowerCase() as Address,
          tokenOut: tokenOut.toLowerCase() as Address,
          amountIn: BigInt(amountIn),
        };
        const input: QuoteInput = {
          ...trade,
          maxSlippageBps,
          evidenceHash: evidenceHash(context, trade),
          reasoningHash: keccak256(stringToHex(reasoning)),
          summary,
        };
        const quote = await api.quote(input, context);
        pending.set(quote.executionPlan.quoteId, { quote, input, context });
        return serializable({
          quoteId: quote.executionPlan.quoteId,
          quotedAmountOut: quote.executionPlan.quotedAmountOut,
          minAmountOut: quote.executionPlan.minAmountOut,
          deadline: quote.intent.deadline,
          policyHash: quote.intent.policyHash,
          executionHash: quote.intent.executionHash,
          dryRun: !options.execute,
        });
      },
    }),
    executeQuotedTrade: tool({
      description: "Sign and submit one previously quoted trade. The SDK revalidates every field locally first.",
      inputSchema: z.object({ quoteId: z.string().uuid() }),
      execute: async ({ quoteId }) => {
        if (!options.execute) return { executed: false, reason: "Reference runtime is in dry-run mode" };
        const item = pending.get(quoteId);
        if (!item) return { executed: false, reason: "Unknown or already consumed quote" };
        pending.delete(quoteId);
        let quote = item.quote;
        let input = item.input;
        let context = item.context;
        let requoted = false;
        if (quote.executionPlan.expiresAt.getTime() - Date.now() <= (options.requoteBeforeMs ?? 15_000)) {
          ({ context } = await trustedContext(api, options));
          input = {
            ...item.input,
            evidenceHash: evidenceHash(context, {
              tokenIn: item.input.tokenIn,
              tokenOut: item.input.tokenOut,
              amountIn: item.input.amountIn,
            }),
          };
          quote = await api.quote(input, context);
          requoted = true;
        }
        const result = await api.signAndSubmit(quote, input, {
          chainId: options.expectedChainId,
          expectedFund: options.expectedFund,
          expectedController: options.expectedController,
          expectedAdapter: options.expectedAdapter,
          expectedApprovalProxy: options.expectedApprovalProxy,
          expectedUniversalRouter: options.expectedUniversalRouter,
          maxSlippageBps: options.maxSlippageBps,
        });
        return serializable({ executed: true, requoted, quoteId: quote.executionPlan.quoteId, result });
      },
    }),
    hold: tool({
      description: "Explicitly take no trade when evidence is weak, stale, unsafe or no rebalance is needed.",
      inputSchema: z.object({ reason: z.string().min(1).max(2_000) }),
      execute: async ({ reason }) => {
        const { context } = await trustedContext(api, options);
        if (api.recordDecision) await api.recordDecision("hold", reason, context);
        return { held: true, reason };
      },
    }),
  };
}

export class NuvemReferenceAgent {
  private readonly agent;

  constructor(private readonly api: ReferenceAgentApi, options: ReferenceAgentOptions) {
    const tools = createReferenceTools(api, options);
    this.agent = new ToolLoopAgent({
      model: gateway(options.model),
      instructions: `You are the Nuvem reference vault manager. You have no permission beyond the exposed tools.

Rules:
- Always call readVault before deciding; it verifies the Graph MCP snapshot against the gateway cursor.
- Use only addresses and balances returned by fresh context.
- Prefer hold when evidence is incomplete; never invent prices, liquidity, fills or performance.
- At most one quote and one execution per cycle.
- A quote is not a trade. Inspect minOut, deadline, policyHash and executionHash before executing.
- Never ask for, reveal or transmit a private key, bearer token, API key or raw private prompt.
- The controller is the final authority; a rejected policy check is a normal safety outcome.
- Explain the decision briefly after the tool result.`,
      tools,
      stopWhen: [isStepCount(8), hasToolCall("executeQuotedTrade")],
      maxRetries: 2,
    });
  }

  async runCycle(): Promise<{ text: string; steps: number }> {
    await this.api.heartbeat("nuvem-reference/0.1.0", ["the-graph-mcp", "graph-provenance", "uniswap-classic", "eip712", "hold"]);
    const result = await this.agent.generate({
      prompt: "Evaluate the current vault. Hold unless a policy-compliant rebalance is clearly supported by the provided data.",
      timeout: { totalMs: 90_000, stepMs: 30_000 },
    });
    return { text: result.text, steps: result.steps.length };
  }
}

export type ReferenceAgentClient = NuvemAgentClient;
