import { createGatewayApp } from "./app.js";
import type { GatewayConfig } from "./config.js";
import { createServices } from "./services.js";

export function createConfiguredGateway(config: GatewayConfig) {
  const services = createServices(config);
  const app = createGatewayApp({
    ...services,
    registryAddress: config.AGENT_REGISTRY_ADDRESS,
    allowedOrigins: config.CORS_ORIGINS.split(",").map((value) => value.trim()).filter(Boolean),
    tradingEnabled: config.TRADING_ENABLED,
  });
  return { app, services };
}
