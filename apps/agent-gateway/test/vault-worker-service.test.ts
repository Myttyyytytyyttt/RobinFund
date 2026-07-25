import { describe, expect, it } from "vitest";
import type { AgentChainReader } from "../src/chain.js";
import type { VaultWorkerConfig } from "../src/config.js";
import type { ControlPlaneStore } from "../src/store.js";
import {
  createLazyVaultDeploymentService,
  VaultWorkerConfigurationError,
  type VaultWorkerTickResult,
} from "../src/vault-worker-service.js";

const store = {} as ControlPlaneStore;
const chain = {} as AgentChainReader;
const config = {} as VaultWorkerConfig;
const emptyTick: VaultWorkerTickResult = {
  claimed: 0,
  awaitingSponsor: 0,
  failed: 0,
  jobId: null,
};

describe("LazyVaultDeploymentService", () => {
  it("does not read worker configuration until processing is requested", async () => {
    let configLoads = 0;
    let workerCreations = 0;
    let runs = 0;
    const service = createLazyVaultDeploymentService(store, chain, {
      environment: {},
      workerId: "test-worker",
      loadConfig: () => {
        configLoads += 1;
        return config;
      },
      createWorker: (_config, workerId) => {
        expect(workerId).toBe("test-worker");
        workerCreations += 1;
        return {
          runOnce: async () => {
            runs += 1;
            return emptyTick;
          },
        };
      },
    });

    expect(configLoads).toBe(0);
    expect(workerCreations).toBe(0);
    await service.processNextEligible();
    await service.processNextEligible();
    expect(configLoads).toBe(1);
    expect(workerCreations).toBe(1);
    expect(runs).toBe(2);
  });

  it("coalesces concurrent requests inside one serverless isolate", async () => {
    let release: ((result: VaultWorkerTickResult) => void) | undefined;
    let runs = 0;
    const service = createLazyVaultDeploymentService(store, chain, {
      environment: {},
      loadConfig: () => config,
      createWorker: () => ({
        runOnce: () => {
          runs += 1;
          if (runs > 1) return Promise.resolve(emptyTick);
          return new Promise((resolve) => {
            release = resolve;
          });
        },
      }),
    });

    const first = service.processNextEligible();
    const second = service.processNextEligible();
    expect(first).toBe(second);
    await Promise.resolve();
    expect(runs).toBe(1);

    release?.(emptyTick);
    await expect(first).resolves.toEqual(emptyTick);
    await service.processNextEligible();
    expect(runs).toBe(2);
  });

  it("retries lazy configuration after an initial configuration failure", async () => {
    let attempts = 0;
    const service = createLazyVaultDeploymentService(store, chain, {
      environment: {},
      loadConfig: () => {
        attempts += 1;
        if (attempts === 1) throw new Error("missing deployment key");
        return config;
      },
      createWorker: () => ({ runOnce: async () => emptyTick }),
    });

    await expect(service.processNextEligible()).rejects.toBeInstanceOf(VaultWorkerConfigurationError);
    await expect(service.processNextEligible()).resolves.toEqual(emptyTick);
    expect(attempts).toBe(2);
  });
});
