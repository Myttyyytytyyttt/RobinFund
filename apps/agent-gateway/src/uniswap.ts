import { randomUUID } from "node:crypto";
import {
  decodeFunctionData,
  encodeAbiParameters,
  getAddress,
  keccak256,
  parseAbi,
  stringToHex,
  type Address,
  type Hex,
} from "viem";
import type { ControllerState } from "./chain.js";
import { stableJson } from "./crypto.js";
import type { AgentProfile, ExecutionPlan, QuoteRequest } from "./domain.js";

export class UniswapApiError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number,
    readonly retryable: boolean,
  ) {
    super(message);
  }
}

export interface UniswapApiOptions {
  apiBaseUrl: string;
  apiKey: string;
  chainId: number;
  approvalProxy: Address;
  universalRouter: Address;
  stablecoin: Address;
  quoteLifetimeSeconds?: number;
}

type JsonObject = Record<string, unknown>;

const approvalProxyAbi = parseAbi([
  "function execute(address router,address token,uint256 amount,bytes commands,bytes[] inputs,uint256 deadline)",
]);

function object(value: unknown, name: string): JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new UniswapApiError("UNISWAP_BAD_RESPONSE", `${name} is missing`, 502, false);
  }
  return value as JsonObject;
}

function integer(value: unknown, name: string): bigint {
  try {
    const result = BigInt(String(value));
    if (result <= 0n) throw new Error("non-positive");
    return result;
  } catch {
    throw new UniswapApiError("UNISWAP_BAD_RESPONSE", `${name} is invalid`, 502, false);
  }
}

function evmAddress(value: unknown, name: string): Address {
  try {
    return getAddress(String(value)).toLowerCase() as Address;
  } catch {
    throw new UniswapApiError("UNISWAP_BAD_RESPONSE", `${name} is invalid`, 502, false);
  }
}

function calldata(value: unknown): Hex {
  const text = String(value);
  if (!/^0x[0-9a-fA-F]{8,}$/.test(text)) {
    throw new UniswapApiError("UNISWAP_BAD_RESPONSE", "swap calldata is invalid", 502, false);
  }
  return text as Hex;
}

