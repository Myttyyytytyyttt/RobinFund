import type { Address, Hex } from "viem";

export type AgentStatus = "pending_backing" | "active" | "paused" | "offline" | "retired";
export type IntentState =
  | "proposed"
  | "quoted"
  | "signed"
  | "queued"
  | "submitted"
  | "confirmed"
  | "rejected"
  | "expired"
  | "failed";

export interface AgentProfile {
  agentId: Hex;
  sponsor: Address;
  signer: Address;
  vault: Address | null;
  controller: Address | null;
  policyHash: Hex | null;
  policy: AgentPolicy;
  worldBacked: boolean;
  worldBackedUntil: Date | null;
  runtimeKind: "external" | "nuvem_reference";
  status: AgentStatus;
}

export interface AgentPolicy {
  maxTradeBps: number;
  maxConcentrationBps: number;
  dailyTurnoverBps: number;
  maxSlippageBps: number;
  maxTradesPerDay: number;
  minTradeInterval: number;
  maxIntentLifetime: number;
  allowedAssets: Address[];
}

export interface AgentSession {
  id: string;
  agentId: Hex;
  signer: Address;
  sponsor: Address;
  expiresAt: Date;
  revokedAt: Date | null;
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
  recentTrades: Array<{
    transactionHash: Hex;
    tokenIn: Address;
    tokenOut: Address;
    spent: bigint;
    received: bigint;
    timestamp: Date;
  }>;
  provenance: GraphProvenance;
}

