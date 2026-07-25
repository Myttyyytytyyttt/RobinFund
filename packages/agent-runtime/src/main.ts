import { NuvemAgentClient, type AgentSigner } from "@nuvem/agent-sdk";
import { deriveManagedAgentAccount } from "@nuvem/managed-signer";
import { getAddress, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { NuvemReferenceAgent } from "./reference-agent.js";

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

const agentId = required("NUVEM_AGENT_ID") as Hex;
const configuredPrivateKey = process.env.NUVEM_AGENT_PRIVATE_KEY?.trim();
const account = configuredPrivateKey
  ? privateKeyToAccount(configuredPrivateKey as Hex)
  : deriveManagedAgentAccount(
      required("NUVEM_MANAGED_SIGNER_SECRET"),
      agentId,
      getAddress(required("NUVEM_SPONSOR_ADDRESS")),
    );
const chainId = Number(process.env.NUVEM_CHAIN_ID);
if (!Number.isSafeInteger(chainId) || chainId <= 0) {
  throw new Error("NUVEM_CHAIN_ID is required and must match the AgentKit challenge network");
}
const signer: AgentSigner = {
  address: account.address.toLowerCase() as Address,
  chainId,
  signMessage: (message) => account.signMessage({ message }),
  signTypedData: (typedData) => account.signTypedData(typedData as never),
};
const client = new NuvemAgentClient(
  required("NUVEM_GATEWAY_URL"),
  agentId,
  signer,
);
await client.connect();

const reference = new NuvemReferenceAgent(client, {
  model: process.env.NUVEM_MODEL ?? "openai/gpt-5-mini",
  execute: process.env.NUVEM_REFERENCE_EXECUTE === "1",
  expectedChainId: chainId,
  expectedFund: getAddress(required("NUVEM_FUND_ADDRESS")).toLowerCase() as Address,
  expectedController: getAddress(required("NUVEM_CONTROLLER_ADDRESS")).toLowerCase() as Address,
  expectedApprovalProxy: getAddress(required("NUVEM_APPROVAL_PROXY")).toLowerCase() as Address,
  expectedUniversalRouter: getAddress(required("NUVEM_UNIVERSAL_ROUTER")).toLowerCase() as Address,
  expectedAdapter: process.env.NUVEM_EXPECTED_ADAPTER
    ? getAddress(process.env.NUVEM_EXPECTED_ADAPTER).toLowerCase() as Address
    : undefined,
  maxSlippageBps: Number(process.env.NUVEM_MAX_SLIPPAGE_BPS ?? 75),
});

const intervalMs = Math.max(60_000, Number(process.env.NUVEM_CYCLE_MS ?? 300_000));
let stopped = false;
process.on("SIGINT", () => { stopped = true; });
process.on("SIGTERM", () => { stopped = true; });

while (!stopped) {
  try {
    const result = await reference.runCycle();
    console.info(JSON.stringify({ level: "info", message: "reference cycle complete", steps: result.steps, summary: result.text.slice(0, 500) }));
  } catch (error) {
    console.error(JSON.stringify({ level: "error", message: "reference cycle failed", code: error instanceof Error ? error.name : "unknown" }));
  }
  if (!stopped) await new Promise((resolve) => setTimeout(resolve, intervalMs));
}
