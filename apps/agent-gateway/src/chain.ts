import {
  createPublicClient,
  http,
  type Address,
  type Hex,
  type PublicClient,
} from "viem";
import { defineChain } from "viem";

const makePublicClient = createPublicClient as unknown as (
  config: unknown,
) => PublicClient<any, any, any>;

export function createRobinhoodChain(chainId: number, rpcUrl: string) {
  if (!Number.isSafeInteger(chainId) || chainId <= 0) throw new Error("invalid chain ID");
  return defineChain({
    id: chainId,
    name: chainId === 46_630 ? "Robinhood Chain Testnet" : "Robinhood Chain",
    nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
    rpcUrls: { default: { http: [rpcUrl] } },
  });
}

export const robinhoodChain = createRobinhoodChain(4_663, "https://rpc.robinhoodchain.com");

export interface ChainAgent {
  sponsor: Address;
  signer: Address;
  backingHash: Hex;
  agentBookBlock: bigint;
  backedUntil: number;
  status: number;
  active: boolean;
}

export interface ControllerState {
  address: Address;
  agentId: Hex;
  sponsor: Address;
  fund: Address;
  policyHash: Hex;
  nextNonce: bigint;
  paused: boolean;
  adapterId: bigint;
  adapter: Address;
}

export interface FundProtectionState {
  stakeEscrow: Address;
  stakeAvailable: bigint;
}

export interface AgentChainReader {
  chainId: number;
  registryAddress: Address;
  getAgent(agentId: Hex): Promise<ChainAgent>;
  isControllerBound(agentId: Hex, controller: Address): Promise<boolean>;
  getController(controller: Address): Promise<ControllerState>;
  getBackingNonce(agentId: Hex): Promise<bigint>;
  getWorldVerifier(): Promise<Address>;
  getFundProtection(fund: Address): Promise<FundProtectionState>;
  getBlockNumber(): Promise<bigint>;
}

const agentRegistryAbi = [
  {
    type: "function",
    name: "getAgent",
    stateMutability: "view",
    inputs: [{ name: "agentId", type: "bytes32" }],
    outputs: [{
      name: "agent",
      type: "tuple",
      components: [
        { name: "sponsor", type: "address" },
        { name: "signer", type: "address" },
        { name: "backingHash", type: "bytes32" },
        { name: "agentBookBlock", type: "uint64" },
        { name: "backedUntil", type: "uint48" },
        { name: "status", type: "uint8" },
        { name: "metadataURI", type: "string" },
      ],
    }],
  },
  { type: "function", name: "backingNonce", stateMutability: "view", inputs: [{ type: "bytes32" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "WORLD_VERIFIER", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  {
    type: "function",
    name: "isActive",
    stateMutability: "view",
    inputs: [{ name: "agentId", type: "bytes32" }],
    outputs: [{ type: "bool" }],
  },
  {
    type: "function",
    name: "controllers",
    stateMutability: "view",
    inputs: [{ type: "bytes32" }, { type: "address" }],
    outputs: [{ type: "bool" }],
  },
] as const;

const controllerAbi = [
  { type: "function", name: "AGENT_ID", stateMutability: "view", inputs: [], outputs: [{ type: "bytes32" }] },
  { type: "function", name: "SPONSOR", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  { type: "function", name: "FUND", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  { type: "function", name: "policyHash", stateMutability: "view", inputs: [], outputs: [{ type: "bytes32" }] },
  { type: "function", name: "nextNonce", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "paused", stateMutability: "view", inputs: [], outputs: [{ type: "bool" }] },
  { type: "function", name: "TRADE_ADAPTER_ID", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "TRADE_ADAPTER", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
] as const;

const fundProtectionAbi = [
  { type: "function", name: "stakeEscrow", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
] as const;
const stakeEscrowAbi = [
  { type: "function", name: "stakeAvailable", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
] as const;

export class ViemAgentChainReader implements AgentChainReader {
  readonly chainId: number;
  readonly client: PublicClient<any, any, any>;

  constructor(readonly registryAddress: Address, rpcUrl: string, chainId = robinhoodChain.id) {
    const chain = createRobinhoodChain(chainId, rpcUrl);
    this.chainId = chain.id;
    // Vercel's function compiler expands viem's full token/action generic graph here and
    // can hit TS2589 even though the runtime shape is a standard PublicClient.
    this.client = makePublicClient({ chain, transport: http(rpcUrl, { retryCount: 2 }) });
  }

  async getAgent(agentId: Hex): Promise<ChainAgent> {
    const [agent, active] = await Promise.all([
      this.client.readContract({ address: this.registryAddress, abi: agentRegistryAbi, functionName: "getAgent", args: [agentId] }),
      this.client.readContract({ address: this.registryAddress, abi: agentRegistryAbi, functionName: "isActive", args: [agentId] }),
    ]);
    return {
      sponsor: agent.sponsor.toLowerCase() as Address,
      signer: agent.signer.toLowerCase() as Address,
      backingHash: agent.backingHash,
      agentBookBlock: agent.agentBookBlock,
      backedUntil: Number(agent.backedUntil),
      status: Number(agent.status),
      active,
    };
  }

  async isControllerBound(agentId: Hex, controller: Address): Promise<boolean> {
    return this.client.readContract({
      address: this.registryAddress,
      abi: agentRegistryAbi,
      functionName: "controllers",
      args: [agentId, controller],
    });
  }

  async getController(controller: Address): Promise<ControllerState> {
    const contracts = ["AGENT_ID", "SPONSOR", "FUND", "policyHash", "nextNonce", "paused", "TRADE_ADAPTER_ID", "TRADE_ADAPTER"]
      .map((functionName) => ({ address: controller, abi: controllerAbi, functionName })) as never;
    const results = await this.client.multicall({ contracts, allowFailure: false });
    return {
      address: controller.toLowerCase() as Address,
      agentId: results[0] as Hex,
      sponsor: String(results[1]).toLowerCase() as Address,
      fund: String(results[2]).toLowerCase() as Address,
      policyHash: results[3] as Hex,
      nextNonce: results[4] as bigint,
      paused: results[5] as boolean,
      adapterId: results[6] as bigint,
      adapter: String(results[7]).toLowerCase() as Address,
    };
  }

  async getBlockNumber(): Promise<bigint> {
    return this.client.getBlockNumber();
  }

  async getBackingNonce(agentId: Hex): Promise<bigint> {
    return this.client.readContract({ address: this.registryAddress, abi: agentRegistryAbi, functionName: "backingNonce", args: [agentId] });
  }

  async getWorldVerifier(): Promise<Address> {
    return (await this.client.readContract({ address: this.registryAddress, abi: agentRegistryAbi, functionName: "WORLD_VERIFIER" })).toLowerCase() as Address;
  }

  async getFundProtection(fund: Address): Promise<FundProtectionState> {
    const stakeEscrow = (await this.client.readContract({
      address: fund,
      abi: fundProtectionAbi,
      functionName: "stakeEscrow",
    })).toLowerCase() as Address;
    const stakeAvailable = await this.client.readContract({
      address: stakeEscrow,
      abi: stakeEscrowAbi,
      functionName: "stakeAvailable",
    });
    return { stakeEscrow, stakeAvailable };
  }
}

export { agentRegistryAbi, controllerAbi };
