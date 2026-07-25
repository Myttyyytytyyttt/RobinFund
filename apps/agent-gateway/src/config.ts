import { existsSync, readFileSync } from "node:fs";
import { getAddress, isHex } from "viem";
import { z } from "zod";

const rootEnvFile = new URL("../../../.env", import.meta.url);

function loadRootEnv(environment: NodeJS.ProcessEnv): void {
  if (!existsSync(rootEnvFile)) return;
  for (const raw of readFileSync(rootEnvFile, "utf8").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const separator = line.indexOf("=");
    if (separator <= 0) continue;
    const name = line.slice(0, separator).trim();
    let value = line.slice(separator + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (environment[name] === undefined) environment[name] = value;
  }
}

const address = z.string().transform((value, context) => {
  try {
    return getAddress(value);
  } catch {
    context.addIssue({ code: "custom", message: "invalid EVM address" });
    return z.NEVER;
  }
});

const privateKey = z.string()
  .refine((value) => isHex(value) && value.length === 66, "invalid private key")
  .transform((value) => value as `0x${string}`);

const boolean = z.union([z.boolean(), z.string()]).transform((value, context) => {
  if (typeof value === "boolean") return value;
  if (["1", "true", "yes", "on"].includes(value.toLowerCase())) return true;
  if (["0", "false", "no", "off"].includes(value.toLowerCase())) return false;
  context.addIssue({ code: "custom", message: "invalid boolean" });
  return z.NEVER;
});

const worldAppId = z.string().regex(/^app_(?:staging_)?[0-9a-z]+$/);
const worldRpId = z.string().regex(/^rp_[0-9a-z]+$/);

const schema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().min(1).max(65_535).default(8787),
  PUBLIC_BASE_URL: z.url(),
  DATABASE_URL: z.string().min(1),
  SUPABASE_URL: z.url(),
  SUPABASE_PUBLISHABLE_KEY: z.string().min(1),
  RH_RPC_URL: z.url(),
  RH_CHAIN_ID: z.coerce.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  GRAPH_ENABLED: boolean.default(true),
  TRADING_ENABLED: boolean.default(true),
  WORLD_CHAIN_RPC: z.url(),
  WORLD_AGENTBOOK_RELAY_URL: z.url().default("https://x402-worldchain.vercel.app"),
  WORLD_APP_ID: worldAppId,
  WORLD_RP_ID: worldRpId,
  WORLD_RP_SIGNING_KEY: privateKey,
  WORLD_ID_ACTION: z.string().min(1).max(128),
  WORLD_VERIFY_BASE_URL: z.url().default("https://developer.worldcoin.org"),
  WORLD_ID_ENVIRONMENT: z.enum(["staging", "production"]),
  WORLD_IDENTITY_ACTION: z.string().min(1).max(128).optional(),
  WORLD_IDENTITY_VERIFY_BASE_URL: z.url().default("https://developer.world.org"),
  WORLD_IDENTITY_VERIFY_TIMEOUT_MS: z.coerce.number().int().min(1_000).max(30_000).default(10_000),
  WORLD_IDENTITY_REQUEST_TTL_SECONDS: z.coerce.number().int().min(60).max(900).default(600),
  WORLD_IDENTITY_ATTESTATION_TTL_SECONDS: z.coerce.number().int().min(300).max(2_592_000).default(604_800),
  AGENT_REGISTRY_ADDRESS: address,
  USDG_ADDRESS: address,
  GRAPH_URL: z.url().optional(),
  GRAPH_DEPLOYMENT_ID: z.string().min(1).optional(),
  GRAPH_MAX_BLOCK_LAG: z.coerce.bigint().nonnegative().default(50n),
  GRAPH_MAX_AGE_SECONDS: z.coerce.number().int().min(1).max(3_600).default(300),
  GRAPH_TIMEOUT_MS: z.coerce.number().int().min(1_000).max(30_000).default(10_000),
  UNISWAP_API_BASE_URL: z.url().default("https://trade-api.gateway.uniswap.org/v1"),
  UNISWAP_API_KEY: z.string().min(1).optional(),
  // Chain-specific and fail-closed: it must match the target returned by the
  // current Trading API no-Permit2 flow before an adapter is deployed.
  UNISWAP_APPROVAL_PROXY: address.optional(),
  // The approval proxy forwards tokens and calldata to this exact chain-specific router.
  UNISWAP_UNIVERSAL_ROUTER: address.optional(),
  AGENT_SESSION_SECRET: z.string().min(32),
  WORLD_ID_PEPPER: z.string().min(32),
  MANAGED_SIGNER_SECRET: z.string().min(32).optional(),
  MAX_MANAGED_AGENTS_PER_HUMAN: z.coerce.number().int().min(1).max(20).default(3),
  WORLD_VERIFIER_PRIVATE_KEY: privateKey,
  RELAYER_PRIVATE_KEY: privateKey.optional(),
  RELAYER_CONFIRMATIONS: z.coerce.number().int().min(1).max(20).default(2),
  WORKER_POLL_MS: z.coerce.number().int().min(250).max(60_000).default(2_000),
  CORS_ORIGINS: z.string().default("http://localhost:5173"),
}).superRefine((value, context) => {
  if (value.WORLD_ID_ENVIRONMENT === "staging" && value.RH_CHAIN_ID !== 46_630) {
    context.addIssue({
      code: "custom",
      path: ["RH_CHAIN_ID"],
      message: "World Identity staging is pinned to Robinhood Chain testnet (46630)",
    });
  }
  if (value.RH_CHAIN_ID === 46_630 && value.WORLD_ID_ENVIRONMENT !== "staging") {
    context.addIssue({
      code: "custom",
      path: ["WORLD_ID_ENVIRONMENT"],
      message: "Robinhood Chain testnet (46630) must use World Identity staging",
    });
  }
  if (value.GRAPH_ENABLED) {
    for (const name of ["GRAPH_URL", "GRAPH_DEPLOYMENT_ID"] as const) {
      if (!value[name]) context.addIssue({
        code: "custom",
        path: [name],
        message: `${name} required when Graph is enabled`,
      });
    }
  }
  if (value.TRADING_ENABLED) {
    if (!value.GRAPH_ENABLED) {
      context.addIssue({
        code: "custom",
        path: ["GRAPH_ENABLED"],
        message: "GRAPH_ENABLED must be true when trading is enabled",
      });
    }
    for (const name of [
      "UNISWAP_API_KEY",
      "UNISWAP_APPROVAL_PROXY",
      "UNISWAP_UNIVERSAL_ROUTER",
    ] as const) {
      if (!value[name]) context.addIssue({
        code: "custom",
        path: [name],
        message: `${name} required when trading is enabled`,
      });
    }
  }
});

