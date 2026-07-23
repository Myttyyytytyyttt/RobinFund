import { randomUUID } from "node:crypto";
import type { Address, Hex } from "viem";
import type { AgentChainReader, ControllerState } from "./chain.js";
import type {
  AgentProfile,
  AgentSession,
  ExecutionPlan,
  IntentRecord,
  QuoteRequest,
  TradeIntentV1,
} from "./domain.js";
import type { ControlPlaneStore } from "./store.js";

export const tradeIntentTypes = {
  TradeIntentV1: [
    { name: "agentId", type: "bytes32" },
    { name: "fund", type: "address" },
    { name: "tokenIn", type: "address" },
    { name: "tokenOut", type: "address" },
    { name: "amountIn", type: "uint256" },
    { name: "minAmountOut", type: "uint256" },
    { name: "maxSlippageBps", type: "uint16" },
    { name: "policyHash", type: "bytes32" },
    { name: "executionHash", type: "bytes32" },
    { name: "evidenceHash", type: "bytes32" },
    { name: "nonce", type: "uint256" },
    { name: "validAfter", type: "uint48" },
    { name: "deadline", type: "uint48" },
  ],
} as const;

export interface TradeTypedData {
  domain: {
    name: "Nuvem AgentVaultController";
    version: "1";
    chainId: number;
    verifyingContract: Address;
  };
  types: typeof tradeIntentTypes;
  primaryType: "TradeIntentV1";
  message: TradeIntentV1;
}

export interface SignedIntentInput {
  quoteId: string;
  intent: TradeIntentV1;
  signature: Hex;
}

export type IntentSignatureVerifier = (
  signer: Address,
  typedData: TradeTypedData,
  signature: Hex,
) => Promise<boolean>;

export class IntentValidationError extends Error {
  constructor(readonly code: string, message: string, readonly status = 422) {
    super(message);
  }
}

export function buildTradeTypedData(
  chainId: number,
  controller: Address,
  intent: TradeIntentV1,
): TradeTypedData {
  return {
    domain: {
      name: "Nuvem AgentVaultController",
      version: "1",
      chainId,
      verifyingContract: controller,
    },
    types: tradeIntentTypes,
    primaryType: "TradeIntentV1",
    message: intent,
  };
}

export function buildIntentDraft(
  profile: AgentProfile,
  controller: ControllerState,
  request: QuoteRequest,
  plan: ExecutionPlan,
  now = new Date(),
): { intent: TradeIntentV1; typedData: TradeTypedData } {
  if (!profile.policyHash) throw new IntentValidationError("POLICY_MISSING", "Agent policy is not active", 409);
  const validAfter = Math.floor(now.getTime() / 1_000);
  const deadline = Math.min(
    Math.floor(plan.expiresAt.getTime() / 1_000),
    validAfter + profile.policy.maxIntentLifetime,
  );
  if (deadline <= validAfter) throw new IntentValidationError("QUOTE_EXPIRED", "Quote expired", 409);
  const intent: TradeIntentV1 = {
    agentId: request.agentId,
    fund: plan.fund,
    tokenIn: plan.tokenIn,
    tokenOut: plan.tokenOut,
    amountIn: plan.amountIn,
    minAmountOut: plan.minAmountOut,
    maxSlippageBps: request.maxSlippageBps,
    policyHash: profile.policyHash,
    executionHash: plan.executionHash,
    evidenceHash: request.evidenceHash,
    nonce: controller.nextNonce,
    validAfter,
    deadline,
  };
  return { intent, typedData: buildTradeTypedData(plan.chainId, plan.controller, intent) };
}

function sameAddress(left: Address, right: Address): boolean {
  return left.toLowerCase() === right.toLowerCase();
}

function sameHex(left: Hex, right: Hex): boolean {
  return left.toLowerCase() === right.toLowerCase();
}

export class IntentService {
  constructor(
    private readonly store: ControlPlaneStore,
    private readonly chain: AgentChainReader,
    private readonly verifySignature: IntentSignatureVerifier,
  ) {}

