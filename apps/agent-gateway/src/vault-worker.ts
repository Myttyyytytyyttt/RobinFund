import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  createPublicClient,
  encodeDeployData,
  encodeFunctionData,
  getAddress,
  getContractAddress,
  http,
  keccak256,
  parseAbi,
  type Abi,
  type Address,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { z } from "zod";
import type { AgentChainReader } from "./chain.js";
import { createRobinhoodChain } from "./chain.js";
import type { VaultWorkerConfig } from "./config.js";
import type {
  VaultDeploymentPlan,
  VaultDeploymentTransaction,
  VaultJobRecord,
  VaultJobState,
} from "./domain.js";
import type { ControlPlaneStore } from "./store.js";

const addressSchema = z.string().transform((value, context) => {
  try { return getAddress(value).toLowerCase() as Address; }
  catch {
    context.addIssue({ code: "custom", message: "invalid address" });
    return z.NEVER;
  }
});
const hex32Schema = z.string().regex(/^0x[0-9a-fA-F]{64}$/).transform((value) => value.toLowerCase() as Hex);
const vaultRequestSchema = z.object({
  agentId: hex32Schema,
  signer: addressSchema,
  policy: z.object({
    maxTradeBps: z.number().int().min(100).max(2_000),
    maxConcentrationBps: z.number().int().min(1_000).max(5_000),
    dailyTurnoverBps: z.number().int().min(500).max(10_000),
    maxSlippageBps: z.number().int().min(10).max(100),
    maxTradesPerDay: z.number().int().min(1).max(200),
    minTradeInterval: z.number().int().min(60).max(3_600),
    maxIntentLifetime: z.number().int().min(1).max(300),
    allowedAssets: z.array(addressSchema).min(1).max(32),
  }),
  economy: z.object({
    name: z.string().min(3).max(48),
    symbol: z.string().regex(/^[A-Z0-9]{2,8}$/),
    initialStake: z.string().regex(/^\d+(?:\.\d{1,6})?$/),
    perfFeeBps: z.number().int().min(0).max(3_000),
    feeMinBps: z.number().int().min(0).max(500),
    feeMaxBps: z.number().int().min(0).max(500),
    managerEntryShareBps: z.number().int().min(0).max(5_000),
    kFactor: z.number().int().min(1).max(25),
    periodDays: z.number().int().min(7).max(90),
    cooldownHours: z.number().int().min(1).max(168),
  }).refine((value) => value.feeMinBps <= value.feeMaxBps, "entry fee range is inverted"),
});

type VaultRequest = z.infer<typeof vaultRequestSchema>;
type Artifact = {
  abi: Abi;
  bytecode: {
    object: Hex;
    linkReferences?: Record<string, Record<string, Array<{ start: number; length: number }>>>;
  };
};

export interface DeploymentReceipt {
  status: "success" | "reverted";
  blockNumber: bigint;
  blockHash: Hex;
}

export interface VaultDeploymentTransport {
  address: Address;
  pendingNonce(): Promise<bigint>;
  preflight(job: VaultJobRecord): Promise<void>;
  prepare(job: VaultJobRecord, nonceStart: bigint): Promise<VaultDeploymentPlan>;
  broadcast(serialized: Hex): Promise<Hex>;
  receipt(hash: Hex): Promise<DeploymentReceipt | null>;
  headBlock(): Promise<bigint>;
  canonicalBlockHash(blockNumber: bigint): Promise<Hex>;
  verifyDeployment(plan: VaultDeploymentPlan): Promise<Address>;
}

function linkBytecode(artifact: Artifact, library: Address): Hex {
  let object = artifact.bytecode.object.slice(2);
  const references = artifact.bytecode.linkReferences ?? {};
  let replacements = 0;
  for (const file of Object.values(references)) {
    for (const positions of Object.values(file)) {
      for (const position of positions) {
        if (position.length !== 20) throw new Error("unsupported library link length");
        const start = position.start * 2;
        object = `${object.slice(0, start)}${library.slice(2).toLowerCase()}${object.slice(start + 40)}`;
        replacements++;
      }
    }
  }
  if (replacements === 0 || object.includes("__$")) throw new Error("Fund bytecode was not fully linked to NAVLib");
  return `0x${object}` as Hex;
}

