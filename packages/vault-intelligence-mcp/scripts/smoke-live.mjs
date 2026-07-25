import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

function object(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} is missing`);
  }
  return value;
}

function payload(response) {
  if (response.isError) throw new Error("MCP tool returned an error");
  if (response.structuredContent) return object(response.structuredContent, "structuredContent");
  const entry = response.content?.find((item) => item?.type === "text");
  if (!entry?.text) throw new Error("MCP response has no JSON content");
  return object(JSON.parse(entry.text), "text payload");
}

const url = new URL(process.env.MCP_URL ?? "http://127.0.0.1:8790/mcp");
const expectedDeployment = process.env.GRAPH_DEPLOYMENT_ID?.trim();
const vault = process.env.MCP_VAULT_ADDRESS?.trim();
const stablecoin = process.env.USDG_ADDRESS?.trim();
const client = new Client({ name: "nuvem-live-smoke", version: "0.1.0" });

try {
  await client.connect(new StreamableHTTPClientTransport(url));
  const listed = await client.listTools();
  const toolNames = listed.tools.map((tool) => tool.name).sort();
  const required = [
    "assess_trade_risk",
    "get_holdings",
    "get_indexer_status",
    "get_recent_trades",
    "get_vault_performance",
    "get_vault_state",
    "list_vaults",
    "simulate_rebalance",
  ];
  for (const name of required) {
    if (!toolNames.includes(name)) throw new Error(`Missing MCP tool ${name}`);
  }

  const status = payload(await client.callTool({ name: "get_indexer_status", arguments: {} }));
  const provenance = object(status.provenance, "indexer provenance");
  if (expectedDeployment && provenance.deploymentId !== expectedDeployment) {
    throw new Error("MCP deployment does not match GRAPH_DEPLOYMENT_ID");
  }
  if (provenance.indexingErrors) throw new Error("MCP reports Graph indexing errors");

  const output = {
    ok: true,
    tools: toolNames,
    deploymentId: provenance.deploymentId,
    chainId: provenance.chainId,
    blockNumber: provenance.blockNumber,
    chainHeadBlock: provenance.chainHeadBlock,
    blockLag: provenance.blockLag,
  };

  if (vault) {
    const state = payload(await client.callTool({
      name: "get_vault_state",
      arguments: { vault },
    }));
    const data = object(state.data, "vault state");
    output.vault = {
      address: data.address,
      managerType: data.managerType,
      state: data.state,
      navValid: data.navValid,
      holdings: Array.isArray(data.holdings) ? data.holdings.length : 0,
    };

    if (stablecoin) {
      const risk = payload(await client.callTool({
        name: "assess_trade_risk",
        arguments: {
          vault,
          tokenOut: stablecoin,
          spentValueWad: "1",
          receivedValueWad: "1",
          maxSlippageBps: 75,
        },
      }));
      const riskData = object(risk.data, "risk assessment");
      output.risk = {
        approved: riskData.approved,
        failedChecks: Array.isArray(riskData.checks)
          ? riskData.checks.filter((check) => check?.approved === false).map((check) => check.name)
          : [],
      };
    }
  }

  console.log(JSON.stringify(output, null, 2));
} finally {
  await client.close();
}
