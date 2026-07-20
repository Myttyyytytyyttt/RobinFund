/**
 * HTTP API del servicio (node:http, sin framework):
 *
 *   GET  /healthz                  → { ok, signer, gate, chainId }
 *   GET  /status/:address          → estado on-chain + local (sin PII)
 *   POST /admissions   [admin]     → { personId, address, usPerson, jurisdiction } → atestación firmada
 *   POST /renewals                 → { address } → atestación firmada (dirección ya admitida)
 *   POST /revocations  [admin]     → { address } → tx revoke on-chain + marca local
 *
 * [admin] = Authorization: Bearer <COMPLIANCE_ADMIN_TOKEN> (comparación en tiempo constante).
 * La admisión es admin porque la declaración KYC debe venir de un backend verificador (capa 3),
 * nunca del navegador del usuario. La renovación es pública: solo re-firma a quien ya está admitido.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { timingSafeEqual } from "node:crypto";
import { isAddress, type Address } from "viem";
import { type ComplianceService } from "./service.js";
import { type AdmissionRequest } from "./policy.js";

const MAX_BODY = 16 * 1024;

/** Error con código HTTP: los errores de cliente NO son 500 y sus mensajes SÍ pueden salir. */
class HttpError extends Error {
  constructor(
    readonly code: number,
    message: string,
  ) {
    super(message);
  }
}

function tokenOk(req: IncomingMessage, adminToken: string): boolean {
  const header = req.headers.authorization ?? "";
  const provided = header.startsWith("Bearer ") ? header.slice(7) : "";
  const a = Buffer.from(provided);
  const b = Buffer.from(adminToken);
  return a.length === b.length && timingSafeEqual(a, b);
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const declared = Number(req.headers["content-length"] ?? "0");
  if (declared > MAX_BODY) throw new HttpError(413, "body demasiado grande");
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY) throw new HttpError(413, "body demasiado grande");
    chunks.push(chunk as Buffer);
  }
  if (size === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  } catch {
    throw new HttpError(400, "JSON inválido");
  }
}

function send(res: ServerResponse, code: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(code, { "content-type": "application/json", "content-length": Buffer.byteLength(payload) });
  res.end(payload);
}

function parseAddress(v: unknown): Address | null {
  return typeof v === "string" && isAddress(v, { strict: false }) ? (v as Address) : null;
}

export function createHttpServer(
  service: ComplianceService,
  info: { signer: Address; gate: Address; chainId: number },
  adminToken: string,
): Server {
  return createServer((req, res) => {
    void handle(req, res).catch((e: unknown) => {
      if (e instanceof HttpError) return send(res, e.code, { error: e.message });
      // fallo interno real (RPC caída, etc.): loggear el detalle, responder GENÉRICO — los
      // mensajes de viem incluyen la URL del RPC (con API key) y esto es un endpoint público
      console.error(JSON.stringify({ msg: "error interno", error: e instanceof Error ? e.message : String(e) }));
      if (!res.headersSent) send(res, 500, { error: "error interno" });
    });
  });

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://localhost");
    const path = url.pathname;

    if (req.method === "GET" && path === "/healthz") {
      return send(res, 200, { ok: true, ...info });
    }

    if (req.method === "GET" && path.startsWith("/status/")) {
      const address = parseAddress(path.slice("/status/".length));
      if (!address) return send(res, 400, { error: "dirección inválida" });
      return send(res, 200, await service.status(address));
    }

    if (req.method === "POST" && path === "/admissions") {
      if (!tokenOk(req, adminToken)) return send(res, 401, { error: "no autorizado" });
      const body = (await readJson(req)) as Partial<AdmissionRequest>;
      const address = parseAddress(body.address);
      if (!address) return send(res, 400, { error: "dirección inválida" });
      if (typeof body.personId !== "string" || typeof body.usPerson !== "boolean" || typeof body.jurisdiction !== "string") {
        return send(res, 400, { error: "faltan campos: personId, usPerson, jurisdiction" });
      }
      const result = await service.admit({
        personId: body.personId,
        address,
        usPerson: body.usPerson,
        jurisdiction: body.jurisdiction,
      });
      return result.ok ? send(res, 201, result) : send(res, 403, result);
    }

    if (req.method === "POST" && path === "/renewals") {
      const body = (await readJson(req)) as { address?: unknown };
      const address = parseAddress(body.address);
      if (!address) return send(res, 400, { error: "dirección inválida" });
      const result = await service.renew(address);
      return result.ok ? send(res, 201, result) : send(res, 403, result);
    }

    if (req.method === "POST" && path === "/revocations") {
      if (!tokenOk(req, adminToken)) return send(res, 401, { error: "no autorizado" });
      const body = (await readJson(req)) as { address?: unknown };
      const address = parseAddress(body.address);
      if (!address) return send(res, 400, { error: "dirección inválida" });
      const result = await service.revoke(address);
      return result.ok ? send(res, 200, result) : send(res, 409, result);
    }

    send(res, 404, { error: "ruta desconocida" });
  }
}
