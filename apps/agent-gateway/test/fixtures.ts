import type { Address, Hex } from "viem";
import type { AgentChainReader, ChainAgent, ControllerState } from "../src/chain.js";
import type { AgentPolicy, AgentProfile } from "../src/domain.js";

export const sponsor = "0x1000000000000000000000000000000000000001" as Address;
export const signer = "0x2000000000000000000000000000000000000002" as Address;
export const fund = "0x3000000000000000000000000000000000000003" as Address;
export const controllerAddress = "0x4000000000000000000000000000000000000004" as Address;
export const adapter = "0x5000000000000000000000000000000000000005" as Address;
export const registry = "0x6000000000000000000000000000000000000006" as Address;
export const tokenIn = "0x7000000000000000000000000000000000000007" as Address;
export const tokenOut = "0x8000000000000000000000000000000000000008" as Address;
export const stablecoin = "0x9000000000000000000000000000000000000009" as Address;
export const approvalProxy = "0x0000000085e102724e78ecd2f45dc9ca239affad" as Address;
export const universalRouter = "0x8876789976decbfcbbbe364623c63652db8c0904" as Address;
export const agentId = `0x${"11".repeat(32)}` as Hex;
export const policyHash = `0x${"22".repeat(32)}` as Hex;
export const evidenceHash = `0x${"33".repeat(32)}` as Hex;
export const reasoningHash = `0x${"44".repeat(32)}` as Hex;
export const executionHash = `0x${"55".repeat(32)}` as Hex;

export const policy: AgentPolicy = {
  maxTradeBps: 1_000,
  maxConcentrationBps: 3_500,
  dailyTurnoverBps: 5_000,
  maxSlippageBps: 75,
  maxTradesPerDay: 24,
  minTradeInterval: 300,
  maxIntentLifetime: 300,
  allowedAssets: [tokenOut],
};

export function profile(overrides: Partial<AgentProfile> = {}): AgentProfile {
  return {
    agentId,
    sponsor,
    signer,
    vault: fund,
    controller: controllerAddress,
    policyHash,
    policy,
    worldBacked: true,
    worldBackedUntil: new Date(Date.now() + 3_600_000),
    runtimeKind: "external",
    status: "active",
    ...overrides,
  };
}

export class FakeChain implements AgentChainReader {
  chainId = 4663;
  registryAddress = registry;
  blockNumber = 1_000n;
  backingNonce = 0n;
  worldVerifier = "0xa00000000000000000000000000000000000000a" as Address;
  bound = true;
  agent: ChainAgent = {
    sponsor,
    signer,
    backingHash: `0x${"aa".repeat(32)}` as Hex,
    agentBookBlock: 123n,
    backedUntil: Math.floor(Date.now() / 1_000) + 3_600,
    status: 1,
    active: true,
  };
  controller: ControllerState = {
    address: controllerAddress,
    agentId,
    sponsor,
    fund,
    policyHash,
    nextNonce: 0n,
    paused: false,
    adapterId: 7n,
    adapter,
  };

  async getAgent(): Promise<ChainAgent> { return this.agent; }
  async isControllerBound(): Promise<boolean> { return this.bound; }
  async getController(): Promise<ControllerState> { return this.controller; }
  async getBlockNumber(): Promise<bigint> { return this.blockNumber; }
  async getBackingNonce(): Promise<bigint> { return this.backingNonce; }
  async getWorldVerifier(): Promise<Address> { return this.worldVerifier; }
  async getFundProtection(): Promise<{ stakeEscrow: Address; stakeAvailable: bigint }> {
    return { stakeEscrow: "0xb00000000000000000000000000000000000000b", stakeAvailable: 2_000_000_000n };
  }
}