function artifact(directory: string, relative: string): Artifact {
  return JSON.parse(readFileSync(resolve(directory, relative), "utf8")) as Artifact;
}

function bufferedGas(value: bigint): bigint {
  return value * 125n / 100n + 50_000n;
}

const registryAbi = parseAbi([
  "function owner() view returns (address)",
  "function register(address fund,address manager)",
  "function isFund(address fund) view returns (bool)",
]);
const fundAbi = parseAbi([
  "function MANAGER() view returns (address)",
  "function stakeEscrow() view returns (address)",
]);

export class ViemVaultDeploymentTransport implements VaultDeploymentTransport {
  readonly address: Address;
  private readonly account;
  private readonly client;
  private readonly chain;
  private readonly controllerArtifact: Artifact;
  private readonly fundArtifact: Artifact;
  private readonly linkedFundBytecode: Hex;

  constructor(private readonly config: VaultWorkerConfig) {
    this.account = privateKeyToAccount(config.DEPLOY_OPERATOR_PRIVATE_KEY);
    this.address = this.account.address.toLowerCase() as Address;
    this.chain = createRobinhoodChain(config.RH_CHAIN_ID, config.RH_RPC_URL);
    this.client = createPublicClient({ chain: this.chain, transport: http(config.RH_RPC_URL, { retryCount: 2 }) });
    const artifacts = resolve(process.cwd(), config.CONTRACT_ARTIFACTS_DIR);
    this.controllerArtifact = artifact(artifacts, "AgentVaultController.sol/AgentVaultController.json");
    this.fundArtifact = artifact(artifacts, "Fund.sol/Fund.json");
    this.linkedFundBytecode = linkBytecode(this.fundArtifact, config.NAV_LIB_ADDRESS);
  }

  async pendingNonce(): Promise<bigint> {
    return BigInt(await this.client.getTransactionCount({ address: this.address, blockTag: "pending" }));
  }

  async preflight(job: VaultJobRecord): Promise<void> {
    const parsed = vaultRequestSchema.safeParse(job.request);
    if (!parsed.success) throw new VaultDeploymentError("INVALID_VAULT_JOB", parsed.error.issues[0]?.message ?? "Invalid vault request", false);
    const request = parsed.data;
    if (request.agentId !== job.agentId || request.signer !== (await this.readAgentSigner(job.agentId))) {
      throw new VaultDeploymentError("AGENT_JOB_DRIFT", "Vault job differs from AgentRegistry", false);
    }
    if (request.policy.allowedAssets.some((asset) => !this.config.AGENT_ASSETS.some((allowed) => allowed.toLowerCase() === asset.toLowerCase()))) {
      throw new VaultDeploymentError("ASSET_NOT_CONFIGURED", "Job contains an asset outside the deployment allowlist", false);
    }
    const [owner, navCode, adapterCode] = await Promise.all([
      this.client.readContract({ address: this.config.FUND_REGISTRY_ADDRESS, abi: registryAbi, functionName: "owner" }),
      this.client.getBytecode({ address: this.config.NAV_LIB_ADDRESS }),
      this.client.getBytecode({ address: this.config.UNISWAP_API_ADAPTER_ADDRESS }),
    ]);
    if (owner.toLowerCase() !== this.address) throw new VaultDeploymentError("OPERATOR_NOT_FUND_REGISTRY_OWNER", "Deployment operator cannot register Funds", false);
    if (!navCode || !adapterCode) throw new VaultDeploymentError("SHARED_CONTRACT_MISSING", "NAVLib or Uniswap API adapter is not deployed", false);
  }

