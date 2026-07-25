import { encodeFunctionData, parseAbi, type Address } from "viem";
import { describe, expect, it, vi } from "vitest";
import type { QuoteRequest } from "../src/domain.js";
import { UniswapApiError, UniswapTradingApi } from "../src/uniswap.js";
import {
  adapter,
  agentId,
  approvalProxy,
  evidenceHash,
  FakeChain,
  fund,
  profile,
  reasoningHash,
  stablecoin,
  tokenIn,
  tokenOut,
  universalRouter,
} from "./fixtures.js";

function request(): QuoteRequest {
  const observedAt = new Date();
  return {
    agentId,
    tokenIn,
    tokenOut,
    amountIn: 1_000_000n,
    maxSlippageBps: 75,
    evidenceHash,
    reasoningHash,
    summary: "Rebalance toward the strongest liquid asset",
    provenance: {
      deploymentId: "QmDeployment",
      chainId: 4663,
      blockNumber: 100n,
      blockHash: null,
      blockTimestamp: observedAt,
      chainHeadBlock: 100n,
      blockLag: 0n,
      indexingErrors: false,
      observedAt,
      ageSeconds: 0,
    },
  };
}

function quotePayload(routing = "CLASSIC", minimumAmount = "982575") {
  return {
    requestId: "quote-request",
    routing,
    quote: {
      routing,
      chainId: 4663,
      swapper: adapter,
      input: { token: tokenIn, amount: "1000000", chainId: 4663 },
      output: { token: tokenOut, amount: "990000", minimumAmount, recipient: fund },
    },
  };
}

const approvalProxyAbi = parseAbi([
  "function execute(address router,address token,uint256 amount,bytes commands,bytes[] inputs,uint256 deadline)",
]);

function proxyCall(deadline: number, overrides: {
  router?: Address;
  tokenIn?: Address;
  amountIn?: bigint;
  proxyDeadline?: bigint;
} = {}) {
  return encodeFunctionData({
    abi: approvalProxyAbi,
    functionName: "execute",
    args: [
      overrides.router ?? universalRouter,
      overrides.tokenIn ?? tokenIn,
      overrides.amountIn ?? 1_000_000n,
      "0x1234",
      ["0xabcd"],
      overrides.proxyDeadline ?? BigInt(deadline),
    ],
  });
}

function swapPayload(deadline: number, overrides: Record<string, unknown> = {}) {
  return {
    requestId: "swap-request",
    swap: {
      to: approvalProxy,
      from: adapter,
      data: proxyCall(deadline),
      value: "0",
      chainId: 4663,
      ...overrides,
    },
  };
}

function api(fetchImpl: typeof fetch) {
  return new UniswapTradingApi({
    apiBaseUrl: "https://trade-api.example/v1",
    apiKey: "test-api-key",
    chainId: 4663,
    approvalProxy,
    universalRouter,
    stablecoin,
  }, fetchImpl);
}