export interface QuoteRequest {
  agentId: Hex;
  tokenIn: Address;
  tokenOut: Address;
  amountIn: bigint;
  maxSlippageBps: number;
  evidenceHash: Hex;
  reasoningHash: Hex;
  summary: string;
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

export interface IntentRecord {
  id: string;
  proposalId: string;
  quoteId: string;
  agentId: Hex;
  sponsor: Address;
  controller: Address;
  fund: Address;
  chainId: number;
  intent: TradeIntentV1;
  typedData: Record<string, unknown>;
  adapterData: Hex;
  signature: Hex;
  state: IntentState;
  transactionHash: Hex | null;
  blockNumber: bigint | null;
  failureCode: string | null;
  expiresAt: Date;
  createdAt: Date;
  updatedAt: Date;
}

export interface ExecutionJob {
  id: string;
  intentId: string;
  state: "queued" | "processing" | "submitted" | "confirmed" | "failed" | "dead_letter";
  attempts: number;
  availableAt: Date;
  transactionHash: Hex | null;
  signedTransaction: Hex | null;
  chainNonce: bigint | null;
}

export interface AgentEvent {
  cursor: string;
  type: "heartbeat" | "intent" | "receipt" | "policy" | "agent";
  agentId: Hex;
  occurredAt: Date;
  payload: Record<string, unknown>;
}

export interface AgentDecisionInput {
  agentId: Hex;
  vault: Address;
  decision: "hold" | "rejected";
  summary: string;
  evidenceRefs: Array<Record<string, unknown>>;
  policyResult: "not_evaluated" | "rejected";
  chainId: number;
}

export interface WorldAttestationRecord {
  agentId: Hex;
  sponsor: Address;
  signer: Address;
  backingHash: Hex;
  agentBookBlock: bigint;
  validUntil: Date;
  signature: Hex;
}

export interface ManagedSignerRecord {
  agentId: Hex;
  sponsor: Address;
  signer: Address;
  provisioningKey: string;
  provider: "local-derived-v1" | "kms-v1";
  status: "provisioned" | "bound" | "retired";
  createdAt: Date;
}

export interface WorldIdRequestRecord {
  id: string;
  agentId: Hex;
  sponsor: Address;
  signer: Address;
  rpNonceHash: Hex;
  signalHash: Hex;
  action: string;
  expiresAt: Date;
  consumedAt: Date | null;
}

export interface WorldIdAgentBinding {
  agentId: Hex;
  sponsor: Address;
  signer: Address;
  humanHash: Hex;
  verifiedAt: Date;
  revokedAt: Date | null;
}

export interface WorldIdVerificationInput {
  requestId: string;
  agentId: Hex;
  sponsor: Address;
  signer: Address;
  rpNonceHash: Hex;
  signalHash: Hex;
  humanHash: Hex;
  nullifierHash: Hex;
  proofHash: Hex;
  action: string;
  maxManagedAgents: number;
}

export interface WorldIdVerificationResult {
  accepted: boolean;
  reason: "verified" | "already_verified" | "sponsor_unverified" | "request_invalid" | "human_bound_elsewhere" | "managed_agent_limit";
  managedAgentCount: number;
  maxManagedAgents: number;
}

export type WorldIdentityEnvironment = "staging" | "production";

export type WorldIdentityAttribute =
  | { type: "document_type"; value: "passport" | "eid" | "mnc" }
  | { type: "minimum_age"; value: number };

export interface WorldIdentityPolicy {
  id: string;
  version: number;
  attributes: WorldIdentityAttribute[];
  hash: Hex;
  requireUserPresence: boolean;
}

export interface WorldIdentityRequestRecord {
  id: string;
  agentId: Hex;
  sponsor: Address;
  signer: Address;
  rpNonceHash: Hex;
  signalHash: Hex;
  appId: `app_${string}`;
  rpId: string;
  environment: WorldIdentityEnvironment;
  policyId: string;
  policyVersion: number;
  policyHash: Hex;
  attributes: WorldIdentityAttribute[];
  attributesHash: Hex;
  action: string;
  requireUserPresence: boolean;
  expiresAt: Date;
  consumedAt: Date | null;
}

export interface WorldIdentityAgentBinding {
  agentId: Hex;
  sponsorBindingId: string;
  sponsor: Address;
  signer: Address;
  subjectHash: Hex;
  nullifierHash: Hex;
  appId: `app_${string}`;
  rpId: string;
  environment: WorldIdentityEnvironment;
  policyId: string;
  policyVersion: number;
  policyHash: Hex;
  attributesHash: Hex;
  action: string;
  credentialIdentifier: string;
  issuerSchemaId: number;
  verifiedAt: Date;
  validUntil: Date;
  revokedAt: Date | null;
}

export interface WorldIdentitySponsorBinding {
  id: string;
  sponsor: Address;
  subjectHash: Hex;
  nullifierHash: Hex;
  appId: `app_${string}`;
  rpId: string;
  environment: WorldIdentityEnvironment;
  policyId: string;
  policyVersion: number;
  policyHash: Hex;
  attributesHash: Hex;
  action: string;
  credentialIdentifier: string;
  issuerSchemaId: number;
  firstVerifiedAt: Date;
  lastVerifiedAt: Date;
  validUntil: Date;
  revokedAt: Date | null;
}

export interface WorldIdentityVerificationInput {
  requestId: string;
  agentId: Hex;
  sponsor: Address;
  signer: Address;
  rpNonceHash: Hex;
  signalHash: Hex;
  appId: `app_${string}`;
  rpId: string;
  environment: WorldIdentityEnvironment;
  policyId: string;
  policyVersion: number;
  policyHash: Hex;
  attributesHash: Hex;
  action: string;
  subjectHash: Hex;
  nullifierHash: Hex;
  proofHash: Hex;
  credentialIdentifier: string;
  issuerSchemaId: number;
  verifiedAt: Date;
  validUntil: Date;
  maxManagedAgents: number;
}

export interface WorldIdentityVerificationResult {
  accepted: boolean;
  reason:
    | "verified"
    | "already_verified"
    | "sponsor_unverified"
    | "request_invalid"
    | "binding_conflict"
    | "human_bound_elsewhere"
    | "managed_agent_limit";
  binding: WorldIdentityAgentBinding | null;
  managedAgentCount: number;
  maxManagedAgents: number;
}

export type VaultJobState =
  | "requested"
  | "preparing"
  | "deploying_controller"
  | "deploying_fund"
  | "registering"
  | "awaiting_sponsor_bind"
  | "ready"
  | "failed";

export interface VaultDeploymentTransaction {
  step: "controller" | "fund" | "register";
  nonce: bigint;
  hash: Hex;
  serialized: Hex;
  contractAddress: Address | null;
}

export interface VaultDeploymentPlan {
  chainId: number;
  deployer: Address;
  controller: Address;
  fund: Address;
  transactions: VaultDeploymentTransaction[];
}

export interface VaultJobRecord {
  id: string;
  agentId: Hex;
  sponsor: Address;
  request: Record<string, unknown>;
  state: VaultJobState;
  controller: Address | null;
  fund: Address | null;
  stakeEscrow: Address | null;
  transactionHashes: Hex[];
  deploymentPlan: VaultDeploymentPlan | null;
  nonceStart: bigint | null;
  attempts: number;
  availableAt: Date;
  lockedBy: string | null;
  errorCode: string | null;
}

export interface IdempotencyResult {
  kind: "acquired" | "replay" | "conflict" | "processing";
  statusCode?: number;
  body?: unknown;
}
