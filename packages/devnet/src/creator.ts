/**
 * Devnet-only vault control plane.
 *
 * FundRegistry v1 is owner-only and each Fund is deployed directly because its initcode cannot be
 * embedded in an EIP-170-sized factory. This local server represents the operator for deploy +
 * register. It never signs the manager stake: the browser wallet performs the real USDG approve
 * and StakeEscrow.addStake transactions after deployment.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { erc20Abi, isAddress, parseEther, parseUnits, type Address } from "viem";
import { acct, dealErc20, DEPLOYER, USDG, type Devnet } from "./chain.js";
import { createFund, type Protocol } from "./deploy.js";
import { fundAbi } from "./abis.js";

const MIN_STAKE_6 = 2_000_000000n;
const MAX_STAKE_6 = 10_000_000_000000n;
const MAX_BODY_BYTES = 32 * 1024;

type CreateVaultBody = {
  manager?: unknown;
  name?: unknown;
  symbol?: unknown;
  initialStake?: unknown;
  perfFeeBps?: unknown;
  feeMinBps?: unknown;
  feeMaxBps?: unknown;
  managerEntryShareBps?: unknown;
  kFactor?: unknown;
  periodDays?: unknown;
  cooldownHours?: unknown;
};

type ValidatedVault = {
  manager: Address;
  name: string;
  symbol: string;
  initialStake6: bigint;
  perfFeeBps: number;
  feeMinBps: number;
  feeMaxBps: number;
  managerEntryShareBps: number;
  kFactor: number;
  periodDays: number;
  cooldownHours: number;
};

function integer(value: unknown, label: string, min: number, max: number): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new Error(`${label} must be between ${min} and ${max}`);
  }
  return parsed;
}

function validate(body: CreateVaultBody): ValidatedVault {
  if (typeof body.manager !== "string" || !isAddress(body.manager)) throw new Error("Invalid manager address");
  const name = typeof body.name === "string" ? body.name.trim() : "";
  if (name.length < 3 || name.length > 48) throw new Error("Name must contain 3-48 characters");
  const symbol = typeof body.symbol === "string" ? body.symbol.trim().toUpperCase() : "";
  if (!/^[A-Z0-9]{2,8}$/.test(symbol)) throw new Error("Symbol must contain 2-8 letters or numbers");

  let initialStake6: bigint;
  try {
    initialStake6 = parseUnits(String(body.initialStake ?? ""), 6);
  } catch {
    throw new Error("Invalid initial loss protection amount");
  }
  if (initialStake6 < MIN_STAKE_6 || initialStake6 > MAX_STAKE_6) {
    throw new Error("Initial loss protection must be between 2,000 and 10,000,000 USDG");
  }

  const perfFeeBps = integer(body.perfFeeBps, "Performance fee", 0, 3000);
  const feeMinBps = integer(body.feeMinBps, "Minimum entry fee", 0, 500);
  const feeMaxBps = integer(body.feeMaxBps, "Maximum entry fee", feeMinBps, 500);
  const managerEntryShareBps = integer(body.managerEntryShareBps, "Manager entry-fee share", 0, 5000);

  return {
    manager: body.manager,
    name,
    symbol,
    initialStake6,
    perfFeeBps,
    feeMinBps,
    feeMaxBps,
    managerEntryShareBps,
    kFactor: integer(body.kFactor, "AUM multiplier", 1, 25),
    periodDays: integer(body.periodDays, "Accounting period", 7, 90),
    cooldownHours: integer(body.cooldownHours, "Withdrawal cooldown", 1, 168),
  };
}

async function jsonBody(req: IncomingMessage): Promise<CreateVaultBody> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > MAX_BODY_BYTES) throw new Error("Request body is too large");
    chunks.push(buffer);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as CreateVaultBody;
  } catch {
    throw new Error("Invalid JSON body");
  }
}

function localOrigin(origin: string | undefined): boolean {
  if (!origin) return true;
  try {
    const url = new URL(origin);
    return url.protocol === "http:" && (url.hostname === "localhost" || url.hostname === "127.0.0.1");
  } catch {
    return false;
  }
}

function setHeaders(res: ServerResponse, origin?: string): void {
  if (origin && localOrigin(origin)) res.setHeader("access-control-allow-origin", origin);
  res.setHeader("vary", "origin");
  res.setHeader("access-control-allow-methods", "GET,POST,OPTIONS");
  res.setHeader("access-control-allow-headers", "content-type");
  res.setHeader("cache-control", "no-store");
}

function send(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.end(status === 204 ? undefined : JSON.stringify(body));
}

export function startCreatorServer(d: Devnet, p: Protocol, port: number): Server {
  let serial: Promise<unknown> = Promise.resolve();

  const server = createServer(async (req, res) => {
    const origin = req.headers.origin;
    setHeaders(res, origin);
    if (!localOrigin(origin)) return send(res, 403, { error: "Origin not allowed" });
    if (req.method === "OPTIONS") return send(res, 204, null);

    const url = new URL(req.url ?? "/", `http://127.0.0.1:${port}`);
    if (req.method === "GET" && (url.pathname === "/health" || url.pathname === "/config")) {
      return send(res, 200, {
        ok: true,
        mode: "devnet",
        chainId: d.chainId,
        rpcUrl: d.rpcUrl,
        fundRegistry: p.fundRegistry,
        usdg: USDG,
        creatorEnabled: true,
      });
    }

    if (req.method !== "POST" || url.pathname !== "/vaults") {
      return send(res, 404, { error: "Not found" });
    }

    try {
      const input = validate(await jsonBody(req));
      const operation = async () => {
        // Devnet faucet: fund gas and add the requested USDG amount to the manager's balance.
        await d.test.setBalance({ address: input.manager, value: parseEther("10") });
        const current = (await d.pub.readContract({
          address: USDG,
          abi: erc20Abi,
          functionName: "balanceOf",
          args: [input.manager],
        })) as bigint;
        await dealErc20(d, USDG, input.manager, current + input.initialStake6);

        const fund = await createFund(
          d,
          p,
          input.name,
          input.symbol,
          {
            PERF_FEE_BPS: String(input.perfFeeBps),
            FEE_MIN_BPS: String(input.feeMinBps),
            FEE_MAX_BPS: String(input.feeMaxBps),
            MGR_ENTRY_BPS: String(input.managerEntryShareBps),
            K_FACTOR: String(input.kFactor),
            PERIOD: String(input.periodDays * 24 * 60 * 60),
            COOLDOWN: String(input.cooldownHours * 60 * 60),
          },
          input.manager,
        );
        const stakeEscrow = (await d.pub.readContract({
          address: fund,
          abi: fundAbi,
          functionName: "stakeEscrow",
        })) as Address;
        return { fund, stakeEscrow };
      };

      // Foundry broadcasts share run-latest.json, so creation must remain serial.
      const queued = serial.then(operation, operation);
      serial = queued.then(() => undefined, () => undefined);
      const { fund, stakeEscrow } = await queued;
      return send(res, 201, {
        fund,
        stakeEscrow,
        usdg: USDG,
        fundRegistry: p.fundRegistry,
        chainId: d.chainId,
        initialStake6: input.initialStake6.toString(),
        operator: acct[DEPLOYER]!.address,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Vault creation failed";
      console.error("creator:", message);
      return send(res, 400, { error: message });
    }
  });

  server.listen(port, "127.0.0.1");
  return server;
}
