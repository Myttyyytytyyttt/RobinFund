import { AgentSessionService } from "./agentkit.js";
import { createMcpHandler, SubgraphIntelligenceSource } from "@nuvem/vault-intelligence-mcp";
import { ViemAgentChainReader } from "./chain.js";
import type { GatewayConfig } from "./config.js";
import { GraphVaultIntelligence } from "./graph.js";
import { IntentService } from "./intent.js";
import { ManagedSignerService } from "./managed-signer.js";
import { PostgresControlPlaneStore } from "./postgres-store.js";
import { SupabaseSponsorAuth } from "./sponsor-auth.js";
import { UniswapTradingApi } from "./uniswap.js";
import { WorldBackingService } from "./world-backing.js";
import { WorldIdSponsorService } from "./world-id.js";
import {
  AI_VAULT_IDENTITY_POLICY,
  WorldIdentityCheckService,
} from "./world-identity.js";
import { WorldRegistrationService } from "./world-registration.js";
import { createLazyVaultDeploymentService } from "./vault-worker-service.js";
import { zeroAddress } from "viem";

export function createServices(config: GatewayConfig) {
  const store = PostgresControlPlaneStore.connect(config.DATABASE_URL);
  const chain = new ViemAgentChainReader(config.AGENT_REGISTRY_ADDRESS, config.RH_RPC_URL, config.RH_CHAIN_ID);
  const identityAction = config.WORLD_IDENTITY_ACTION ?? config.WORLD_ID_ACTION;
  const identityGate = {
    appId: config.WORLD_APP_ID as `app_${string}`,
    rpId: config.WORLD_RP_ID,
    environment: config.WORLD_ID_ENVIRONMENT,
    policyId: AI_VAULT_IDENTITY_POLICY.id,
    policyVersion: AI_VAULT_IDENTITY_POLICY.version,
    policyHash: AI_VAULT_IDENTITY_POLICY.hash,
    action: identityAction,
  };
  const sessions = new AgentSessionService(store, chain, {
    publicBaseUrl: config.PUBLIC_BASE_URL,
    rpcUrl: config.RH_RPC_URL,
    worldRpcUrl: config.WORLD_CHAIN_RPC,
    sessionSecret: config.AGENT_SESSION_SECRET,
    worldIdPepper: config.WORLD_ID_PEPPER,
    humanBackingMode: config.WORLD_ID_ENVIRONMENT === "staging"
      ? "staging-identity"
      : "canonical-agentbook",
    identityGate,
  });
  const sponsors = new SupabaseSponsorAuth({
    supabaseUrl: config.SUPABASE_URL,
    publishableKey: config.SUPABASE_PUBLISHABLE_KEY,
  });
  const graphUrl = config.GRAPH_URL ?? "https://unconfigured.invalid/graphql";
  const graphDeploymentId = config.GRAPH_DEPLOYMENT_ID ?? "unconfigured";
  const graph = new GraphVaultIntelligence({
    url: graphUrl,
    deploymentId: graphDeploymentId,
  }, chain);
  const uniswap = new UniswapTradingApi({
    apiBaseUrl: config.UNISWAP_API_BASE_URL,
    apiKey: config.UNISWAP_API_KEY ?? "disabled",
    chainId: chain.chainId,
    approvalProxy: config.UNISWAP_APPROVAL_PROXY ?? zeroAddress,
    universalRouter: config.UNISWAP_UNIVERSAL_ROUTER ?? zeroAddress,
    stablecoin: config.USDG_ADDRESS,
  });
  const intents = new IntentService(store, chain, async (signer, typedData, signature) => {
    return chain.client.verifyTypedData({ address: signer, ...typedData, signature } as never);
  });
  const worldId = new WorldIdSponsorService(store, chain, {
    appId: config.WORLD_APP_ID as `app_${string}`,
    rpId: config.WORLD_RP_ID,
    rpSigningKey: config.WORLD_RP_SIGNING_KEY,
    action: config.WORLD_ID_ACTION,
    worldIdPepper: config.WORLD_ID_PEPPER,
    verifyBaseUrl: config.WORLD_VERIFY_BASE_URL,
    maxManagedAgentsPerHuman: config.MAX_MANAGED_AGENTS_PER_HUMAN,
  });
  const worldIdentity = new WorldIdentityCheckService(store, chain, {
    environment: config.WORLD_ID_ENVIRONMENT,
    appId: config.WORLD_APP_ID as `app_${string}`,
    rpId: config.WORLD_RP_ID,
    rpSigningKey: config.WORLD_RP_SIGNING_KEY,
    action: identityAction,
    worldIdPepper: config.WORLD_ID_PEPPER,
    verifyBaseUrl: config.WORLD_IDENTITY_VERIFY_BASE_URL,
    requestLifetimeSeconds: config.WORLD_IDENTITY_REQUEST_TTL_SECONDS,
    attestationLifetimeSeconds: config.WORLD_IDENTITY_ATTESTATION_TTL_SECONDS,
    verifyTimeoutMs: config.WORLD_IDENTITY_VERIFY_TIMEOUT_MS,
    maxManagedAgentsPerHuman: config.MAX_MANAGED_AGENTS_PER_HUMAN,
  });
  const worldBacking = new WorldBackingService(
    store,
    chain,
    sessions,
    config.WORLD_VERIFIER_PRIVATE_KEY,
    config.WORLD_CHAIN_RPC,
    undefined,
    identityGate,
  );
  const managedSigners = new ManagedSignerService(store, config.MANAGED_SIGNER_SECRET);
  const vaultDeployment = createLazyVaultDeploymentService(store, chain);
  const worldRegistration = new WorldRegistrationService(
    store,
    chain,
    config.WORLD_CHAIN_RPC,
    config.WORLD_AGENTBOOK_RELAY_URL,
  );
  const mcpHandler = config.TRADING_ENABLED
    ? createMcpHandler(
      new SubgraphIntelligenceSource(graphUrl, config.RH_RPC_URL, graphDeploymentId),
      config.USDG_ADDRESS,
    )
    : async () => new Response(JSON.stringify({
      error: { code: "TRADING_NOT_CONFIGURED", message: "Graph-backed MCP is not enabled on this deployment" },
    }), { status: 503, headers: { "content-type": "application/json" } });
  return {
    store,
    chain,
    sessions,
    sponsors,
    graph,
    uniswap,
    intents,
    worldId,
    worldIdentity,
    worldBacking,
    vaultDeployment,
    managedSigners,
    worldRegistration,
    mcpHandler,
  };
}
