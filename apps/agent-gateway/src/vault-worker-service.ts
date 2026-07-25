import { randomUUID } from "node:crypto";
import type { AgentChainReader } from "./chain.js";
import {
  loadVaultWorkerConfig,
  type VaultWorkerConfig,
} from "./config.js";
import type { ControlPlaneStore } from "./store.js";
import {
  VaultDeploymentWorker,
  ViemVaultDeploymentTransport,
} from "./vault-worker.js";

export type VaultWorkerTickResult = Awaited<
  ReturnType<VaultDeploymentWorker["runOnce"]>
>;

export interface VaultWorkerTickRunner {
  runOnce(): Promise<VaultWorkerTickResult>;
}

export class VaultWorkerConfigurationError extends Error {
  readonly code = "VAULT_WORKER_NOT_CONFIGURED";

  constructor(options?: ErrorOptions) {
    super("Vault deployment processing is not configured", options);
    this.name = "VaultWorkerConfigurationError";
  }
}

export interface LazyVaultDeploymentServiceOptions {
  environment?: NodeJS.ProcessEnv;
  workerId?: string;
  loadConfig?: (environment: NodeJS.ProcessEnv) => VaultWorkerConfig;
  createWorker?: (
    config: VaultWorkerConfig,
    workerId: string,
  ) => VaultWorkerTickRunner;
}

/**
 * Adapts the durable vault state machine to request-driven runtimes.
 *
 * Construction is intentionally side-effect free: worker-only environment
 * variables and the deployment key are parsed only when a caller explicitly
 * asks to process the next eligible state transition.
 */
export class LazyVaultDeploymentService {
  private worker: VaultWorkerTickRunner | undefined;
  private inFlight: Promise<VaultWorkerTickResult> | undefined;
  private readonly environment: NodeJS.ProcessEnv;
  private readonly workerId: string;
  private readonly configLoader: (environment: NodeJS.ProcessEnv) => VaultWorkerConfig;
  private readonly workerFactory: (
    config: VaultWorkerConfig,
    workerId: string,
  ) => VaultWorkerTickRunner;

  constructor(
    store: ControlPlaneStore,
    chain: AgentChainReader,
    options: LazyVaultDeploymentServiceOptions = {},
  ) {
    this.environment = options.environment ?? process.env;
    this.workerId = options.workerId ?? `vault-request-${randomUUID()}`;
    this.configLoader = options.loadConfig ?? loadVaultWorkerConfig;
    this.workerFactory = options.createWorker ?? ((config, workerId) => (
      new VaultDeploymentWorker(
        store,
        chain,
        new ViemVaultDeploymentTransport(config),
        {
          workerId,
          confirmations: config.VAULT_WORKER_CONFIRMATIONS,
        },
      )
    ));
  }

  /**
   * Runs at most one globally claimable transition. Concurrent requests in
   * one function isolate share the same promise; Postgres claims serialize
   * different isolates.
   */
  processNextEligible(): Promise<VaultWorkerTickResult> {
    if (this.inFlight) return this.inFlight;
    const execution = Promise.resolve()
      .then(() => this.getWorker().runOnce())
      .finally(() => {
        if (this.inFlight === execution) this.inFlight = undefined;
      });
    this.inFlight = execution;
    return execution;
  }

  private getWorker(): VaultWorkerTickRunner {
    if (!this.worker) {
      try {
        const config = this.configLoader(this.environment);
        this.worker = this.workerFactory(config, this.workerId);
      } catch (error) {
        throw new VaultWorkerConfigurationError({
          cause: error,
        });
      }
    }
    return this.worker;
  }
}

export function createLazyVaultDeploymentService(
  store: ControlPlaneStore,
  chain: AgentChainReader,
  options: LazyVaultDeploymentServiceOptions = {},
): LazyVaultDeploymentService {
  return new LazyVaultDeploymentService(store, chain, options);
}
