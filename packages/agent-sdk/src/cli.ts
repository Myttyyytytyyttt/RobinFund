#!/usr/bin/env node
import { keccak256, stringToHex, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { NuvemAgentClient, type QuoteInput } from "./index.js";

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function option(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function output(value: unknown): void {
  console.log(JSON.stringify(value, (_, entry) => typeof entry === "bigint" ? entry.toString() : entry, 2));
}

async function main(): Promise<void> {
  const command = process.argv[2] ?? "help";
  if (command === "help") {
    console.log(`Nuvem BYOA CLI

Environment (kept only on this machine):
  NUVEM_GATEWAY_URL, NUVEM_AGENT_ID, NUVEM_AGENT_PRIVATE_KEY,
  NUVEM_APPROVAL_PROXY, NUVEM_UNIVERSAL_ROUTER

Commands:
  context
  heartbeat [--version external/1.0.0]
  trade --token-in 0x.. --token-out 0x.. --amount 1000000 --summary "..." [--slippage 75] [--submit]

trade is a dry-run by default. The private key never leaves this process.`);
    return;
  }

  const account = privateKeyToAccount(required("NUVEM_AGENT_PRIVATE_KEY") as Hex);
  const chainId = Number(process.env.NUVEM_CHAIN_ID ?? 4663);
  const signer = {
    address: account.address.toLowerCase() as Address,
    chainId,
    signMessage: (message: string) => account.signMessage({ message }),
    signTypedData: (typedData: Parameters<typeof account.signTypedData>[0]) => account.signTypedData(typedData),
  };
  const client = new NuvemAgentClient(
    required("NUVEM_GATEWAY_URL"),
    required("NUVEM_AGENT_ID") as Hex,
    signer as never,
  );
  await client.connect();

  if (command === "context") {
    output(await client.context());
    return;
  }
  if (command === "heartbeat") {
    await client.heartbeat(option("version") ?? "external/1.0.0", ["context", "quotes", "eip712"]);
    output({ accepted: true });
    return;
  }
  if (command !== "trade") throw new Error(`Unknown command: ${command}`);

  const context = await client.context();
  const tokenIn = requiredOption("token-in") as Address;
  const tokenOut = requiredOption("token-out") as Address;
  const amountIn = BigInt(requiredOption("amount"));
  const summary = requiredOption("summary");
  const maxSlippageBps = Number(option("slippage") ?? 75);
  const evidence = {
    deploymentId: context.provenance.deploymentId,
    blockNumber: context.provenance.blockNumber.toString(),
    blockTimestamp: context.provenance.blockTimestamp.toISOString(),
    vault: context.vault,
    tokenIn,
    tokenOut,
    amountIn: amountIn.toString(),
  };
  const quoteInput: QuoteInput = {
    tokenIn,
    tokenOut,
    amountIn,
    maxSlippageBps,
    evidenceHash: keccak256(stringToHex(JSON.stringify(evidence))),
    reasoningHash: keccak256(stringToHex(summary)),
    summary,
  };
  const quote = await client.quote(quoteInput, context);
  output({ dryRun: !process.argv.includes("--submit"), executionPlan: quote.executionPlan, intent: quote.intent });
  if (!process.argv.includes("--submit")) return;

  const result = await client.signAndSubmit(quote, quoteInput, {
    chainId,
    expectedFund: context.vault,
    expectedController: context.controller,
    expectedAdapter: process.env.NUVEM_EXPECTED_ADAPTER as Address | undefined,
    expectedApprovalProxy: required("NUVEM_APPROVAL_PROXY") as Address,
    expectedUniversalRouter: required("NUVEM_UNIVERSAL_ROUTER") as Address,
    maxSlippageBps,
  });
  output(result);
}

function requiredOption(name: string): string {
  const value = option(name);
  if (!value) throw new Error(`--${name} is required`);
  return value;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : "Nuvem CLI failed");
  process.exitCode = 1;
});
