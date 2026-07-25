import { describe, expect, it } from "vitest";
import { keccak256, type Address, type Hex } from "viem";
import type { VaultDeploymentPlan, VaultJobRecord } from "../src/domain.js";
import { MemoryControlPlaneStore } from "../src/store.js";
import {
  VaultDeploymentWorker,
  type DeploymentReceipt,
  type VaultDeploymentTransport,
} from "../src/vault-worker.js";
import { agentId, controllerAddress, FakeChain, fund, profile, signer, sponsor } from "./fixtures.js";

const deployer = "0xc00000000000000000000000000000000000000c" as Address;
const stakeEscrow = "0xb00000000000000000000000000000000000000b" as Address;
const raws = ["0x01", "0x02", "0x03"] as Hex[];

function request(): Record<string, unknown> {
  return {
    agentId,
    signer,
    policy: {
      maxTradeBps: 1_000,
      maxConcentrationBps: 3_500,
      dailyTurnoverBps: 5_000,
      maxSlippageBps: 75,
      maxTradesPerDay: 24,
      minTradeInterval: 300,
      maxIntentLifetime: 300,
      allowedAssets: ["0x8000000000000000000000000000000000000008"],
    },
    economy: {
      name: "Autonomous Test Fund",
      symbol: "ATF",
      initialStake: "2000",
      perfFeeBps: 2_000,
      feeMinBps: 0,
      feeMaxBps: 200,
      managerEntryShareBps: 5_000,
      kFactor: 25,
      periodDays: 30,
      cooldownHours: 24,
    },
  };
}

class FakeDeploymentTransport implements VaultDeploymentTransport {
  address = deployer;
  prepared = 0;
  prepareError = false;
  broadcasts: Hex[] = [];
  receipts = new Map<string, DeploymentReceipt>();
  beforeBroadcast?: () => void;
  plan: VaultDeploymentPlan = {
    chainId: 4663,
    deployer,
    controller: controllerAddress,
    fund,
    transactions: raws.map((serialized, index) => ({
      step: (["controller", "fund", "register"] as const)[index]!,
      nonce: 40n + BigInt(index),
      serialized,
      hash: keccak256(serialized),
      contractAddress: index === 0 ? controllerAddress : index === 1 ? fund : null,
    })),
  };
  async pendingNonce(): Promise<bigint> { return 40n; }
  async preflight(): Promise<void> {}
  async prepare(_job: VaultJobRecord, nonce: bigint): Promise<VaultDeploymentPlan> {
    expect(nonce).toBe(40n);
    this.prepared++;
    if (this.prepareError) throw new Error("temporary signing failure");
    return this.plan;
  }
  async broadcast(serialized: Hex): Promise<Hex> {
    this.beforeBroadcast?.();
    this.broadcasts.push(serialized);
    return keccak256(serialized);
  }
  async receipt(hash: Hex): Promise<DeploymentReceipt | null> { return this.receipts.get(hash) ?? null; }
  async headBlock(): Promise<bigint> { return 102n; }
  async canonicalBlockHash(): Promise<Hex> { return `0x${"99".repeat(32)}` as Hex; }
  async verifyDeployment(): Promise<Address> { return stakeEscrow; }
  confirm(index: number): void {
    this.receipts.set(this.plan.transactions[index]!.hash, {
      status: "success",
      blockNumber: 100n,
      blockHash: `0x${"99".repeat(32)}` as Hex,
    });
  }
}

async function setup() {
  const store = new MemoryControlPlaneStore();
  store.profiles.set(agentId, profile());
  const created = await store.createVaultJob({ agentId, sponsor, request: request() });
  const transport = new FakeDeploymentTransport();
  const chain = new FakeChain();
  const worker = () => new VaultDeploymentWorker(store, chain, transport, { workerId: "vault-worker", confirmations: 2 });
  const job = () => store.vaultJobs.get(created.id)!;
  const releaseNow = () => { job().availableAt = new Date(0); };
  return { store, transport, chain, worker, job, releaseNow };
}

describe("VaultDeploymentWorker", () => {
  it("persists all signed bytes before broadcast and resumes without duplicate CREATEs", async () => {
    const { store, transport, worker, job, releaseNow } = await setup();
    transport.beforeBroadcast = () => {
      expect(job().deploymentPlan?.transactions).toHaveLength(3);
      expect(job().transactionHashes).toHaveLength(3);
    };

    expect(await worker().runOnce()).toMatchObject({ claimed: 1 });
    expect(transport.broadcasts).toEqual([raws[0]]);
    expect(transport.prepared).toBe(1);

    transport.confirm(0); releaseNow();
    await worker().runOnce();
    expect(transport.broadcasts).toEqual([raws[0], raws[1]]);

    transport.confirm(1); releaseNow();
    await worker().runOnce();
    expect(transport.broadcasts).toEqual([raws[0], raws[1], raws[2]]);

    transport.confirm(2); releaseNow();
    expect(await worker().runOnce()).toMatchObject({ awaitingSponsor: 1 });
    expect(job().state).toBe("awaiting_sponsor_bind");
    expect(job().stakeEscrow).toBe(stakeEscrow);
    expect(transport.prepared).toBe(1);
    expect(store.worldAttestations).toHaveLength(0);
  });

  it("does not let two concurrent workers claim the same vault job", async () => {
    const { store } = await setup();
    expect(await store.claimVaultJobs("worker-a", 1)).toHaveLength(1);
    expect(await store.claimVaultJobs("worker-b", 1)).toHaveLength(0);
  });

  it("does not claim a second unreserved job while the first serverless tick owns the queue", async () => {
    const { store } = await setup();
    const secondAgentId = `0x${"2".repeat(64)}` as Hex;
    store.profiles.set(secondAgentId, {
      ...profile(),
      agentId: secondAgentId,
    });
    await store.createVaultJob({
      agentId: secondAgentId,
      sponsor,
      request: { ...request(), agentId: secondAgentId },
    });

    expect(await store.claimVaultJobs("isolate-a", 1)).toHaveLength(1);
    expect(await store.claimVaultJobs("isolate-b", 1)).toHaveLength(0);
  });

  it("does not consume the failure budget while waiting for a receipt", async () => {
    const { transport, worker, job, releaseNow } = await setup();
    expect(await worker().runOnce()).toMatchObject({ claimed: 1 });

    for (let poll = 0; poll < 25; poll++) {
      releaseNow();
      expect(await worker().runOnce()).toMatchObject({ claimed: 1, failed: 0 });
    }

    expect(job().state).toBe("deploying_controller");
    expect(job().attempts).toBe(0);
    expect(transport.prepared).toBe(1);
  });

  it("fails closed when World backing is paused before deployment", async () => {
    const { chain, worker, job } = await setup();
    chain.agent.active = false;
    expect(await worker().runOnce()).toMatchObject({ failed: 1 });
    expect(job().state).toBe("failed");
    expect(job().deploymentPlan).toBeNull();
    expect(job().errorCode).toBe("AGENT_INACTIVE");
  });

  it("releases an unused nonce range when preparation exhausts retries before persistence", async () => {
    const { transport, worker, job } = await setup();
    job().attempts = 19;
    transport.prepareError = true;
    expect(await worker().runOnce()).toMatchObject({ failed: 1 });
    expect(job().state).toBe("failed");
    expect(job().nonceStart).toBeNull();
    expect(job().deploymentPlan).toBeNull();
  });
});
