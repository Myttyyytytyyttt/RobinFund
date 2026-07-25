import { randomUUID } from "node:crypto";
import { createAgentkitClient, type AgentkitExtension } from "@worldcoin/agentkit";
import {
  decodeAbiParameters,
  decodeFunctionData,
  encodeAbiParameters,
  getAddress,
  keccak256,
  parseAbi,
  type Address,
  type Hex,
} from "viem";
import type {
  AgentSigner,
  ExecutionPlan,
  GraphProvenance,
  LocalSafetyConfig,
  QuoteInput,
  QuoteResult,
  TradeIntentV1,
  TradeTypedData,
  VaultContext,
} from "./types.js";

const approvalProxyAbi = parseAbi([
  "function execute(address router,address token,uint256 amount,bytes commands,bytes[] inputs,uint256 deadline)",
]);

export class NuvemSdkError extends Error {
  constructor(readonly code: string, message: string, readonly status?: number) {
    super(message);
  }
}

function address(value: unknown): Address {
  return getAddress(String(value)).toLowerCase() as Address;
}

function hex(value: unknown): Hex {
  return String(value) as Hex;
}

function provenance(value: Record<string, unknown>): GraphProvenance {
  return {
    deploymentId: String(value.deploymentId),
    chainId: Number(value.chainId),
    blockNumber: BigInt(String(value.blockNumber)),
    blockHash: value.blockHash == null ? null : hex(value.blockHash),
    blockTimestamp: new Date(String(value.blockTimestamp)),
    chainHeadBlock: BigInt(String(value.chainHeadBlock)),
    blockLag: BigInt(String(value.blockLag)),
    indexingErrors: false,
    observedAt: new Date(String(value.observedAt)),
    ageSeconds: Number(value.ageSeconds),
  };
}

function intent(value: Record<string, unknown>): TradeIntentV1 {
  return {
    agentId: hex(value.agentId),
    fund: address(value.fund),
    tokenIn: address(value.tokenIn),
    tokenOut: address(value.tokenOut),
    amountIn: BigInt(String(value.amountIn)),
    minAmountOut: BigInt(String(value.minAmountOut)),
    maxSlippageBps: Number(value.maxSlippageBps),
    policyHash: hex(value.policyHash),
    executionHash: hex(value.executionHash),
    evidenceHash: hex(value.evidenceHash),
    nonce: BigInt(String(value.nonce)),
    validAfter: Number(value.validAfter),
    deadline: Number(value.deadline),
  };
}

function plan(value: Record<string, unknown>): ExecutionPlan {
  return {
    proposalId: String(value.proposalId),
    quoteId: String(value.quoteId),
    quoteHash: hex(value.quoteHash),
    adapter: address(value.adapter),
    approvalProxy: address(value.approvalProxy),
    adapterId: BigInt(String(value.adapterId)),
    fund: address(value.fund),
    controller: address(value.controller),
    chainId: Number(value.chainId),
    tokenIn: address(value.tokenIn),
    tokenOut: address(value.tokenOut),
    amountIn: BigInt(String(value.amountIn)),
    quotedAmountOut: BigInt(String(value.quotedAmountOut)),
    minAmountOut: BigInt(String(value.minAmountOut)),
    routeCalldata: hex(value.routeCalldata),
    adapterData: hex(value.adapterData),
    executionHash: hex(value.executionHash),
    expiresAt: new Date(String(value.expiresAt)),
  };
}

function eq(left: string, right: string): boolean {
  return left.toLowerCase() === right.toLowerCase();
}

