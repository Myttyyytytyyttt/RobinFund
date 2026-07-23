import { keccak256, type Address, type Hex } from "viem";
import { describe, expect, it } from "vitest";
import type { IntentRecord } from "../src/domain.js";
import { buildTradeTypedData } from "../src/intent.js";
import { MemoryControlPlaneStore } from "../src/store.js";
import {
  RelayerWorker,
  type PreparedTransaction,
  type RelayerReceipt,
  type RelayerTransport,
} from "../src/worker.js";
import {
  agentId,
  controllerAddress,
  evidenceHash,
  executionHash,
  FakeChain,
  fund,
  policyHash,
  signer,
  sponsor,
  tokenIn,
  tokenOut,
} from "./fixtures.js";

const rawTransaction = "0xabcdef" as Hex;
const transactionHash = keccak256(rawTransaction);
const blockHash = `0x${"77".repeat(32)}` as Hex;

function intent(overrides: Partial<IntentRecord> = {}): IntentRecord {
  const message = {
    agentId,
    fund,
    tokenIn,
    tokenOut,
    amountIn: 1_000n,
    minAmountOut: 980n,
    maxSlippageBps: 75,
    policyHash,
    executionHash,
    evidenceHash,
    nonce: 0n,
    validAfter: Math.floor(Date.now() / 1_000) - 1,
    deadline: Math.floor(Date.now() / 1_000) + 300,
  };
  const now = new Date();
  return {
    id: "00000000-0000-4000-8000-000000000010",
    proposalId: "00000000-0000-4000-8000-000000000011",
    quoteId: "00000000-0000-4000-8000-000000000012",
    agentId,
    sponsor,
    controller: controllerAddress,
    fund,
    chainId: 4663,
    intent: message,
    typedData: buildTradeTypedData(4663, controllerAddress, message) as unknown as Record<string, unknown>,
    adapterData: "0x1234",
    signature: `0x${"12".repeat(65)}`,
    state: "signed",
    transactionHash: null,
    blockNumber: null,
    failureCode: null,
    expiresAt: new Date(message.deadline * 1_000),
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

class FakeRelayer implements RelayerTransport {
  address = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" as Address;
  simulations = 0;
  preparations = 0;
  broadcasts = 0;
  receiptValue: RelayerReceipt | null = null;
  throwAfterAccept = false;
  canonicalHash = blockHash;

  async simulate(): Promise<void> { this.simulations++; }
  async prepare(): Promise<PreparedTransaction> {
    this.preparations++;
    return { hash: transactionHash, serialized: rawTransaction, nonce: 3n };
  }
  async broadcast(): Promise<Hex> {
    this.broadcasts++;
    this.receiptValue = {
      status: "success",
      transactionHash,
      blockNumber: 100n,
      blockHash,
    };
    if (this.throwAfterAccept) {
      this.throwAfterAccept = false;
      throw new Error("connection reset after broadcast");
    }
    return transactionHash;
  }
  async receipt(): Promise<RelayerReceipt | null> { return this.receiptValue; }
  async headBlock(): Promise<bigint> { return 102n; }
  async canonicalBlockHash(): Promise<Hex> { return this.canonicalHash; }
}

async function setup() {
  const store = new MemoryControlPlaneStore();
  const record = intent();
  await store.saveIntent(record);
  await store.enqueueIntent(record.id);
  const chain = new FakeChain();
  const transport = new FakeRelayer();
  return { store, record, chain, transport };
}

describe("durable relayer", () => {
  it("persists the signed raw transaction and confirms the receipt", async () => {
    const { store, chain, transport } = await setup();
    const worker = new RelayerWorker(store, chain, transport, { workerId: "worker-a", confirmations: 2 });
    const result = await worker.runOnce();
    expect(result).toEqual({ claimed: 1, confirmed: 1, failed: 0 });
    const job = [...store.jobs.values()][0]!;
    expect(job.signedTransaction).toBe(rawTransaction);
    expect(job.transactionHash).toBe(transactionHash);
    expect(job.state).toBe("confirmed");
  });

  it("recovers after broadcast uncertainty without signing or sending a second transaction", async () => {
    const { store, chain, transport } = await setup();
    transport.throwAfterAccept = true;
    const worker = new RelayerWorker(store, chain, transport, { workerId: "worker-a", confirmations: 2 });
    expect((await worker.runOnce()).confirmed).toBe(0);
    const job = [...store.jobs.values()][0]!;
    expect(job.signedTransaction).toBe(rawTransaction);
    job.availableAt = new Date(0);
    expect((await worker.runOnce()).confirmed).toBe(1);
    expect(transport.preparations).toBe(1);
    expect(transport.broadcasts).toBe(1);
  });

  it("lets only one of two concurrent workers claim a job", async () => {
    const { store, chain, transport } = await setup();
    const first = new RelayerWorker(store, chain, transport, { workerId: "worker-a", confirmations: 2 });
    const second = new RelayerWorker(store, chain, transport, { workerId: "worker-b", confirmations: 2 });
    const results = await Promise.all([first.runOnce(), second.runOnce()]);
    expect(results[0].claimed + results[1].claimed).toBe(1);
  });

  it("does not relay when AgentRegistry is paused", async () => {
    const { store, chain, transport } = await setup();
    chain.agent.active = false;
    const worker = new RelayerWorker(store, chain, transport, { workerId: "worker-a", confirmations: 2 });
    const result = await worker.runOnce();
    expect(result.failed).toBe(1);
    expect(transport.simulations).toBe(0);
  });

  it("does not relay an expired intent", async () => {
    const { store, chain, transport, record } = await setup();
    record.intent.deadline = Math.floor(Date.now() / 1_000) - 1;
    store.intents.set(record.id, record);
    const worker = new RelayerWorker(store, chain, transport, { workerId: "worker-a", confirmations: 2 });
    expect((await worker.runOnce()).failed).toBe(1);
    expect(transport.simulations).toBe(0);
  });

  it("detects a non-canonical receipt and retries rather than confirming", async () => {
    const { store, chain, transport } = await setup();
    transport.canonicalHash = `0x${"99".repeat(32)}`;
    const worker = new RelayerWorker(store, chain, transport, { workerId: "worker-a", confirmations: 2 });
    const result = await worker.runOnce();
    expect(result.confirmed).toBe(0);
    expect([...store.jobs.values()][0]!.state).toBe("queued");
  });
});
