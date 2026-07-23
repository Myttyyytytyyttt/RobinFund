import { randomUUID } from "node:crypto";
import type { Hex } from "viem";
import { loadConfig } from "./config.js";
import { createServices } from "./services.js";
import { RelayerWorker, ViemRelayerTransport } from "./worker.js";

const config = loadConfig();
const services = createServices(config);
if (!config.RELAYER_PRIVATE_KEY) throw new Error("RELAYER_PRIVATE_KEY required for relayer worker");
const transport = new ViemRelayerTransport(config.RELAYER_PRIVATE_KEY as Hex, config.RH_RPC_URL, config.RH_CHAIN_ID);
const worker = new RelayerWorker(services.store, services.chain, transport, {
  workerId: `relayer-${randomUUID()}`,
  confirmations: config.RELAYER_CONFIRMATIONS,
});

let stopped = false;
async function loop(): Promise<void> {
  while (!stopped) {
    try {
      const result = await worker.runOnce();
      if (result.claimed > 0) console.info(JSON.stringify({ level: "info", message: "relayer batch", ...result }));
    } catch {
      console.error(JSON.stringify({ level: "error", message: "relayer batch failed" }));
    }
    await new Promise((resolve) => setTimeout(resolve, config.WORKER_POLL_MS));
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