export function verifyExecutionPlanLocally(
  quote: QuoteResult,
  requested: QuoteInput,
  safety: LocalSafetyConfig,
): void {
  const plan = quote.executionPlan;
  const signed = quote.intent;
  if (plan.chainId !== safety.chainId || quote.typedData.domain.chainId !== safety.chainId) {
    throw new NuvemSdkError("WRONG_CHAIN", "Execution plan is for another chain");
  }
  if (!eq(plan.fund, safety.expectedFund) || !eq(signed.fund, safety.expectedFund)) {
    throw new NuvemSdkError("WRONG_FUND", "Execution plan recipient is not the expected Fund");
  }
  if (!eq(plan.controller, safety.expectedController) || !eq(quote.typedData.domain.verifyingContract, safety.expectedController)) {
    throw new NuvemSdkError("WRONG_CONTROLLER", "Typed data uses an unexpected controller");
  }
  if (safety.expectedAdapter && !eq(plan.adapter, safety.expectedAdapter)) {
    throw new NuvemSdkError("WRONG_ADAPTER", "Execution plan uses an unexpected adapter");
  }
  if (!eq(plan.approvalProxy, safety.expectedApprovalProxy)) {
    throw new NuvemSdkError("WRONG_PROXY", "Execution target is not the configured approval proxy");
  }
  if (
    !eq(plan.tokenIn, requested.tokenIn) || !eq(plan.tokenOut, requested.tokenOut)
    || plan.amountIn !== requested.amountIn || plan.minAmountOut <= 0n
    || !eq(signed.tokenIn, plan.tokenIn) || !eq(signed.tokenOut, plan.tokenOut)
    || signed.amountIn !== plan.amountIn
    || signed.minAmountOut !== plan.minAmountOut || signed.executionHash !== plan.executionHash
    || signed.evidenceHash !== requested.evidenceHash
  ) throw new NuvemSdkError("PLAN_MUTATED", "Execution plan differs from the requested trade");
  if (signed.maxSlippageBps !== requested.maxSlippageBps || signed.maxSlippageBps > safety.maxSlippageBps) {
    throw new NuvemSdkError("SLIPPAGE_POLICY", "Execution plan exceeds local slippage policy");
  }
  if (plan.expiresAt <= new Date() || signed.deadline * 1_000 > plan.expiresAt.getTime()) {
    throw new NuvemSdkError("QUOTE_EXPIRED", "Execution plan is expired or has an invalid deadline");
  }
  const [decoded] = decodeAbiParameters(
    [{ type: "tuple", components: [
      { name: "minAmountOut", type: "uint256" },
      { name: "deadline", type: "uint48" },
      { name: "callData", type: "bytes" },
    ] }],
    plan.adapterData,
  );
  if (decoded.minAmountOut !== plan.minAmountOut || Number(decoded.deadline) !== signed.deadline || decoded.callData !== plan.routeCalldata) {
    throw new NuvemSdkError("ADAPTER_DATA_MUTATED", "Adapter payload does not match the visible quote");
  }
  let proxyCall: ReturnType<typeof decodeFunctionData<typeof approvalProxyAbi>>;
  try {
    proxyCall = decodeFunctionData({ abi: approvalProxyAbi, data: plan.routeCalldata });
  } catch {
    throw new NuvemSdkError("PROXY_CALL_MUTATED", "Approval-proxy calldata uses an unsupported selector or encoding");
  }
  const [proxyRouter, proxyTokenIn, proxyAmountIn, , , proxyDeadline] = proxyCall.args;
  if (
    proxyCall.functionName !== "execute"
    || !eq(proxyRouter, safety.expectedUniversalRouter)
    || !eq(proxyTokenIn, plan.tokenIn)
    || proxyAmountIn !== plan.amountIn
    || proxyDeadline < BigInt(signed.deadline)
  ) {
    throw new NuvemSdkError("PROXY_CALL_MUTATED", "Approval-proxy router, spend fields or deadline differ from the signed trade");
  }
  const executionHash = keccak256(encodeAbiParameters(
    [{ type: "uint256" }, { type: "bytes" }],
    [plan.adapterId, plan.adapterData],
  ));
  if (!eq(executionHash, plan.executionHash)) {
    throw new NuvemSdkError("EXECUTION_HASH_MISMATCH", "Execution hash does not bind the adapter payload");
  }
}

