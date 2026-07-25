import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const PLACEHOLDERS = new Set([
  "0x0000000000000000000000000000000000000000",
  "0x0000000000000000000000000000000000000001",
  "0x0000000000000000000000000000000000000002",
  "0x0000000000000000000000000000000000000003",
]);

function address(name) {
  const value = process.env[name];
  if (!value || !ADDRESS.test(value) || PLACEHOLDERS.has(value.toLowerCase())) {
    throw new Error(`${name} must be a deployed, non-placeholder EVM address`);
  }
  return value.toLowerCase();
}

function block(name, fallback) {
  const raw = process.env[name] ?? fallback;
  if (raw == null || !/^\d+$/.test(raw)) throw new Error(`${name} must be a non-negative integer`);
  const value = Number(raw);
  if (!Number.isSafeInteger(value)) throw new Error(`${name} is outside JavaScript's safe integer range`);
  return value;
}

async function rpc(url, method, params = []) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error(`RPC validation failed with HTTP ${response.status}`);
  const envelope = await response.json();
  if (envelope.error || envelope.result == null) throw new Error(`RPC validation failed for ${method}`);
  return envelope.result;
}

const configuredChainId = Number(process.env.RH_CHAIN_ID ?? process.env.RH_CHAIN_ID_TESTNET ?? 46630);
const network = process.env.SUBGRAPH_NETWORK
  ?? (configuredChainId === 46630 ? "robinhood-testnet" : "robinhood");
if (!["robinhood", "robinhood-testnet"].includes(network)) {
  throw new Error("SUBGRAPH_NETWORK must be robinhood or robinhood-testnet");
}
const expectedChainId = network === "robinhood-testnet" ? 46630 : 4663;
if (configuredChainId !== expectedChainId) {
  throw new Error(`RH_CHAIN_ID must be ${expectedChainId} for ${network}`);
}

const commonStart = process.env.SUBGRAPH_START_BLOCK;
const selected = {
  AgentRegistry: {
    address: address("AGENT_REGISTRY_ADDRESS"),
    startBlock: block("AGENT_REGISTRY_START_BLOCK", commonStart),
  },
  FundRegistry: {
    address: address("FUND_REGISTRY_ADDRESS"),
    startBlock: block("FUND_REGISTRY_START_BLOCK", commonStart),
  },
  CanaryFundSnapshot: {
    address: address("CANARY_FUND_ADDRESS"),
    startBlock: block("CANARY_FUND_START_BLOCK", commonStart),
  },
};

const file = process.env.SUBGRAPH_NETWORKS_FILE
  ? resolve(process.env.SUBGRAPH_NETWORKS_FILE)
  : resolve(import.meta.dirname, "..", "networks.json");
let output = {};
try {
  output = JSON.parse(await readFile(file, "utf8"));
} catch (error) {
  if (error?.code !== "ENOENT") throw error;
}
output[network] = selected;

const rpcUrl = process.env.RH_RPC_URL
  ?? (network === "robinhood-testnet" ? process.env.RH_RPC_TESTNET : process.env.RH_RPC_MAINNET);
if (rpcUrl) {
  const remoteChainId = Number.parseInt(await rpc(rpcUrl, "eth_chainId"), 16);
  if (remoteChainId !== expectedChainId) {
    throw new Error(`RPC chain mismatch: expected ${expectedChainId}, received ${remoteChainId}`);
  }
  for (const [name, contract] of Object.entries(selected)) {
    const code = await rpc(rpcUrl, "eth_getCode", [contract.address, "latest"]);
    if (code === "0x") throw new Error(`${name} has no bytecode on ${network}`);
  }
}

await writeFile(file, `${JSON.stringify(output, null, 2)}\n`, "utf8");
console.log(`Configured ${network} subgraph at ${file}`);
console.log(`AgentRegistry=${selected.AgentRegistry.address} @ ${selected.AgentRegistry.startBlock}`);
console.log(`FundRegistry=${selected.FundRegistry.address} @ ${selected.FundRegistry.startBlock}`);
console.log(`CanaryFund=${selected.CanaryFundSnapshot.address} @ ${selected.CanaryFundSnapshot.startBlock}`);
