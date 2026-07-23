import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const PLACEHOLDERS = new Set([
  "0x0000000000000000000000000000000000000000",
  "0x0000000000000000000000000000000000000001",
  "0x0000000000000000000000000000000000000002",
]);

function address(name) {
  const value = process.env[name];
  if (!value || !ADDRESS.test(value) || PLACEHOLDERS.has(value.toLowerCase())) {
    throw new Error(`${name} must be a deployed, non-placeholder EVM address`);
  }
  return value;
}

function block(name, fallback) {
  const raw = process.env[name] ?? fallback;
  if (raw == null || !/^\d+$/.test(raw)) throw new Error(`${name} must be a non-negative integer`);
  const value = Number(raw);
  if (!Number.isSafeInteger(value)) throw new Error(`${name} is outside JavaScript's safe integer range`);
  return value;
}

const commonStart = process.env.SUBGRAPH_START_BLOCK;
const output = {
  robinhood: {
    AgentRegistry: {
      address: address("AGENT_REGISTRY_ADDRESS"),
      startBlock: block("AGENT_REGISTRY_START_BLOCK", commonStart),
    },
    FundRegistry: {
      address: address("FUND_REGISTRY_ADDRESS"),
      startBlock: block("FUND_REGISTRY_START_BLOCK", commonStart),
    },
  },
};

const file = process.env.SUBGRAPH_NETWORKS_FILE
  ? resolve(process.env.SUBGRAPH_NETWORKS_FILE)
  : resolve(import.meta.dirname, "..", "networks.json");
await writeFile(file, `${JSON.stringify(output, null, 2)}\n`, "utf8");
console.log(`Configured Robinhood subgraph at ${file}`);
console.log(`AgentRegistry=${output.robinhood.AgentRegistry.address} @ ${output.robinhood.AgentRegistry.startBlock}`);
console.log(`FundRegistry=${output.robinhood.FundRegistry.address} @ ${output.robinhood.FundRegistry.startBlock}`);