  async prepare(job: VaultJobRecord, nonceStart: bigint): Promise<VaultDeploymentPlan> {
    const parsed = vaultRequestSchema.safeParse(job.request);
    if (!parsed.success) throw new VaultDeploymentError("INVALID_VAULT_JOB", parsed.error.issues[0]?.message ?? "Invalid vault request", false);
    const request = parsed.data;
    const controller = getContractAddress({ from: this.address, nonce: nonceStart });
    const fund = getContractAddress({ from: this.address, nonce: nonceStart + 1n });
    const controllerData = encodeDeployData({
      abi: this.controllerArtifact.abi,
      bytecode: this.controllerArtifact.bytecode.object,
      args: [
        this.config.AGENT_REGISTRY_ADDRESS,
        this.config.TOKEN_REGISTRY_ADDRESS,
        request.agentId,
        job.sponsor,
        this.config.UNISWAP_API_ADAPTER_ID,
        this.config.UNISWAP_API_ADAPTER_ADDRESS,
        request.policy,
        [...request.policy.allowedAssets].sort((a, b) => a.localeCompare(b)),
      ],
    });
    const fundData = encodeDeployData({
      abi: this.fundArtifact.abi,
      bytecode: this.linkedFundBytecode,
      args: [
        this.config.TOKEN_REGISTRY_ADDRESS,
        this.config.ELIGIBILITY_GATE_ADDRESS,
        this.config.ADAPTER_REGISTRY_ADDRESS,
        this.config.GUARDIAN_ADDRESS,
        controller,
        this.config.KEEPER_ADDRESS,
        this.config.PROTOCOL_TREASURY_ADDRESS,
        {
          perfFeeBps: request.economy.perfFeeBps,
          feeMinBps: request.economy.feeMinBps,
          feeMaxBps: request.economy.feeMaxBps,
          managerEntryShareBps: request.economy.managerEntryShareBps,
          kFactor: request.economy.kFactor,
          period: request.economy.periodDays * 86_400,
          withdrawCooldown: request.economy.cooldownHours * 3_600,
        },
        request.economy.name,
        request.economy.symbol,
      ],
    });
    const registerData = encodeFunctionData({ abi: registryAbi, functionName: "register", args: [fund, controller] });
    const [controllerGas, fundGas, registerGas, fees] = await Promise.all([
      this.client.estimateGas({ account: this.address, data: controllerData }),
      this.client.estimateGas({ account: this.address, data: fundData }),
      this.client.estimateGas({ account: this.address, to: this.config.FUND_REGISTRY_ADDRESS, data: registerData }),
      this.client.estimateFeesPerGas(),
    ]);
    const priority = (fees.maxPriorityFeePerGas ?? 1_000_000n) * 2n;
    const maximum = (fees.maxFeePerGas ?? await this.client.getGasPrice()) * 4n;
    const sign = async (
      step: VaultDeploymentTransaction["step"],
      nonce: bigint,
      data: Hex,
      gas: bigint,
      to: Address | undefined,
      contractAddress: Address | null,
    ): Promise<VaultDeploymentTransaction> => {
      if (nonce > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("nonce exceeds safe integer range");
      const serialized = await this.account.signTransaction({
        chainId: this.chain.id,
        type: "eip1559",
        nonce: Number(nonce),
        gas: bufferedGas(gas),
        maxFeePerGas: maximum,
        maxPriorityFeePerGas: priority,
        value: 0n,
        data,
        ...(to ? { to } : {}),
      });
      return { step, nonce, serialized, hash: keccak256(serialized), contractAddress };
    };
    const transactions = await Promise.all([
      sign("controller", nonceStart, controllerData, controllerGas, undefined, controller),
      sign("fund", nonceStart + 1n, fundData, fundGas, undefined, fund),
      sign("register", nonceStart + 2n, registerData, registerGas, this.config.FUND_REGISTRY_ADDRESS, null),
    ]);
    return { chainId: this.chain.id, deployer: this.address, controller, fund, transactions };
  }

  async broadcast(serialized: Hex): Promise<Hex> {
    return this.client.sendRawTransaction({ serializedTransaction: serialized });
  }

  async receipt(hash: Hex): Promise<DeploymentReceipt | null> {
    try {
      const receipt = await this.client.getTransactionReceipt({ hash });
      return { status: receipt.status, blockNumber: receipt.blockNumber, blockHash: receipt.blockHash };
    } catch (error) {
      const message = String(error).toLowerCase();
      if (message.includes("not found") || message.includes("could not be found")) return null;
      throw error;
    }
  }

  async headBlock(): Promise<bigint> { return this.client.getBlockNumber(); }
  async canonicalBlockHash(blockNumber: bigint): Promise<Hex> { return (await this.client.getBlock({ blockNumber })).hash; }

  async verifyDeployment(plan: VaultDeploymentPlan): Promise<Address> {
    const [controllerCode, fundCode, registered, manager, stakeEscrow] = await Promise.all([
      this.client.getBytecode({ address: plan.controller }),
      this.client.getBytecode({ address: plan.fund }),
      this.client.readContract({ address: this.config.FUND_REGISTRY_ADDRESS, abi: registryAbi, functionName: "isFund", args: [plan.fund] }),
      this.client.readContract({ address: plan.fund, abi: fundAbi, functionName: "MANAGER" }),
      this.client.readContract({ address: plan.fund, abi: fundAbi, functionName: "stakeEscrow" }),
    ]);
    if (!controllerCode || !fundCode || !registered || manager.toLowerCase() !== plan.controller.toLowerCase()) {
      throw new VaultDeploymentError("DEPLOYMENT_VERIFICATION_FAILED", "Deployed Fund/controller linkage is invalid", false);
    }
    return stakeEscrow.toLowerCase() as Address;
  }

  private async readAgentSigner(agentId: Hex): Promise<Address> {
    const result = await this.client.readContract({
      address: this.config.AGENT_REGISTRY_ADDRESS,
      abi: parseAbi(["function signerOf(bytes32 agentId) view returns (address)"]),
      functionName: "signerOf",
      args: [agentId],
    });
    return result.toLowerCase() as Address;
  }
}

export class VaultDeploymentError extends Error {
  constructor(readonly code: string, message: string, readonly retryable: boolean) { super(message); }
}

export interface VaultDeploymentWorkerOptions {
  workerId: string;
  confirmations: number;
  now?: () => Date;
}

export class VaultDeploymentWorker {
  private readonly now: () => Date;

