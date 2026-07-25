import { Hono } from "hono";
import { handle } from "hono/vercel";
import { createConfiguredVaultIntelligenceApp } from "./app.js";

type RequestHandler = (request: Request) => Response | Promise<Response>;

let requestHandler: RequestHandler | undefined;

function configuredHandler(): RequestHandler {
  if (requestHandler) return requestHandler;

  const service = createConfiguredVaultIntelligenceApp();
  const app = new Hono();
  app.route("/api", service);
  app.route("/", service);

  requestHandler = handle(app);
  return requestHandler;
}

function handler(request: Request): Response | Promise<Response> {
  return configuredHandler()(request);
}

export const GET = handler;
export const POST = handler;
export const DELETE = handler;
export const OPTIONS = handler;
export const HEAD = handler;
