import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { getAddress, type Address, type Hex } from "viem";

type Json = Record<string, unknown>;

export interface McpVaultSnapshot {
  data: {
    address: Address;
    controller: Address | null;
    agentId: Hex | null;
    navWad: bigint;
    navValid: boolean;
    state: number;
    controllerEnabled: boolean;
    controllerPaused: boolean;
    agentStatus: number | null;
    backedUntil: Date | null;
  };
  provenance: {
    deploymentId: string;
    chainId: number;
    blockNumber: bigint;
    indexingErrors: boolean;
  };
}

function object(value: unknown, label: string): Json {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`MCP ${label} is missing`);
  }
  return value as Json;
}

function address(value: unknown): Address {
  return getAddress(String(value)).toLowerCase() as Address;
}

export class VaultGraphMcpClient {
  private readonly client = new Client({
    name: "nuvem-reference-agent",
    version: "0.1.0",
  });
  private connected = false;

  constructor(private readonly url: string) {}

  async connect(): Promise<void> {
    if (this.connected) return;
    await this.client.connect(new StreamableHTTPClientTransport(new URL(this.url)));
    this.connected = true;
  }

  async vault(vault: Address): Promise<McpVaultSnapshot> {
    await this.connect();
    const response = await this.client.callTool({
      name: "get_vault_state",
      arguments: { vault },
    });
    if (response.isError) throw new Error("The Graph MCP rejected get_vault_state");
    let payload: Json;
    if (response.structuredContent) {
      payload = object(response.structuredContent, "structured response");
    } else {
      const content = Array.isArray(response.content) ? response.content : [];
      const textEntry = content.find((item: unknown) => {
        return Boolean(item && typeof item === "object" && (item as Json).type === "text");
      });
      const text = object(textEntry, "text content").text;
      if (typeof text !== "string") throw new Error("The Graph MCP returned no JSON payload");
      payload = object(JSON.parse(text), "text response");
    }
    const data = object(payload.data, "vault data");
    const provenance = object(payload.provenance, "provenance");
    return {
      data: {
        address: address(data.address),
        controller: data.controller == null ? null : address(data.controller),
        agentId: data.agentId == null ? null : String(data.agentId) as Hex,
        navWad: BigInt(String(data.navWad)),
        navValid: data.navValid === true,
        state: Number(data.state),
        controllerEnabled: data.controllerEnabled === true,
        controllerPaused: data.controllerPaused === true,
        agentStatus: data.agentStatus == null ? null : Number(data.agentStatus),
        backedUntil: data.backedUntil == null ? null : new Date(String(data.backedUntil)),
      },
      provenance: {
        deploymentId: String(provenance.deploymentId),
        chainId: Number(provenance.chainId),
        blockNumber: BigInt(String(provenance.blockNumber)),
        indexingErrors: provenance.indexingErrors === true,
      },
    };
  }

  async close(): Promise<void> {
    if (!this.connected) return;
    this.connected = false;
    await this.client.close();
  }
}