export type GatewayConfig = z.infer<typeof schema>;

const deploymentSchema = z.object({
  DEPLOY_OPERATOR_PRIVATE_KEY: privateKey,
  TOKEN_REGISTRY_ADDRESS: address,
  ADAPTER_REGISTRY_ADDRESS: address,
  ELIGIBILITY_GATE_ADDRESS: address,
  GUARDIAN_ADDRESS: address,
  FUND_REGISTRY_ADDRESS: address,
  KEEPER_ADDRESS: address,
  PROTOCOL_TREASURY_ADDRESS: address,
  UNISWAP_API_ADAPTER_ADDRESS: address,
  UNISWAP_API_ADAPTER_ID: z.coerce.bigint().nonnegative(),
  NAV_LIB_ADDRESS: address,
  AGENT_ASSETS: z.string().transform((value, context) => {
    try {
      const values = value.split(",").map((entry) => getAddress(entry.trim())).sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
      if (values.length === 0 || new Set(values.map((entry) => entry.toLowerCase())).size !== values.length) throw new Error("bad assets");
      return values;
    } catch {
      context.addIssue({ code: "custom", message: "invalid AGENT_ASSETS" });
      return z.NEVER;
    }
  }),
  VAULT_WORKER_CONFIRMATIONS: z.coerce.number().int().min(1).max(20).default(2),
  VAULT_WORKER_POLL_MS: z.coerce.number().int().min(250).max(60_000).default(2_000),
});

export type VaultWorkerConfig = GatewayConfig & z.infer<typeof deploymentSchema>;

function normalizedEnvironment(environment: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const chainId = environment.RH_CHAIN_ID
    ?? environment.RH_CHAIN_ID_MAINNET
    ?? "4663";
  const rpcUrl = environment.RH_RPC_URL
    ?? (chainId === "46630" ? environment.RH_RPC_TESTNET : environment.RH_RPC_MAINNET);
  const worldIdEnvironment = environment.WORLD_ID_ENVIRONMENT
    ?? (chainId === "46630" ? "staging" : "production");
  return {
    ...environment,
    RH_CHAIN_ID: chainId,
    RH_RPC_URL: rpcUrl,
    GRAPH_ENABLED: environment.GRAPH_ENABLED ?? environment.TRADING_ENABLED ?? "true",
    WORLD_ID_ENVIRONMENT: worldIdEnvironment,
  };
}

export function loadConfig(environment: NodeJS.ProcessEnv = process.env): GatewayConfig {
  if (environment === process.env) loadRootEnv(environment);
  const result = schema.safeParse(normalizedEnvironment(environment));
  if (!result.success) {
    const fields = result.error.issues.map((issue) => issue.path.join(".")).join(", ");
    throw new Error(`Invalid gateway configuration: ${fields}`);
  }
  return result.data;
}

export function loadVaultWorkerConfig(environment: NodeJS.ProcessEnv = process.env): VaultWorkerConfig {
  const base = loadConfig(environment);
  const deployment = deploymentSchema.safeParse(environment);
  if (!deployment.success) {
    const fields = deployment.error.issues.map((issue) => issue.path.join(".")).join(", ");
    throw new Error(`Invalid vault worker configuration: ${fields}`);
  }
  return { ...base, ...deployment.data };
}
