import {
  createPublicClient,
  createWalletClient,
  encodeFunctionData,
  http,
  keccak256,
  type Address,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import type { AgentChainReader } from "./chain.js";
import { createRobinhoodChain, robinhoodChain } from "./chain.js";
import type { ExecutionJob, IntentRecord } from "./domain.js";
import { executeTradeAbi } from "./intent.js";
import type { ControlPlaneStore } from "./store.js";

export class RelayerError extends Error {
  constructor(readonly code: string, message: string, readonly retryable: boolean) {
    super(message);
  }
}

export interface PreparedTransaction {
  hash: Hex;
  serialized: Hex;
  nonce: bigint;
}

export interface RelayerReceipt {
  status: "success" | "reverted";
  transactionHash: Hex;
  blockNumber: bigint;
  blockHash: Hex;
}

export interface RelayerTransport {
  address: Address;
  simulate(intent: IntentRecord): Promise<void>;
  prepare(intent: IntentRecord): Promise<PreparedTransaction>;
  broadcast(serialized: Hex): Promise<Hex>;
  receipt(hash: Hex): Promise<RelayerReceipt | null>;
  headBlock(): Promise<bigint>;
  canonicalBlockHash(blockNumber: bigint): Promise<Hex>;
}

export class ViemRelayerTransport implements RelayerTransport {
  readonly address: Address;
  private readonly account;
  private readonly publicClient;
  private readonly walletClient;

  constructor(privateKey: Hex, rpcUrl: string, chainId = robinhoodChain.id) {
    this.account = privateKeyToAccount(privateKey);
    this.address = this.account.address.toLowerCase() as Address;
    const chain = createRobinhoodChain(chainId, rpcUrl);
    this.publicClient = createPublicClient({ chain, transport: http(rpcUrl, { retryCount: 2 }) });
    this.walletClient = createWalletClient({ account: this.account, chain, transport: http(rpcUrl, { retryCount: 2 }) });
  }

  async simulate(intent: IntentRecord): Promise<void> {
    const data = encodeIntentCall(intent);
    await this.publicClient.call({ account: this.account, to: intent.controller, data });
  }

  async prepare(intent: IntentRecord): Promise<PreparedTransaction> {
    const data = encodeIntentCall(intent);
    const request = await this.walletClient.prepareTransactionRequest({
      account: this.account,
      to: intent.controller,
      data,
      value: 0n,
    });
    const serialized = await this.account.signTransaction(request as never);
    return { serialized, hash: keccak256(serialized), nonce: BigInt(request.nonce) };
  }

  async broadcast(serialized: Hex): Promise<Hex> {
    return this.publicClient.sendRawTransaction({ serializedTransaction: serialized });
  }

  async receipt(hash: Hex): Promise<RelayerReceipt | null> {
    try {
      const receipt = await this.publicClient.getTransactionReceipt({ hash });
      return {
        status: receipt.status,
        transactionHash: receipt.transactionHash,
        blockNumber: receipt.blockNumber,
        blockHash: receipt.blockHash,
      };
    } catch (error) {
      const name = error instanceof Error ? error.name : "";
      const message = String(error).toLowerCase();
      if (name.includes("NotFound") || message.includes("could not be found") || message.includes("not found")) return null;
      throw error;
    }
  }

  async headBlock(): Promise<bigint> {
    return this.publicClient.getBlockNumber();
  }

  async canonicalBlockHash(blockNumber: bigint): Promise<Hex> {
    return (await this.publicClient.getBlock({ blockNumber })).hash;
  }
}

function encodeIntentCall(intent: IntentRecord): Hex {
  return encodeFunctionData({
    abi: executeTradeAbi,
    functionName: "executeTrade",
    args: [intent.intent, intent.adapterData, intent.signature],
  });
}

export interface RelayerWorkerOptions {
  workerId: string;
  confirmations: number;
  batchSize?: number;
  now?: () => Date;
}

export class RelayerWorker {
  private readonly now: () => Date;

  constructor(
    private readonly store: ControlPlaneStore,
    private readonly chain: AgentChainReader,
    private readonly transport: RelayerTransport,
    private readonly options: RelayerWorkerOptions,
  ) {
    this.now = options.now ?? (() => new Date());
  }

  async runOnce(): Promise<{ claimed: number; confirmed: number; failed: number }> {
    const jobs = await this.store.claimExecutionJobs(this.options.workerId, this.options.batchSize ?? 10);
    let confirmed = 0;
    let failed = 0;
    for (const job of jobs) {
      const outcome = await this.process(job);
      if (outcome === "confirmed") confirmed++;
      if (outcome === "failed") failed++;
    }
    return { claimed: jobs.length, confirmed, failed };
  }

  private async process(job: ExecutionJob): Promise<"pending" | "confirmed" | "failed"> {
    await this.store.appendExecutionAttempt({ jobId: job.id, attempt: job.attempts, phase: "claimed" });
    try {
      const intent = await this.store.getIntentForJob(job);
      if (!intent) throw new RelayerError("INTENT_NOT_FOUND", "Execution intent is missing", false);
      await this.revalidate(intent);

      let hash = job.transactionHash;
      let serialized = job.signedTransaction;
      if (!serialized || !hash) {
        await this.transport.simulate(intent);
        await this.store.appendExecutionAttempt({ jobId: job.id, attempt: job.attempts, phase: "simulated" });
        const prepared = await this.transport.prepare(intent);
        // Durability boundary: raw signed bytes and deterministic hash exist in Postgres before broadcast.
        await this.store.persistSignedTransaction(job.id, prepared);
        hash = prepared.hash;
        serialized = prepared.serialized;
      }

      const existing = await this.transport.receipt(hash);
      if (existing) return this.handleReceipt(job, existing);

      let broadcastHash: Hex;
      try {
        broadcastHash = await this.transport.broadcast(serialized);
      } catch (error) {
        const message = String(error).toLowerCase();
        if (message.includes("already known") || message.includes("nonce too low") || message.includes("known transaction")) {
          broadcastHash = hash;
        } else {
          throw new RelayerError("RPC_BROADCAST_FAILED", "RPC rejected transaction broadcast", true);
        }
      }
      if (broadcastHash.toLowerCase() !== hash.toLowerCase()) {
        throw new RelayerError("TRANSACTION_HASH_MISMATCH", "RPC returned a different transaction hash", false);
      }
      await this.store.markJobSubmitted(job.id, hash);
      await this.store.appendExecutionAttempt({
        jobId: job.id,
        attempt: job.attempts,
        phase: "broadcast",
        transactionHash: hash,
      });
      const receipt = await this.transport.receipt(hash);
      if (!receipt) return "pending";
      return this.handleReceipt(job, receipt);
    } catch (error) {
      const classified = this.classify(error);
      const retryAt = classified.retryable && job.attempts < 20
        ? new Date(this.now().getTime() + Math.min(60_000, 1_000 * 2 ** Math.min(job.attempts, 6)))
        : null;
      await this.store.appendExecutionAttempt({
        jobId: job.id,
        attempt: job.attempts,
        phase: "failed",
        errorCode: classified.code,
      });
      await this.store.markJobFailed(job.id, classified.code, retryAt);
      return retryAt ? "pending" : "failed";
    }
  }

  private async handleReceipt(job: ExecutionJob, receipt: RelayerReceipt): Promise<"pending" | "confirmed" | "failed"> {
    if (receipt.status === "reverted") {
      await this.store.appendExecutionAttempt({
        jobId: job.id,
        attempt: job.attempts,
        phase: "receipt",
        transactionHash: receipt.transactionHash,
        receiptStatus: "reverted",
      });
      await this.store.markJobFailed(job.id, "TRANSACTION_REVERTED", null);
      return "failed";
    }
    const [head, canonicalHash] = await Promise.all([
      this.transport.headBlock(),
      this.transport.canonicalBlockHash(receipt.blockNumber),
    ]);
    if (canonicalHash.toLowerCase() !== receipt.blockHash.toLowerCase()) {
      await this.store.appendExecutionAttempt({
        jobId: job.id,
        attempt: job.attempts,
        phase: "reorg_check",
        transactionHash: receipt.transactionHash,
        receiptStatus: "not_found",
        errorCode: "REORG_DETECTED",
      });
      await this.store.markJobFailed(job.id, "REORG_DETECTED", new Date(this.now().getTime() + 5_000));
      return "pending";
    }
    const confirmations = head >= receipt.blockNumber ? head - receipt.blockNumber + 1n : 0n;
    if (confirmations < BigInt(this.options.confirmations)) {
      await this.store.markJobSubmitted(job.id, receipt.transactionHash);
      return "pending";
    }
    await this.store.appendExecutionAttempt({
      jobId: job.id,
      attempt: job.attempts,
      phase: "receipt",
      transactionHash: receipt.transactionHash,
      receiptStatus: "success",
    });
    await this.store.markJobConfirmed(job.id, receipt.transactionHash, receipt.blockNumber);
    return "confirmed";
  }

  private async revalidate(intent: IntentRecord): Promise<void> {
    const now = Math.floor(this.now().getTime() / 1_000);
    if (intent.intent.deadline < now) throw new RelayerError("INTENT_EXPIRED", "Intent expired before relay", false);
    const [agent, controller, bound] = await Promise.all([
      this.chain.getAgent(intent.agentId),
      this.chain.getController(intent.controller),
      this.chain.isControllerBound(intent.agentId, intent.controller),
    ]);
    if (!agent.active || !bound || controller.paused) {
      throw new RelayerError("AGENT_INACTIVE", "Agent or controller is inactive", false);
    }
    if (
      controller.agentId.toLowerCase() !== intent.agentId.toLowerCase()
      || controller.fund.toLowerCase() !== intent.fund.toLowerCase()
      || controller.policyHash.toLowerCase() !== intent.intent.policyHash.toLowerCase()
      || controller.nextNonce !== intent.intent.nonce
    ) throw new RelayerError("ONCHAIN_STATE_CHANGED", "Controller state changed after signing", false);
  }

  private classify(error: unknown): RelayerError {
    if (error instanceof RelayerError) return error;
    const message = String(error).toLowerCase();
    if (message.includes("execution reverted") || message.includes("revert")) {
      return new RelayerError("SIMULATION_REVERTED", "Controller simulation reverted", false);
    }
    return new RelayerError("RPC_TEMPORARY_FAILURE", "Temporary relayer RPC failure", true);
  }
}