  constructor(
    private readonly store: ControlPlaneStore,
    private readonly chain: AgentChainReader,
    private readonly transport: VaultDeploymentTransport,
    private readonly options: VaultDeploymentWorkerOptions,
  ) { this.now = options.now ?? (() => new Date()); }

  async runOnce(): Promise<{ claimed: number; awaitingSponsor: number; failed: number }> {
    const jobs = await this.store.claimVaultJobs(this.options.workerId, 1);
    let awaitingSponsor = 0;
    let failed = 0;
    for (const job of jobs) {
      const result = await this.process(job);
      if (result === "awaiting_sponsor") awaitingSponsor++;
      if (result === "failed") failed++;
    }
    return { claimed: jobs.length, awaitingSponsor, failed };
  }

  private async process(job: VaultJobRecord): Promise<"pending" | "awaiting_sponsor" | "failed"> {
    let stage: VaultJobState = job.state === "requested" ? "preparing" : job.state;
    let planPersisted = Boolean(job.deploymentPlan);
    let nonceReserved = job.nonceStart != null;
    try {
      const [agent, profile] = await Promise.all([
        this.chain.getAgent(job.agentId),
        this.store.getAgentProfile(job.agentId),
      ]);
      if (
        !profile || !agent.active || !profile.worldBacked
        || agent.sponsor.toLowerCase() !== job.sponsor.toLowerCase()
        || profile.sponsor.toLowerCase() !== job.sponsor.toLowerCase()
        || profile.signer.toLowerCase() !== agent.signer.toLowerCase()
      ) throw new VaultDeploymentError("AGENT_INACTIVE", "Agent backing or ownership changed before deployment", false);

      let plan = job.deploymentPlan;
      if (!plan) {
        await this.transport.preflight(job);
        const observedNonce = await this.transport.pendingNonce();
        const nonceStart = await this.store.reserveVaultNonceRange(job.id, this.chain.chainId, this.transport.address, observedNonce);
        nonceReserved = true;
        plan = await this.transport.prepare(job, nonceStart);
        // Durability boundary: all three signed raw transactions are in Postgres
        // before the controller CREATE can reach an RPC.
        await this.store.persistVaultDeploymentPlan(job.id, this.options.workerId, plan);
        planPersisted = true;
      }

      for (const tx of plan.transactions) {
        stage = tx.step === "controller" ? "deploying_controller" : tx.step === "fund" ? "deploying_fund" : "registering";
        const receipt = await this.transport.receipt(tx.hash);
        if (receipt) {
          if (receipt.status === "reverted") throw new VaultDeploymentError(`${tx.step.toUpperCase()}_REVERTED`, `${tx.step} transaction reverted`, false);
          const [head, canonical] = await Promise.all([
            this.transport.headBlock(),
            this.transport.canonicalBlockHash(receipt.blockNumber),
          ]);
          if (canonical.toLowerCase() !== receipt.blockHash.toLowerCase()) {
            await this.release(job, stage, "REORG_DETECTED", true);
            return "pending";
          }
          if (head - receipt.blockNumber + 1n < BigInt(this.options.confirmations)) {
            await this.release(job, stage, undefined, true);
            return "pending";
          }
          continue;
        }

        let broadcastHash: Hex;
        try { broadcastHash = await this.transport.broadcast(tx.serialized); }
        catch (error) {
          const message = String(error).toLowerCase();
          if (message.includes("already known") || message.includes("known transaction")) broadcastHash = tx.hash;
          else throw new VaultDeploymentError("DEPLOY_BROADCAST_FAILED", "RPC rejected deployment transaction", true);
        }
        if (broadcastHash.toLowerCase() !== tx.hash.toLowerCase()) {
          throw new VaultDeploymentError("DEPLOY_HASH_MISMATCH", "RPC returned a different transaction hash", false);
        }
        await this.release(job, stage, undefined, true);
        return "pending";
      }

      const stakeEscrow = await this.transport.verifyDeployment(plan);
      await this.store.updateVaultJobState(job.id, this.options.workerId, "awaiting_sponsor_bind", { stakeEscrow });
      await this.store.appendEvent({
        type: "agent",
        agentId: job.agentId,
        occurredAt: this.now(),
        payload: { action: "vault_deployed", controller: plan.controller, fund: plan.fund, next: "sponsor_bind_and_stake" },
      });
      return "awaiting_sponsor";
    } catch (error) {
      const classified = error instanceof VaultDeploymentError
        ? error
        : new VaultDeploymentError("DEPLOY_TEMPORARY_FAILURE", "Temporary vault deployment failure", true);
      const retry = classified.retryable && job.attempts < 20;
      if (!retry && !planPersisted && nonceReserved) {
        await this.store.releaseUnusedVaultNonceRange(job.id, this.chain.chainId, this.transport.address);
      }
      await this.store.updateVaultJobState(job.id, this.options.workerId, stage, {
        errorCode: classified.code,
        retryAt: retry ? new Date(this.now().getTime() + Math.min(60_000, 1_000 * 2 ** Math.min(job.attempts, 6))) : undefined,
        terminal: !retry,
      });
      return retry ? "pending" : "failed";
    }
  }

  private async release(job: VaultJobRecord, stage: VaultJobState, errorCode?: string, quick = false): Promise<void> {
    await this.store.updateVaultJobState(job.id, this.options.workerId, stage, {
      errorCode,
      retryAt: new Date(this.now().getTime() + (quick ? 2_000 : 5_000)),
    });
  }
}

export function parseRequiredStake6(job: VaultJobRecord): bigint {
  const parsed = vaultRequestSchema.parse(job.request);
  const [whole, fraction = ""] = parsed.economy.initialStake.split(".");
  return BigInt(whole ?? "0") * 1_000_000n + BigInt(fraction.padEnd(6, "0"));
}