describe("Uniswap Trading API binding", () => {
  it("creates an atomic adapter plan bound to adapter, Fund and CLASSIC route", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetchImpl = vi.fn(async (input: URL | RequestInfo, init?: RequestInit) => {
      calls.push({ url: String(input), init });
      const body = init?.body == null ? {} : JSON.parse(String(init.body)) as { deadline?: number };
      return new Response(JSON.stringify(calls.length === 1 ? quotePayload() : swapPayload(body.deadline!)), { status: 200 });
    }) as unknown as typeof fetch;
    const chain = new FakeChain();
    const plan = await api(fetchImpl).createExecutionPlan(profile(), chain.controller, request());
    expect(plan.fund).toBe(fund);
    expect(plan.adapter).toBe(adapter);
    expect(plan.approvalProxy).toBe(approvalProxy);
    expect(plan.minAmountOut).toBe(982_575n);
    expect(plan.executionHash).toMatch(/^0x[0-9a-f]{64}$/);
    expect(calls).toHaveLength(2);
    expect(new Headers(calls[0]!.init?.headers).get("x-permit2-disabled")).toBe("true");
    const quoteRequest = JSON.parse(String(calls[0]!.init?.body)) as Record<string, unknown>;
    expect(quoteRequest.swapper).toBe(adapter);
    expect(quoteRequest.recipient).toBe(fund);
    expect(quoteRequest.routingPreference).toBeUndefined();
    expect(quoteRequest.protocols).toEqual(["V2", "V3", "V4"]);
    const swapRequest = JSON.parse(String(calls[1]!.init?.body)) as Record<string, unknown>;
    expect(swapRequest.simulateTransaction).toBe(false);
  });

  it("never lets an API minimum weaken the locally requested slippage floor", async () => {
    let call = 0;
    const fetchImpl = vi.fn(async (_input: URL | RequestInfo, init?: RequestInit) => {
      const body = init?.body == null ? {} : JSON.parse(String(init.body)) as { deadline?: number };
      return new Response(JSON.stringify(
        ++call === 1 ? quotePayload("CLASSIC", "1") : swapPayload(body.deadline!),
      ), { status: 200 });
    }) as unknown as typeof fetch;

    const plan = await api(fetchImpl).createExecutionPlan(profile(), new FakeChain().controller, request());
    expect(plan.minAmountOut).toBe(982_575n);
  });

  it("rejects UniswapX or any non-atomic route", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify(quotePayload("DUTCH_LIMIT")), { status: 200 })) as unknown as typeof fetch;
    await expect(api(fetchImpl).createExecutionPlan(profile(), new FakeChain().controller, request()))
      .rejects.toMatchObject({ code: "UNISWAP_NON_ATOMIC_ROUTE" });
  });

  it("rejects a swap target other than the deterministic approval proxy", async () => {
    let call = 0;
    const fetchImpl = vi.fn(async (_input: URL | RequestInfo, init?: RequestInit) => {
      const body = init?.body == null ? {} : JSON.parse(String(init.body)) as { deadline?: number };
      return new Response(JSON.stringify(
        ++call === 1 ? quotePayload() : swapPayload(body.deadline!, { to: "0x1111111111111111111111111111111111111111" }),
      ), { status: 200 });
    }) as unknown as typeof fetch;
    await expect(api(fetchImpl).createExecutionPlan(profile(), new FakeChain().controller, request()))
      .rejects.toMatchObject({ code: "UNISWAP_UNEXPECTED_TARGET" });
  });

  it.each([
    ["selector", () => "0x12345678"],
    ["router", (deadline: number) => proxyCall(deadline, { router: "0x1111111111111111111111111111111111111111" })],
    ["token input", (deadline: number) => proxyCall(deadline, { tokenIn: "0x1212121212121212121212121212121212121212" })],
    ["amount", (deadline: number) => proxyCall(deadline, { amountIn: 999_999n })],
    ["deadline", (deadline: number) => proxyCall(deadline, { proxyDeadline: BigInt(deadline - 1) })],
  ])("rejects a changed approval-proxy %s", async (_label, mutated) => {
    let call = 0;
    const fetchImpl = vi.fn(async (_input: URL | RequestInfo, init?: RequestInit) => {
      const body = init?.body == null ? {} : JSON.parse(String(init.body)) as { deadline?: number };
      const deadline = body.deadline ?? 0;
      return new Response(JSON.stringify(++call === 1
        ? quotePayload()
        : swapPayload(deadline, { data: mutated(deadline) })), { status: 200 });
    }) as unknown as typeof fetch;
    await expect(api(fetchImpl).createExecutionPlan(profile(), new FakeChain().controller, request()))
      .rejects.toMatchObject({ code: "UNISWAP_PROXY_CALL_MISMATCH" });
  });

  it("accepts the longer router deadline currently returned by the Trading API", async () => {
    let call = 0;
    const fetchImpl = vi.fn(async (_input: URL | RequestInfo, init?: RequestInit) => {
      const body = init?.body == null ? {} : JSON.parse(String(init.body)) as { deadline?: number };
      const deadline = body.deadline ?? 0;
      return new Response(JSON.stringify(++call === 1
        ? quotePayload()
        : swapPayload(deadline, { data: proxyCall(deadline, { proxyDeadline: BigInt(deadline + 1_500) }) })), { status: 200 });
    }) as unknown as typeof fetch;
    await expect(api(fetchImpl).createExecutionPlan(profile(), new FakeChain().controller, request())).resolves.toBeDefined();
  });

  it("rejects a recipient changed away from the Fund", async () => {
    const payload = quotePayload();
    payload.quote.output.recipient = "0x1111111111111111111111111111111111111111" as Address;
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify(payload), { status: 200 })) as unknown as typeof fetch;
    await expect(api(fetchImpl).createExecutionPlan(profile(), new FakeChain().controller, request()))
      .rejects.toMatchObject({ code: "UNISWAP_RECIPIENT_MISMATCH" });
  });

  it("classifies 429 as retryable without returning the provider body", async () => {
    const fetchImpl = vi.fn(async () => new Response("secret upstream body", { status: 429 })) as unknown as typeof fetch;
    const promise = api(fetchImpl).createExecutionPlan(profile(), new FakeChain().controller, request());
    await expect(promise).rejects.toBeInstanceOf(UniswapApiError);
    await expect(promise).rejects.toMatchObject({ code: "UNISWAP_RATE_LIMITED", retryable: true });
  });

  it("enforces the active output-asset policy before calling the API", async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    const blocked = { ...request(), tokenOut: "0x1212121212121212121212121212121212121212" as Address };
    await expect(api(fetchImpl).createExecutionPlan(profile(), new FakeChain().controller, blocked))
      .rejects.toMatchObject({ code: "ASSET_POLICY" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
