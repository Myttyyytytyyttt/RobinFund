import { describe, expect, it } from "vitest";
import { createRobinhoodChain } from "../src/chain.js";
import { loadConfig } from "../src/config.js";

const address = "0x1111111111111111111111111111111111111111";
const privateKey = `0x${"11".repeat(32)}`;

function environment(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    NODE_ENV: "test",
    PUBLIC_BASE_URL: "https://gateway.example.com/api",
    DATABASE_URL: "postgresql://postgres:password@localhost:5432/postgres",
    SUPABASE_URL: "https://example.supabase.co",
    SUPABASE_PUBLISHABLE_KEY: "publishable",
    RH_RPC_MAINNET: "https://mainnet.example.com",
    RH_RPC_TESTNET: "https://testnet.example.com",
    WORLD_CHAIN_RPC: "https://world.example.com",
    WORLD_APP_ID: "app_123abc",
    WORLD_RP_ID: "rp_123abc",
    WORLD_RP_SIGNING_KEY: privateKey,
    WORLD_ID_ACTION: "sponsor-ai-vault",
    AGENT_REGISTRY_ADDRESS: address,
    USDG_ADDRESS: address,
    GRAPH_URL: "https://graph.example.com",
    GRAPH_DEPLOYMENT_ID: "deployment",
    UNISWAP_API_KEY: "uniswap",
    UNISWAP_APPROVAL_PROXY: address,
    UNISWAP_UNIVERSAL_ROUTER: address,
    AGENT_SESSION_SECRET: "s".repeat(32),
    WORLD_ID_PEPPER: "p".repeat(32),
    WORLD_VERIFIER_PRIVATE_KEY: privateKey,
    RELAYER_PRIVATE_KEY: privateKey,
    ...overrides,
  };
}

describe("gateway chain configuration", () => {
  it("selects the testnet RPC when RH_CHAIN_ID targets 46630", () => {
    const config = loadConfig(environment({ RH_CHAIN_ID: "46630" }));
    expect(config.RH_CHAIN_ID).toBe(46_630);
    expect(config.RH_RPC_URL).toBe("https://testnet.example.com");
  });

  it("prefers an explicit target RPC", () => {
    const config = loadConfig(environment({ RH_CHAIN_ID: "46630", RH_RPC_URL: "https://custom.example.com" }));
    expect(config.RH_RPC_URL).toBe("https://custom.example.com");
  });

  it("builds a matching viem chain", () => {
    const chain = createRobinhoodChain(46_630, "https://testnet.example.com");
    expect(chain.id).toBe(46_630);
    expect(chain.name).toBe("Robinhood Chain Testnet");
    expect(chain.rpcUrls.default.http).toEqual(["https://testnet.example.com"]);
  });

  it("accepts only app_staging IDs for the server-authorized staging environment", () => {
    const config = loadConfig(environment({
      RH_CHAIN_ID: "46630",
      WORLD_ID_ENVIRONMENT: "staging",
      WORLD_APP_ID: "app_staging_123abc",
      WORLD_IDENTITY_ACTION: "ai-vault-identity-v1",
    }));
    expect(config.WORLD_ID_ENVIRONMENT).toBe("staging");
    expect(config.WORLD_APP_ID).toBe("app_staging_123abc");
  });

  it("rejects World Identity staging on Robinhood mainnet", () => {
    expect(() => loadConfig(environment({
      RH_CHAIN_ID: "4663",
      WORLD_ID_ENVIRONMENT: "staging",
      WORLD_APP_ID: "app_staging_123abc",
    }))).toThrow("RH_CHAIN_ID");
  });

  it("rejects production app IDs in staging and staging app IDs in production", () => {
    expect(() => loadConfig(environment({
      RH_CHAIN_ID: "46630",
      WORLD_ID_ENVIRONMENT: "staging",
      WORLD_APP_ID: "app_123abc",
    }))).toThrow("WORLD_APP_ID");
    expect(() => loadConfig(environment({
      RH_CHAIN_ID: "46630",
      WORLD_ID_ENVIRONMENT: "production",
      WORLD_APP_ID: "app_staging_123abc",
    }))).toThrow("WORLD_APP_ID");
  });

  it("derives production from a production app ID and permits an explicit Identity action", () => {
    const config = loadConfig(environment({
      RH_CHAIN_ID: "46630",
      WORLD_IDENTITY_ACTION: "ai-vault-identity-v1",
    }));
    expect(config.WORLD_ID_ENVIRONMENT).toBe("production");
    expect(config.WORLD_IDENTITY_ACTION).toBe("ai-vault-identity-v1");
  });
});