export class UniswapTradingApi {
  constructor(
    private readonly options: UniswapApiOptions,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async createExecutionPlan(
    profile: AgentProfile,
    controller: ControllerState,
    request: QuoteRequest,
  ): Promise<ExecutionPlan> {
    if (!profile.vault || !profile.controller || !profile.policyHash) {
      throw new UniswapApiError("AGENT_VAULT_NOT_READY", "Agent vault is not fully bound", 409, false);
    }
    if (
      profile.vault.toLowerCase() !== controller.fund.toLowerCase()
      || profile.controller.toLowerCase() !== controller.address.toLowerCase()
    ) {
      throw new UniswapApiError("CONTROLLER_DRIFT", "Controller and public profile disagree", 409, false);
    }
    if (controller.agentId.toLowerCase() !== request.agentId.toLowerCase()) {
      throw new UniswapApiError("AGENT_MISMATCH", "Controller belongs to another agent", 409, false);
    }
    if (controller.paused) throw new UniswapApiError("CONTROLLER_PAUSED", "Controller is paused", 409, false);
    if (controller.policyHash.toLowerCase() !== profile.policyHash.toLowerCase()) {
      throw new UniswapApiError("POLICY_DRIFT", "Policy changed; refresh context", 409, false);
    }
    if (request.maxSlippageBps > profile.policy.maxSlippageBps || request.maxSlippageBps < 10) {
      throw new UniswapApiError("SLIPPAGE_POLICY", "Requested slippage exceeds active policy", 422, false);
    }
    const outputAllowed = request.tokenOut.toLowerCase() === this.options.stablecoin.toLowerCase()
      || profile.policy.allowedAssets.some((token) => token.toLowerCase() === request.tokenOut.toLowerCase());
    if (!outputAllowed) throw new UniswapApiError("ASSET_POLICY", "Output asset is not allowed", 422, false);

    const quoteRequest = {
      type: "EXACT_INPUT",
      amount: request.amountIn.toString(),
      tokenInChainId: this.options.chainId,
      tokenOutChainId: this.options.chainId,
      tokenIn: request.tokenIn,
      tokenOut: request.tokenOut,
      swapper: controller.adapter,
      recipient: controller.fund,
      slippageTolerance: request.maxSlippageBps / 100,
      // The current request API accepts protocols plus BEST_PRICE/FASTEST, not
      // a CLASSIC routing preference. AMM-only protocols and no-Permit2 should
      // produce CLASSIC; the response check below still fails closed.
      protocols: ["V2", "V3", "V4"],
    };
    const quoteResponse = await this.post("/quote", quoteRequest);
    const routing = String(quoteResponse.routing ?? object(quoteResponse.quote, "quote").routing ?? "").toUpperCase();
    if (routing !== "CLASSIC") {
      throw new UniswapApiError("UNISWAP_NON_ATOMIC_ROUTE", "Only CLASSIC atomic routes are accepted", 422, false);
    }
    if (quoteResponse.permitData != null) {
      throw new UniswapApiError("UNISWAP_PERMIT2_ROUTE", "Permit2 quote returned despite no-Permit2 mode", 502, false);
    }

    const quote = object(quoteResponse.quote, "quote");
    this.assertQuoteBinding(quote, controller, request);
    const output = object(quote.output, "quote.output");
    const quotedAmountOut = integer(output.amount, "quote.output.amount");
    const minimum = output.minimumAmount ?? quote.amountOutMinimum;
    const minAmountOut = minimum == null
      ? quotedAmountOut * BigInt(10_000 - request.maxSlippageBps) / 10_000n
      : integer(minimum, "quote.output.minimumAmount");
    if (minAmountOut > quotedAmountOut) {
      throw new UniswapApiError("UNISWAP_BAD_RESPONSE", "minimum output exceeds quoted output", 502, false);
    }

    const deadline = Math.floor(Date.now() / 1_000) + (this.options.quoteLifetimeSeconds ?? 30);
    const swapResponse = await this.post("/swap", {
      quote,
      simulateTransaction: true,
      deadline,
    });
    const swap = object(swapResponse.swap, "swap");
    const target = evmAddress(swap.to, "swap.to");
    const from = evmAddress(swap.from, "swap.from");
    const swapChainId = Number(swap.chainId);
    const value = swap.value == null ? 0n : BigInt(String(swap.value));
    if (target !== this.options.approvalProxy.toLowerCase()) {
      throw new UniswapApiError("UNISWAP_UNEXPECTED_TARGET", "Swap target is not the configured approval proxy", 502, false);
    }
    if (from !== controller.adapter.toLowerCase()) {
      throw new UniswapApiError("UNISWAP_UNEXPECTED_SWAPPER", "Swap transaction is not bound to the adapter", 502, false);
    }
    if (swapChainId !== this.options.chainId || value !== 0n) {
      throw new UniswapApiError("UNISWAP_WRONG_CHAIN", "Swap transaction has wrong chain or native value", 502, false);
    }
    const routeCalldata = calldata(swap.data);
    this.assertProxyCallBinding(routeCalldata, request, deadline);
    const adapterData = encodeAbiParameters(
      [{
        type: "tuple",
        components: [
          { name: "minAmountOut", type: "uint256" },
          { name: "deadline", type: "uint48" },
          { name: "callData", type: "bytes" },
        ],
      }],
      [{ minAmountOut, deadline, callData: routeCalldata }],
    );
    const executionHash = keccak256(encodeAbiParameters(
      [{ type: "uint256" }, { type: "bytes" }],
      [controller.adapterId, adapterData],
    ));
    const quoteHash = keccak256(stringToHex(stableJson({
      requestId: quoteResponse.requestId,
      routing,
      quote,
      swap: { to: target, from, data: routeCalldata, chainId: swapChainId, value: value.toString() },
    })));

    return {
      proposalId: randomUUID(),
      quoteId: randomUUID(),
      quoteHash,
      adapter: controller.adapter,
      approvalProxy: this.options.approvalProxy.toLowerCase() as Address,
      adapterId: controller.adapterId,
      fund: controller.fund,
      controller: profile.controller,
      chainId: this.options.chainId,
      tokenIn: request.tokenIn,
      tokenOut: request.tokenOut,
      amountIn: request.amountIn,
      quotedAmountOut,
      minAmountOut,
      routeCalldata,
      adapterData,
      executionHash,
      expiresAt: new Date(deadline * 1_000),
    };
  }

  private assertQuoteBinding(quote: JsonObject, controller: ControllerState, request: QuoteRequest): void {
    const input = object(quote.input, "quote.input");
    const output = object(quote.output, "quote.output");
    if (evmAddress(input.token, "quote.input.token") !== request.tokenIn.toLowerCase()) {
      throw new UniswapApiError("UNISWAP_TOKEN_MISMATCH", "Quote input token changed", 502, false);
    }
    if (evmAddress(output.token, "quote.output.token") !== request.tokenOut.toLowerCase()) {
      throw new UniswapApiError("UNISWAP_TOKEN_MISMATCH", "Quote output token changed", 502, false);
    }
    if (integer(input.amount, "quote.input.amount") !== request.amountIn) {
      throw new UniswapApiError("UNISWAP_AMOUNT_MISMATCH", "Quote input amount changed", 502, false);
    }
    const swapper = evmAddress(quote.swapper, "quote.swapper");
    const recipient = evmAddress(output.recipient ?? quote.recipient, "quote.output.recipient");
    if (swapper !== controller.adapter.toLowerCase() || recipient !== controller.fund.toLowerCase()) {
      throw new UniswapApiError("UNISWAP_RECIPIENT_MISMATCH", "Quote is not bound to adapter and Fund", 502, false);
    }
    const chainId = Number(quote.chainId ?? input.chainId);
    if (chainId !== this.options.chainId) {
      throw new UniswapApiError("UNISWAP_WRONG_CHAIN", "Quote is for another chain", 502, false);
    }
  }

  private assertProxyCallBinding(routeCalldata: Hex, request: QuoteRequest, deadline: number): void {
    let decoded: ReturnType<typeof decodeFunctionData<typeof approvalProxyAbi>>;
    try {
      decoded = decodeFunctionData({ abi: approvalProxyAbi, data: routeCalldata });
    } catch {
      throw new UniswapApiError(
        "UNISWAP_PROXY_CALL_MISMATCH",
        "Swap calldata is not the supported approval-proxy execute call",
        502,
        false,
      );
    }
    const [proxyRouter, proxyTokenIn, proxyAmountIn, , , proxyDeadline] = decoded.args;
    if (
      decoded.functionName !== "execute"
      || !eqAddress(proxyRouter, this.options.universalRouter)
      || !eqAddress(proxyTokenIn, request.tokenIn)
      || proxyAmountIn !== request.amountIn
      || proxyDeadline < BigInt(deadline)
    ) {
      throw new UniswapApiError(
        "UNISWAP_PROXY_CALL_MISMATCH",
        "Swap calldata router, spend fields or deadline differ from the quoted execution plan",
        502,
        false,
      );
    }
  }

  private async post(path: string, body: unknown): Promise<JsonObject> {
    let response: Response;
    try {
      response = await this.fetchImpl(new URL(path.replace(/^\//, ""), `${this.options.apiBaseUrl.replace(/\/$/, "")}/`), {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": this.options.apiKey,
          "x-permit2-disabled": "true",
          "x-universal-router-version": "2.1.1",
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(12_000),
      });
    } catch {
      throw new UniswapApiError("UNISWAP_UNAVAILABLE", "Uniswap Trading API is unavailable", 503, true);
    }
    if (!response.ok) {
      const retryable = response.status === 429 || response.status >= 500;
      const code = response.status === 401 ? "UNISWAP_UNAUTHORIZED"
        : response.status === 429 ? "UNISWAP_RATE_LIMITED"
          : response.status >= 500 ? "UNISWAP_UPSTREAM_ERROR" : "UNISWAP_REJECTED";
      throw new UniswapApiError(code, `Uniswap Trading API rejected the request (${response.status})`, retryable ? 503 : 422, retryable);
    }
    let json: unknown;
    try {
      json = await response.json();
    } catch {
      throw new UniswapApiError("UNISWAP_BAD_RESPONSE", "Uniswap response is not JSON", 502, false);
    }
    return object(json, "Uniswap response");
  }
}

function eqAddress(left: Address, right: Address): boolean {
  return left.toLowerCase() === right.toLowerCase();
}
