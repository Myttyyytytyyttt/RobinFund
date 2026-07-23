import { Hono } from "hono";
import { handle } from "hono/vercel";
import { createConfiguredGateway } from "./bootstrap.js";
import { loadConfig } from "./config.js";

type RequestHandler = (request: Request) => Response | Promise<Response>;

let requestHandler: RequestHandler | undefined;

function configuredHandler(): RequestHandler {
  if (requestHandler) return requestHandler;
  const { app: gateway } = createConfiguredGateway(loadConfig());
  const app = new Hono();

  // Raw Vercel Functions only dispatch one path segment to `[...route]`.
  // The `/v1/:path*` rewrite therefore targets `/api` and carries the full
  // public path in an internal query parameter. Re-dispatch it into Hono while
  // preserving method, headers, body and all caller query parameters.
  app.all("/api", async (c) => {
    const rewrittenPath = c.req.query("__nuvem_path");
    if (!rewrittenPath) return c.redirect("/api/healthz", 307);

    const incomingUrl = new URL(c.req.url);
    incomingUrl.searchParams.delete("__nuvem_path");
    const query = incomingUrl.searchParams.toString();
    const path = rewrittenPath.startsWith("/") ? rewrittenPath : `/${rewrittenPath}`;
    const target = query ? `${path}?${query}` : path;
    const init: RequestInit = {
      method: c.req.method,
      headers: c.req.raw.headers,
    };
    if (c.req.method !== "GET" && c.req.method !== "HEAD") {
      init.body = await c.req.arrayBuffer();
    }
    return gateway.request(target, init);
  });

  // Raw Vercel Functions retain the /api prefix. The root mount also keeps
  // local/runtime adapters deterministic if a platform strips that prefix.
  app.route("/api", gateway);
  app.route("/", gateway);

  requestHandler = handle(app);
  return requestHandler;
}

function handler(request: Request): Response | Promise<Response> {
  return configuredHandler()(request);
}

// Vercel treats a default export as the legacy `(req, res)` Node signature.
// Named HTTP methods opt into the Web Request/Response runtime used by Hono.
export const GET = handler;
export const POST = handler;
export const PUT = handler;
export const PATCH = handler;
export const DELETE = handler;
export const OPTIONS = handler;
export const HEAD = handler;
