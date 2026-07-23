/**
 * Devnet-only vault control plane.
 *
 * FundRegistry v1 is owner-only and each Fund is deployed directly because its initcode cannot be
 * embedded in an EIP-170-sized factory. This local server represents the operator for deploy +
 * register. It never signs the manager stake: the browser wallet performs the real USDG approve
 * and StakeEscrow.addStake transactions after deployment.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { deriveManagedSignerIdentity } from "@nuvem/managed-signer";
import {
  encodePacked,
  erc20Abi,
  isAddress,
  isHex,
  keccak256,
  parseAbi,
  parseEther,
  parseUnits,
  type Address,
  type Hex,
} from "viem";
import { acct, AUXILIARY, dealErc20, DEPLOYER, TSLA, USDG, write, type Devnet } from "./chain.js";
import { createAgentVault, createFund, type AgentVaultConfig, type Protocol } from "./deploy.js";
import { fundAbi } from "./abis.js";

const MIN_STAKE_6 = 2_000_000000n;
const MAX_STAKE_6 = 10_000_000_000000n;
const MAX_BODY_BYTES = 32 * 1024;
const DEVNET_MANAGED_SIGNER_SECRET = "nuvem-devnet-only-managed-signer-secret-v1";

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

type CreateAgentVaultBody = CreateVaultBody & {
  agentId?: unknown;
  signer?: unknown;
  metadataUri?: unknown;
  runtimeKind?: unknown;
  allowedAssets?: unknown;
  policy?: unknown;
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

const agentRegistryAbi = parseAbi([
  "function sponsorOf(bytes32 agentId) view returns (address)",
  "function isActive(bytes32 agentId) view returns (bool)",
  "function backingNonce(bytes32 agentId) view returns (uint256)",
  "function activate((bytes32 agentId,address sponsor,address signer,bytes32 backingHash,uint64 agentBookBlock,uint48 validUntil,uint256 nonce) backing, bytes signature)",
]);

function validateAgent(body: CreateAgentVaultBody): {
  vault: ValidatedVault;
  agentId: Hex;
  signer: Address;
  assets: Address[];
  policy: AgentVaultConfig["policy"];
} {
  const vault = validate(body);
  if (typeof body.agentId !== "string" || !isHex(body.agentId, { strict: true }) || body.agentId.length !== 66) {
    throw new Error("Invalid agent id");
  }
  if (typeof body.signer !== "string" || !isAddress(body.signer)) throw new Error("Invalid agent signer");
  const source = body.policy && typeof body.policy === "object" ? body.policy as Record<string, unknown> : {};
  const rawAssets = Array.isArray(body.allowedAssets) ? body.allowedAssets : [TSLA];
  if (rawAssets.length === 0 || rawAssets.length > 32 || rawAssets.some((asset) => typeof asset !== "string" || !isAddress(asset))) {
    throw new Error("Allowed assets must contain 1-32 addresses");
  }
  const assets = [...new Set(rawAssets.map((asset) => (asset as string).toLowerCase()))]
    .sort()
    .map((asset) => asset as Address);
  return {
    vault,
    agentId: body.agentId.toLowerCase() as Hex,
    signer: body.signer.toLowerCase() as Address,
    assets,
    policy: {
      maxTradeBps: integer(source.maxTradeBps ?? 1000, "Maximum trade", 100, 2000),
      maxConcentrationBps: integer(source.maxConcentrationBps ?? 3500, "Concentration", 1000, 5000),
      dailyTurnoverBps: integer(source.dailyTurnoverBps ?? 5000, "Daily turnover", 500, 10000),
      maxSlippageBps: integer(source.maxSlippageBps ?? 75, "Slippage", 10, 100),
      maxTradesPerDay: integer(source.maxTradesPerDay ?? 24, "Daily trades", 1, 200),
      minTradeInterval: integer(source.minTradeInterval ?? 300, "Trade interval", 60, 3600),
      maxIntentLifetime: integer(source.maxIntentLifetime ?? 300, "Intent lifetime", 1, 300),
    },
  };
}

async function jsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > MAX_BODY_BYTES) throw new Error("Request body is too large");
    chunks.push(buffer);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
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
  res.setHeader("access-control-allow-headers", "content-type,idempotency-key");
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
        tokenRegistry: p.tokenRegistry,
        agentRegistry: p.agentRegistry,
        uniswapApiAdapter: p.uniswapApiAdapter,
        uniswapApiAdapterId: p.uniswapApiAdapterId.toString(),
        uniswapApprovalProxy: p.uniswapApprovalProxy,
        uniswapUniversalRouter: p.uniswapUniversalRouter,
        agentSwapMode: "devnet-mock",
        defaultAgentAssets: [TSLA],
        usdg: USDG,
        usdgMockFeed: p.usdgMockFeed,
        tslaMockFeed: p.tslaMockFeed,
        creatorEnabled: true,
      });
    }

    if (req.method !== "POST" || !["/managed-signers", "/vaults", "/agent-vaults/prepare", "/agent-vaults"].includes(url.pathname)) {
      return send(res, 404, { error: "Not found" });
    }

    try {
      const raw = await jsonBody(req);
      if (url.pathname === "/managed-signers") {
        const sponsor = raw.sponsor;
        const provisioningKey = raw.provisioningKey;
        if (typeof sponsor !== "string" || !isAddress(sponsor)) throw new Error("Invalid sponsor address");
        if (typeof provisioningKey !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(provisioningKey)) {
          throw new Error("Invalid provisioning key");
        }
        const identity = deriveManagedSignerIdentity(DEVNET_MANAGED_SIGNER_SECRET, sponsor, provisioningKey);
        return send(res, 201, {
          managedSigner: { ...identity, custody: "nuvem-managed" },
        });
      }
      const input = validate(raw as CreateVaultBody);
      if (url.pathname === "/agent-vaults/prepare") {
        await d.test.setBalance({ address: input.manager, value: parseEther("10") });
        const current = (await d.pub.readContract({
          address: USDG,
          abi: erc20Abi,
          functionName: "balanceOf",
          args: [input.manager],
        })) as bigint;
        await dealErc20(d, USDG, input.manager, current + input.initialStake6);
        return send(res, 200, { prepared: true, sponsor: input.manager, initialStake6: input.initialStake6.toString() });
      }

      if (url.pathname === "/agent-vaults") {
        const agent = validateAgent(raw as CreateAgentVaultBody);
        const operation = async () => {
          const sponsor = (await d.pub.readContract({
            address: p.agentRegistry,
            abi: agentRegistryAbi,
            functionName: "sponsorOf",
            args: [agent.agentId],
          })) as Address;
          if (sponsor.toLowerCase() !== agent.vault.manager.toLowerCase()) {
            throw new Error("Connected wallet is not the registered agent sponsor");
          }

          const active = (await d.pub.readContract({
            address: p.agentRegistry,
            abi: agentRegistryAbi,
            functionName: "isActive",
            args: [agent.agentId],
          })) as boolean;
          let backingHash: Hex | null = null;
          if (!active) {
            const block = await d.pub.getBlock();
            const nonce = (await d.pub.readContract({
              address: p.agentRegistry,
              abi: agentRegistryAbi,
              functionName: "backingNonce",
              args: [agent.agentId],
            })) as bigint;
            backingHash = keccak256(encodePacked(
              ["string", "bytes32", "address"],
              ["nuvem-devnet-world-backing-v1", agent.agentId, agent.vault.manager],
            ));
            const backing = {
              agentId: agent.agentId,
              sponsor: agent.vault.manager,
              signer: agent.signer,
              backingHash,
              agentBookBlock: block.number,
              validUntil: Number(block.timestamp + 7n * 24n * 60n * 60n),
              nonce,
            };
            const signature = await acct[AUXILIARY]!.signTypedData({
              domain: { name: "Nuvem AgentRegistry", version: "1", chainId: d.chainId, verifyingContract: p.agentRegistry },
              types: { WorldBacking: [
                { name: "agentId", type: "bytes32" },
                { name: "sponsor", type: "address" },
                { name: "signer", type: "address" },
                { name: "backingHash", type: "bytes32" },
                { name: "agentBookBlock", type: "uint64" },
                { name: "validUntil", type: "uint48" },
                { name: "nonce", type: "uint256" },
              ] },
              primaryType: "WorldBacking",
              message: backing,
            });
            await write(d, DEPLOYER, p.agentRegistry, agentRegistryAbi, "activate", [backing, signature]);
          }

          const deployed = await createAgentVault(d, p, {
            agentId: agent.agentId,
            sponsor: agent.vault.manager,
            name: agent.vault.name,
            symbol: agent.vault.symbol,
            assets: agent.assets,
            policy: agent.policy,
            economy: {
              PERF_FEE_BPS: String(agent.vault.perfFeeBps),
              FEE_MIN_BPS: String(agent.vault.feeMinBps),
              FEE_MAX_BPS: String(agent.vault.feeMaxBps),
              MGR_ENTRY_BPS: String(agent.vault.managerEntryShareBps),
              K_FACTOR: String(agent.vault.kFactor),
              PERIOD: String(agent.vault.periodDays * 24 * 60 * 60),
              COOLDOWN: String(agent.vault.cooldownHours * 60 * 60),
            },
          });
          const stakeEscrow = (await d.pub.readContract({
            address: deployed.fund,
            abi: fundAbi,
            functionName: "stakeEscrow",
          })) as Address;
          return { ...deployed, stakeEscrow, backingHash };
        };
        const queued = serial.then(operation, operation);
        serial = queued.then(() => undefined, () => undefined);
        const deployed = await queued;
        return send(res, 201, {
          ...deployed,
          agentId: agent.agentId,
          agentRegistry: p.agentRegistry,
          uniswapApiAdapter: p.uniswapApiAdapter,
          uniswapApiAdapterId: p.uniswapApiAdapterId.toString(),
          uniswapApprovalProxy: p.uniswapApprovalProxy,
          uniswapUniversalRouter: p.uniswapUniversalRouter,
          usdg: USDG,
          fundRegistry: p.fundRegistry,
          chainId: d.chainId,
          initialStake6: agent.vault.initialStake6.toString(),
          worldBacking: { mode: "devnet-mock", canonical: false, active: true },
        });
      }

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
