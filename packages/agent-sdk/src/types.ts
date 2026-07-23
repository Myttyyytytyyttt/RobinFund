import type { Address, Hex } from "viem";

export interface AgentSigner {
  address: Address;
  chainId: number;
  signMessage(message: string): Promise<Hex>;
  signTypedData(typedData: TradeTypedData): Promise<Hex>;
}

export interface TradeIntentV1 {
  agentId: Hex;
  fund: Address;
  tokenIn: Address;
  tokenOut: Address;
  amountIn: bigint;
  minAmountOut: bigint;
  maxSlippageBps: number;
  policyHash: Hex;
  executionHash: Hex;
  evidenceHash: Hex;
  nonce: bigint;
  validAfter: number;
  deadline: number;
}

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

export interface GraphProvenance {
  deploymentId: string;
  blockNumber: bigint;
  blockTimestamp: Date;
  chainHeadBlock: bigint;
  observedAt: Date;
}

export interface VaultContext {
  agentId: Hex;
  vault: Address;
  controller: Address;
  policyHash: Hex;
  navWad: bigint;
  holdings: Array<{ token: Address; balance: bigint; valueWad: bigint }>;
  recentTrades: Array<Record<string, unknown>>;
  provenance: GraphProvenance;
}

export interface ExecutionPlan {
  proposalId: string;
  quoteId: string;
  quoteHash: Hex;
  adapter: Address;
  approvalProxy: Address;
  adapterId: bigint;
  fund: Address;
  controller: Address;
  chainId: number;
  tokenIn: Address;
  tokenOut: Address;
  amountIn: bigint;
  quotedAmountOut: bigint;
  minAmountOut: bigint;
  routeCalldata: Hex;
  adapterData: Hex;
  executionHash: Hex;
  expiresAt: Date;
}

export interface QuoteInput {
  tokenIn: Address;
  tokenOut: Address;
  amountIn: bigint;
  maxSlippageBps: number;
  evidenceHash: Hex;
  reasoningHash: Hex;
  summary: string;
}

export interface QuoteResult {
  executionPlan: ExecutionPlan;
  intent: TradeIntentV1;
  typedData: TradeTypedData;
  provenance: GraphProvenance;
}

export interface LocalSafetyConfig {
  chainId: number;
  expectedFund: Address;
  expectedController: Address;
  expectedAdapter?: Address;
  expectedApprovalProxy: Address;
  expectedUniversalRouter: Address;
  maxSlippageBps: number;
}