export class NuvemAgentClient {
  private sessionToken: string | null = null;
  private sessionExpiresAt = 0;
  private connectInFlight: Promise<{ expiresAt: Date }> | null = null;

  constructor(
    readonly gatewayUrl: string,
    readonly agentId: Hex,
    readonly signer: AgentSigner,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async connect(): Promise<{ expiresAt: Date }> {
    if (this.sessionToken && this.sessionExpiresAt > Date.now() + 30_000) {
      return { expiresAt: new Date(this.sessionExpiresAt) };
    }
    if (this.connectInFlight) return this.connectInFlight;
    this.connectInFlight = this.openAgentKitSession();
    try {
      return await this.connectInFlight;
    } finally {
      this.connectInFlight = null;
    }
  }

  private async openAgentKitSession(): Promise<{ expiresAt: Date }> {
    const challenge = await this.request<{ agentkit: AgentkitExtension }>("/v1/agent-sessions/challenge", {
      method: "POST",
      body: { agentId: this.agentId },
    });
    const agentkit = createAgentkitClient({
      signer: {
        address: this.signer.address,
        chainId: `eip155:${this.signer.chainId}`,
        type: "eip191",
        signMessage: (message) => this.signer.signMessage(message),
      },
      fetch: this.fetchImpl,
    });
    const header = await agentkit.createHeader(challenge.agentkit);
    const session = await this.request<{ token: string; expiresAt: string }>("/v1/agent-sessions", {
      method: "POST",
      body: { agentId: this.agentId },
      headers: { "x-agentkit": header },
    });
    const expiresAt = new Date(session.expiresAt);
    if (!session.token || !Number.isFinite(expiresAt.getTime()) || expiresAt <= new Date()) {
      throw new NuvemSdkError("INVALID_SESSION", "Gateway returned an invalid AgentKit session");
    }
    this.sessionToken = session.token;
    this.sessionExpiresAt = expiresAt.getTime();
    return { expiresAt };
  }

  disconnect(): void {
    this.sessionToken = null;
    this.sessionExpiresAt = 0;
  }

  async context(): Promise<VaultContext> {
    const raw = await this.request<Record<string, unknown>>(`/v1/agents/${this.agentId}/context`, { method: "GET", session: true });
    const rawProvenance = raw.provenance as Record<string, unknown>;
    return {
      agentId: hex(raw.agentId),
      vault: address(raw.vault),
      controller: address(raw.controller),
      policyHash: hex(raw.policyHash),
      state: Number(raw.state),
      navWad: BigInt(String(raw.navWad)),
      navValid: raw.navValid === true,
      navUpdatedAt: raw.navUpdatedAt == null ? null : new Date(String(raw.navUpdatedAt)),
      navObservedAt: new Date(String(raw.navObservedAt)),
      controllerEnabled: raw.controllerEnabled === true,
      controllerPaused: raw.controllerPaused === true,
      agentStatus: raw.agentStatus == null ? null : Number(raw.agentStatus),
      backedUntil: raw.backedUntil == null ? null : new Date(String(raw.backedUntil)),
      holdings: (raw.holdings as Array<Record<string, unknown>>).map((item) => ({
        token: address(item.token),
        balance: BigInt(String(item.balance)),
        valueWad: BigInt(String(item.valueWad)),
        valid: item.valid === true,
        observedAt: new Date(String(item.observedAt)),
      })),
      recentTrades: raw.recentTrades as Array<Record<string, unknown>>,
      provenance: provenance(rawProvenance),
    };
  }

  async quote(input: QuoteInput, knownContext?: VaultContext): Promise<QuoteResult> {
    const context = knownContext ?? await this.context();
    const raw = await this.request<Record<string, unknown>>(`/v1/agents/${this.agentId}/quotes`, {
      method: "POST",
      session: true,
      body: {
        ...input,
        amountIn: input.amountIn.toString(),
        contextDeploymentId: context.provenance.deploymentId,
        contextBlockNumber: context.provenance.blockNumber.toString(),
      },
    });
    const executionPlan = plan(raw.executionPlan as Record<string, unknown>);
    const message = intent(raw.intent as Record<string, unknown>);
    const typed = raw.typedData as Record<string, unknown>;
    const typedData: TradeTypedData = {
      domain: {
        name: "Nuvem AgentVaultController",
        version: "1",
        chainId: Number((typed.domain as Record<string, unknown>).chainId),
        verifyingContract: address((typed.domain as Record<string, unknown>).verifyingContract),
      },
      types: (typed.types as TradeTypedData["types"]),
      primaryType: "TradeIntentV1",
      message,
    };
    return { executionPlan, intent: message, typedData, provenance: provenance(raw.provenance as Record<string, unknown>) };
  }

  async signAndSubmit(quote: QuoteResult, input: QuoteInput, safety: LocalSafetyConfig): Promise<Record<string, unknown>> {
    verifyExecutionPlanLocally(quote, input, safety);
    const signature = await this.signer.signTypedData(quote.typedData);
    return this.request<Record<string, unknown>>("/v1/intents", {
      method: "POST",
      session: true,
      body: { quoteId: quote.executionPlan.quoteId, intent: quote.intent, signature },
    });
  }

  async heartbeat(runtimeVersion: string, capabilities: string[]): Promise<void> {
    await this.request(`/v1/agents/${this.agentId}/heartbeat`, {
      method: "POST", session: true, body: { runtimeVersion, capabilities },
    });
  }

  async recordDecision(
    decision: "hold" | "rejected",
    summary: string,
    context: VaultContext,
    evidenceRefs: Array<Record<string, unknown>> = [],
  ): Promise<void> {
    await this.request(`/v1/agents/${this.agentId}/decisions`, {
      method: "POST",
      session: true,
      body: {
        decision,
        summary,
        evidenceRefs,
        contextDeploymentId: context.provenance.deploymentId,
        contextBlockNumber: context.provenance.blockNumber.toString(),
      },
    });
  }

  private async request<T = unknown>(
    path: string,
    options: {
      method: "GET" | "POST";
      body?: unknown;
      headers?: Record<string, string>;
      session?: boolean;
      idempotencyKey?: string;
      retrySession?: boolean;
    },
  ): Promise<T> {
    if (options.session && (!this.sessionToken || this.sessionExpiresAt <= Date.now() + 30_000)) {
      await this.connect();
    }
    const headers: Record<string, string> = { ...options.headers };
    if (options.body !== undefined) headers["content-type"] = "application/json";
    const idempotencyKey = options.idempotencyKey ?? randomUUID();
    if (options.method === "POST") headers["idempotency-key"] = idempotencyKey;
    if (options.session) {
      if (!this.sessionToken) throw new NuvemSdkError("NOT_CONNECTED", "AgentKit session could not be established");
      headers.authorization = `Bearer ${this.sessionToken}`;
    }
    const response = await this.fetchImpl(new URL(path, this.gatewayUrl), {
      method: options.method,
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body, (_, value) => typeof value === "bigint" ? value.toString() : value),
      signal: AbortSignal.timeout(20_000),
    });
    let value: T & { error?: { code?: string; message?: string } };
    try {
      value = await response.json() as T & { error?: { code?: string; message?: string } };
    } catch {
      throw new NuvemSdkError("INVALID_GATEWAY_RESPONSE", `Gateway returned non-JSON HTTP ${response.status}`, response.status);
    }
    if (!response.ok) {
      const code = value.error?.code ?? "GATEWAY_ERROR";
      if (
        options.session
        && options.retrySession !== false
        && response.status === 401
        && ["SESSION_EXPIRED", "SESSION_REQUIRED"].includes(code)
      ) {
        this.disconnect();
        await this.connect();
        return this.request<T>(path, {
          ...options,
          idempotencyKey,
          retrySession: false,
        });
      }
      throw new NuvemSdkError(code, value.error?.message ?? `Gateway returned ${response.status}`, response.status);
    }
    return value;
  }
}
