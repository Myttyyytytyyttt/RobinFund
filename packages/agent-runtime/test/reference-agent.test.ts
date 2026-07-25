import type { Address, Hex } from "viem";
import { describe, expect, it, vi } from "vitest";
import type { QuoteResult, VaultContext } from "@nuvem/agent-sdk";
import { createReferenceTools, evidenceHash, type ReferenceAgentApi } from "../src/reference-agent.js";

const fund = "0x1111111111111111111111111111111111111111" as Address;
const controller = "0x2222222222222222222222222222222222222222" as Address;
const tokenIn = "0x3333333333333333333333333333333333333333" as Address;
const tokenOut = "0x4444444444444444444444444444444444444444" as Address;
const context: VaultContext = {
  agentId: `0x${"11".repeat(32)}` as Hex,
  vault: fund,
  controller,
  policyHash: `0x${"22".repeat(32)}` as Hex,
  navWad: 1_000n,
  holdings: [],
  recentTrades: [],
  provenance: {
    deploymentId: "deployment",
    blockNumber: 100n,
    blockTimestamp: new Date("2026-07-22T00:00:00Z"),
    chainHeadBlock: 100n,
    observedAt: new Date("2026-07-22T00:00:01Z"),
  },
};

function fakeQuote(
  quoteId = "00000000-0000-4000-8000-000000000001",
  lifetimeSeconds = 30,
): QuoteResult {
  const deadline = Math.floor(Date.now() / 1_000) + lifetimeSeconds;
  const intent = {
    agentId: context.agentId, fund, tokenIn, tokenOut, amountIn: 10n, minAmountOut: 9n,
    maxSlippageBps: 75, policyHash: context.policyHash,
    executionHash: `0x${"55".repeat(32)}` as Hex, evidenceHash: `0x${"66".repeat(32)}` as Hex,
    nonce: 0n, validAfter: deadline - 30, deadline,
  };
  return {
    executionPlan: {
      proposalId: "p", quoteId,
      quoteHash: `0x${"77".repeat(32)}` as Hex,
      adapter: "0x5555555555555555555555555555555555555555", approvalProxy: "0x0000000085e102724e78ecd2f45dc9ca239affad",
      adapterId: 7n, fund, controller, chainId: 4663, tokenIn, tokenOut,
      amountIn: 10n, quotedAmountOut: 10n, minAmountOut: 9n,
      routeCalldata: "0x12345678", adapterData: "0x1234", executionHash: intent.executionHash,
      expiresAt: new Date(deadline * 1_000),
    },
    intent,
    typedData: {
      domain: { name: "Nuvem AgentVaultController", version: "1", chainId: 4663, verifyingContract: controller },
      types: { TradeIntentV1: [] } as never, primaryType: "TradeIntentV1", message: intent,
    },
    provenance: context.provenance,
  };
}

function api(): ReferenceAgentApi & { signAndSubmit: ReturnType<typeof vi.fn> } {
  return {
    context: vi.fn(async () => context),
    quote: vi.fn(async () => fakeQuote()),
    signAndSubmit: vi.fn(async () => ({ accepted: true })),
    heartbeat: vi.fn(async () => undefined),
  };
}

async function execute(tool: unknown, input: unknown): Promise<unknown> {
  return (tool as { execute: (input: unknown, options: unknown) => Promise<unknown> }).execute(input, {});
}

const options = {
  model: "openai/gpt-5-mini",
  execute: false,
  expectedApprovalProxy: "0x0000000085e102724e78ecd2f45dc9ca239affad" as Address,
  expectedUniversalRouter: "0x8876789976decbfcbbbe364623c63652db8c0904" as Address,
  maxSlippageBps: 75,
};

describe("reference agent tools", () => {
  it("binds evidence to deployment, block, vault and exact trade", () => {
    const first = evidenceHash(context, { tokenIn, tokenOut, amountIn: 10n });
    const second = evidenceHash({ ...context, provenance: { ...context.provenance, blockNumber: 101n } }, { tokenIn, tokenOut, amountIn: 10n });
    expect(first).toMatch(/^0x[0-9a-f]{64}$/);
    expect(first).not.toBe(second);
  });

  it("reads only the API context", async () => {
    const fake = api();
    const tools = createReferenceTools(fake, options);
    const result = await execute(tools.readVault, {});
    expect(fake.context).toHaveBeenCalledOnce();
    expect(result).toMatchObject({ vault: fund, navWad: "1000" });
  });

  it("quotes without signing in dry-run mode", async () => {
    const fake = api();
    const tools = createReferenceTools(fake, options);
    const quote = await execute(tools.quoteTrade, {
      tokenIn, tokenOut, amountIn: "10", maxSlippageBps: 75, summary: "test", reasoning: "evidence",
    }) as { quoteId: string };
    const result = await execute(tools.executeQuotedTrade, { quoteId: quote.quoteId });
    expect(result).toMatchObject({ executed: false });
    expect(fake.signAndSubmit).not.toHaveBeenCalled();
  });

  it("submits only a previously issued quote when execute mode is enabled", async () => {
    const fake = api();
    const tools = createReferenceTools(fake, { ...options, execute: true });
    const unknown = await execute(tools.executeQuotedTrade, { quoteId: "00000000-0000-4000-8000-000000000099" });
    expect(unknown).toMatchObject({ executed: false });
    const quote = await execute(tools.quoteTrade, {
      tokenIn, tokenOut, amountIn: "10", maxSlippageBps: 75, summary: "test", reasoning: "evidence",
    }) as { quoteId: string };
    expect(await execute(tools.executeQuotedTrade, { quoteId: quote.quoteId })).toMatchObject({ executed: true });
    expect(fake.signAndSubmit).toHaveBeenCalledOnce();
  });

  it("refreshes a near-expiry quote before asking the signer to submit", async () => {
    const fake = api();
    const expiring = fakeQuote("00000000-0000-4000-8000-000000000001", 5);
    const refreshed = fakeQuote("00000000-0000-4000-8000-000000000002", 30);
    vi.mocked(fake.quote)
      .mockResolvedValueOnce(expiring)
      .mockResolvedValueOnce(refreshed);
    const tools = createReferenceTools(fake, { ...options, execute: true });
    const quote = await execute(tools.quoteTrade, {
      tokenIn, tokenOut, amountIn: "10", maxSlippageBps: 75, summary: "test", reasoning: "evidence",
    }) as { quoteId: string };

    const result = await execute(tools.executeQuotedTrade, { quoteId: quote.quoteId });

    expect(result).toMatchObject({
      executed: true,
      requoted: true,
      quoteId: refreshed.executionPlan.quoteId,
    });
    expect(fake.quote).toHaveBeenCalledTimes(2);
    expect(fake.context).toHaveBeenCalledTimes(2);
    expect(fake.signAndSubmit).toHaveBeenCalledWith(
      refreshed,
      expect.objectContaining({ evidenceHash: expect.stringMatching(/^0x[0-9a-f]{64}$/) }),
      expect.objectContaining({ expectedFund: fund, expectedController: controller }),
    );
  });
});
