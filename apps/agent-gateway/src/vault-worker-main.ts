import { randomUUID } from "node:crypto";
import { loadVaultWorkerConfig } from "./config.js";
import { createServices } from "./services.js";
import { VaultDeploymentWorker, ViemVaultDeploymentTransport } from "./vault-worker.js";

const config = loadVaultWorkerConfig();
const services = createServices(config);
const worker = new VaultDeploymentWorker(
  services.store,
  services.chain,
  new ViemVaultDeploymentTransport(config),
  { workerId: `vault-deployer-${randomUUID()}`, confirmations: config.VAULT_WORKER_CONFIRMATIONS },
);

let stopped = false;
async function loop(): Promise<void> {
  while (!stopped) {
    try {
      const result = await worker.runOnce();
      if (result.claimed > 0) console.info(JSON.stringify({ level: "info", message: "vault deployment batch", ...result }));
    } catch {
      console.error(JSON.stringify({ level: "error", message: "vault deployment batch failed" }));
    }
    await new Promise((resolve) => setTimeout(resolve, config.VAULT_WORKER_POLL_MS));
  }
}

async function shutdown(): Promise<void> {
  stopped = true;
  await services.store.close();
  process.exit(0);
}
process.on("SIGINT", () => { void shutdown(); });
process.on("SIGTERM", () => { void shutdown(); });
void loop();