  async accept(session: AgentSession, input: SignedIntentInput): Promise<IntentRecord> {
    const stored = await this.store.getExecutionPlan(input.quoteId);
    if (!stored) throw new IntentValidationError("UNKNOWN_QUOTE", "Execution plan was not found", 404);
    const { request, plan } = stored;
    if (!sameHex(session.agentId, request.agentId) || !sameHex(session.agentId, input.intent.agentId)) {
      throw new IntentValidationError("AGENT_MISMATCH", "Session cannot submit this agent's intent", 403);
    }
    if (plan.expiresAt <= new Date()) throw new IntentValidationError("QUOTE_EXPIRED", "Execution plan expired", 409);

    const profile = await this.store.getAgentProfile(session.agentId);
    if (!profile?.controller || !profile.vault || !profile.policyHash) {
      throw new IntentValidationError("AGENT_VAULT_NOT_READY", "Agent vault is not active", 409);
    }
    const [chainAgent, controller, bound] = await Promise.all([
      this.chain.getAgent(session.agentId),
      this.chain.getController(profile.controller),
      this.chain.isControllerBound(session.agentId, profile.controller),
    ]);
    if (!chainAgent.active || !bound || controller.paused) {
      throw new IntentValidationError("AGENT_INACTIVE", "Agent or controller is inactive", 409);
    }
    if (!sameAddress(chainAgent.signer, session.signer) || !sameAddress(profile.signer, session.signer)) {
      throw new IntentValidationError("SIGNER_ROTATED", "Agent signer changed after session creation", 409);
    }
    this.assertExactBinding(input.intent, request, plan, profile, controller);

    const now = Math.floor(Date.now() / 1_000);
    if (
      input.intent.validAfter > now + 15
      || input.intent.deadline < now
      || input.intent.deadline > Math.floor(plan.expiresAt.getTime() / 1_000)
      || input.intent.deadline <= input.intent.validAfter
      || input.intent.deadline - input.intent.validAfter > profile.policy.maxIntentLifetime
    ) throw new IntentValidationError("INTENT_EXPIRED", "Intent timing is outside policy");
    if (input.intent.nonce !== controller.nextNonce) {
      throw new IntentValidationError("NONCE_MISMATCH", "Controller nonce changed; request a new quote", 409);
    }

    const typedData = buildTradeTypedData(plan.chainId, plan.controller, input.intent);
    if (!await this.verifySignature(session.signer, typedData, input.signature)) {
      throw new IntentValidationError("INVALID_INTENT_SIGNATURE", "EIP-712 signature is invalid", 401);
    }

    const createdAt = new Date();
    const record: IntentRecord = {
      id: randomUUID(),
      proposalId: plan.proposalId,
      quoteId: plan.quoteId,
      agentId: session.agentId,
      sponsor: profile.sponsor,
      controller: plan.controller,
      fund: plan.fund,
      chainId: plan.chainId,
      intent: input.intent,
      typedData: typedData as unknown as Record<string, unknown>,
      adapterData: plan.adapterData,
      signature: input.signature,
      state: "signed",
      transactionHash: null,
      blockNumber: null,
      failureCode: null,
      expiresAt: new Date(input.intent.deadline * 1_000),
      createdAt,
      updatedAt: createdAt,
    };
    try {
      await this.store.saveIntent(record);
      await this.store.enqueueIntent(record.id);
    } catch (error) {
      if (String(error).includes("controller_address") || String(error).includes("unique")) {
        throw new IntentValidationError("NONCE_ALREADY_QUEUED", "This controller nonce is already queued", 409);
      }
      throw error;
    }
    record.state = "queued";
    return record;
  }

  private assertExactBinding(
    intent: TradeIntentV1,
    request: QuoteRequest,
    plan: ExecutionPlan,
    profile: AgentProfile,
    controller: ControllerState,
  ): void {
    if (
      !sameHex(intent.agentId, request.agentId)
      || !sameAddress(intent.fund, plan.fund)
      || !sameAddress(intent.tokenIn, plan.tokenIn)
      || !sameAddress(intent.tokenOut, plan.tokenOut)
      || intent.amountIn !== plan.amountIn
      || intent.minAmountOut !== plan.minAmountOut
      || intent.maxSlippageBps !== request.maxSlippageBps
      || !sameHex(intent.policyHash, profile.policyHash as Hex)
      || !sameHex(intent.policyHash, controller.policyHash)
      || !sameHex(intent.executionHash, plan.executionHash)
      || !sameHex(intent.evidenceHash, request.evidenceHash)
      || !sameAddress(plan.controller, controller.address)
      || !sameAddress(plan.fund, controller.fund)
      || plan.adapterId !== controller.adapterId
      || !sameAddress(plan.adapter, controller.adapter)
    ) throw new IntentValidationError("INTENT_BINDING_MISMATCH", "Signed intent differs from quoted execution plan");
  }
}

export const executeTradeAbi = [{
  type: "function",
  name: "executeTrade",
  stateMutability: "nonpayable",
  inputs: [
    {
      name: "intent",
      type: "tuple",
      components: tradeIntentTypes.TradeIntentV1.map((field) => ({ name: field.name, type: field.type })),
    },
    { name: "adapterData", type: "bytes" },
    { name: "signature", type: "bytes" },
  ],
  outputs: [],
}] as const;
