import { randomBytes } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { rootDir } from "./common.js";

type EnvMap = Map<string, string>;

function parse(lines: string[]): EnvMap {
  const values: EnvMap = new Map();
  for (const raw of lines) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const separator = line.indexOf("=");
    if (separator > 0) values.set(line.slice(0, separator).trim(), line.slice(separator + 1).trim());
  }
  return values;
}

function secret(): string {
  return `0x${randomBytes(32).toString("hex")}`;
}

function main(): void {
  const path = resolve(rootDir, ".env");
  const lines = readFileSync(path, "utf8").split(/\r?\n/);
  const values = parse(lines);
  const required = (name: string): string => {
    const value = values.get(name)?.trim();
    if (!value) throw new Error(`${name} falta en .env`);
    return value;
  };
  const ensure = (name: string, value: () => string): void => {
    if (!values.get(name)?.trim()) values.set(name, value());
  };
  const set = (name: string, value: string): void => { values.set(name, value); };

  ensure("WORLD_VERIFIER_PRIVATE_KEY", generatePrivateKey);
  ensure("RELAYER_PRIVATE_KEY", generatePrivateKey);
  ensure("MANAGED_SIGNER_SECRET", secret);
  ensure("AGENT_SESSION_SECRET", secret);
  ensure("WORLD_CHAIN_RPC", () => "https://worldchain-mainnet.g.alchemy.com/public");

  const projectRef = required("SUPABASE_PROJECT_REF");
  const databasePassword = required("SUPABASE_DB_PASSWORD");
  ensure("DATABASE_URL", () => (
    `postgresql://postgres.${projectRef}:${encodeURIComponent(databasePassword)}`
    + "@aws-0-eu-west-1.pooler.supabase.com:6543/postgres?sslmode=require"
  ));

  set("RH_RPC_URL", required("RH_RPC_TESTNET"));
  set("RH_CHAIN_ID", "46630");
  set("TRADING_ENABLED", "false");
  set("PUBLIC_BASE_URL", values.get("PUBLIC_BASE_URL") || "http://127.0.0.1:8787");
  set("PORT", values.get("PORT") || "8787");
  set("CORS_ORIGINS", "http://localhost:5173,http://127.0.0.1:5173,https://nuvem.fund,https://www.nuvem.fund");

  set("USDG_ADDRESS", "0x336c508083e2afe17c594a8ef5b8542efcf672d5");
  set("TOKEN_REGISTRY_ADDRESS", "0xb5355a8acf17b7a8fedb05600fe9c2d26a4e4dc7");
  set("ADAPTER_REGISTRY_ADDRESS", "0xca3ed32482e64c62cc50c72a01493ea5b33a689e");
  set("ELIGIBILITY_GATE_ADDRESS", "0xf0cc1f908203caf04852cbf11b8569a8a48949f2");
  set("GUARDIAN_ADDRESS", "0x44952d28eca003b4cac2191f0ae73a993defbff7");
  set("FUND_REGISTRY_ADDRESS", "0x696553ad390428abf3d95c90a3452917cbaa453c");
  // Adapter ID 1 is the agent-compatible deterministic testnet venue. It is
  // deliberately not labelled as Uniswap; trading remains fail-closed until
  // the Graph + Uniswap production path is available.
  set("UNISWAP_API_ADAPTER_ADDRESS", "0x375897f8a225021230fffbdc308f192db049e4d2");
  set("UNISWAP_API_ADAPTER_ID", "1");
  set("NAV_LIB_ADDRESS", "0x26c6c76d7f9c17c5290e09406a2446dcd4605bcd");
  set("AGENT_ASSETS", [
    "0x3f1a8f0a7d944875e3350b0c78d56d22990a6e2f",
    "0x3b334d58c329f7a98ca3c11a09e45ae3352263ae",
    "0x6fd0d905af9841a2a268ab4784efe24575a48d1c",
    "0x5cc41b676e626c29fa685c1e9057d0264d3c6f05",
    "0x2b41f3c8b61e7188a2c7dbf494ebf6d0beaced22",
  ].join(","));

  const deployer = privateKeyToAccount(required("DEPLOYER_PK") as `0x${string}`);
  set("KEEPER_ADDRESS", deployer.address);
  set("PROTOCOL_TREASURY_ADDRESS", deployer.address);
  set("DEPLOY_OPERATOR_PRIVATE_KEY", required("DEPLOYER_PK"));

  ensure("GRAPH_URL", () => "https://unconfigured.invalid/graphql");
  ensure("GRAPH_DEPLOYMENT_ID", () => "unconfigured");

  const registryArgument = process.argv.find((argument) => argument.startsWith("--agent-registry="));
  if (registryArgument) set("AGENT_REGISTRY_ADDRESS", registryArgument.slice("--agent-registry=".length));

  const seen = new Set<string>();
  const output = lines.map((raw) => {
    const match = raw.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)=/);
    if (!match) return raw;
    const name = match[1]!;
    if (!values.has(name)) return raw;
    seen.add(name);
    return `${name}=${values.get(name)}`;
  });
  for (const [name, value] of values) {
    if (!seen.has(name)) output.push(`${name}=${value}`);
  }
  writeFileSync(path, `${output.join("\n").replace(/\n+$/, "")}\n`, "utf8");

  console.log(JSON.stringify({
    ok: true,
    targetChainId: 46_630,
    worldVerifier: privateKeyToAccount(required("WORLD_VERIFIER_PRIVATE_KEY") as `0x${string}`).address,
    relayer: privateKeyToAccount(required("RELAYER_PRIVATE_KEY") as `0x${string}`).address,
    databaseMode: "Supavisor transaction pooler",
    tradingEnabled: false,
    agentRegistryConfigured: Boolean(values.get("AGENT_REGISTRY_ADDRESS")),
    secretsPrinted: false,
  }, null, 2));
}

try { main(); }
catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
