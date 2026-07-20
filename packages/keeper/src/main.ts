/**
 * Entry point del keeper: bucle de ticks sobre todos los fondos del FundRegistry.
 *
 * Config por env (el .env raíz del monorepo se carga solo):
 *   KEEPER_RPC_URL      — RPC (fallback: RH_RPC_MAINNET)
 *   KEEPER_PK           — clave del keeper (0x…). Sin ella el runner corre en dry-run.
 *   FUND_REGISTRY       — dirección del FundRegistry desplegado (obligatoria)
 *   ACCESS_REGISTRY     — ACCESS registry de RHJ (default: el de mainnet, AddressBook)
 *   KEEPER_START_BLOCK  — bloque del deploy del protocolo (default 0; acota el scan de eventos)
 *   KEEPER_INTERVAL_S   — segundos entre ticks (default 300)
 *   KEEPER_DRY_RUN      — "1" fuerza dry-run aunque haya KEEPER_PK
 *
 * Correr: pnpm start  (compila con tsc y ejecuta dist/main.js)
 */
import { createPublicClient, createWalletClient, defineChain, http, type Address } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { loadRootEnv } from "./env.js";
import { runTick, type KeeperConfig } from "./runner.js";

// ACCESS registry de RHJ en mainnet 4663 (AddressBook.sol — verificado on-chain en Fase 0)
const DEFAULT_ACCESS_REGISTRY = "0xe10b6f6B275de231345c20D14Ab812db62151b00" as Address;

async function main(): Promise<void> {
  loadRootEnv();

  const rpcUrl = process.env.KEEPER_RPC_URL ?? process.env.RH_RPC_MAINNET;
  if (!rpcUrl) throw new Error("falta KEEPER_RPC_URL o RH_RPC_MAINNET en el .env");
  const fundRegistry = process.env.FUND_REGISTRY as Address | undefined;
  if (!fundRegistry) throw new Error("falta FUND_REGISTRY (dirección del registry desplegado)");

  const pk = process.env.KEEPER_PK as `0x${string}` | undefined;
  const dryRun = process.env.KEEPER_DRY_RUN === "1" || !pk;
  const intervalMs = Number(process.env.KEEPER_INTERVAL_S ?? "300") * 1000;

  const publicClient = createPublicClient({ transport: http(rpcUrl) });
  const chainId = await publicClient.getChainId();
  const chain = defineChain({
    id: chainId,
    name: `robinhood-${chainId}`,
    nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
    rpcUrls: { default: { http: [rpcUrl] } },
  });
  const walletClient = pk
    ? createWalletClient({ account: privateKeyToAccount(pk), chain, transport: http(rpcUrl) })
    : null;

  const cfg: KeeperConfig = {
    fundRegistry,
    accessRegistry: (process.env.ACCESS_REGISTRY as Address | undefined) ?? DEFAULT_ACCESS_REGISTRY,
    fromBlock: BigInt(process.env.KEEPER_START_BLOCK ?? "0"),
    send: !dryRun,
  };

  console.log(
    JSON.stringify({
      msg: "keeper arrancado",
      chainId,
      fundRegistry,
      keeper: walletClient?.account.address ?? null,
      dryRun,
      intervalS: intervalMs / 1000,
    }),
  );

  let stopping = false;
  const stop = (): void => {
    stopping = true;
    console.log(JSON.stringify({ msg: "señal de parada — termino el tick en curso y salgo" }));
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);

  while (!stopping) {
    const startedAt = Date.now();
    try {
      const reports = await runTick(publicClient, walletClient, cfg);
      for (const r of reports) {
        console.log(
          JSON.stringify(
            {
              msg: "tick",
              fund: r.fund,
              action: r.action,
              intents: r.intents.map((i) => i.fn),
              sent: r.sent,
              error: r.error,
            },
            (_k, v: unknown) => (typeof v === "bigint" ? v.toString() : v),
          ),
        );
      }
    } catch (e) {
      console.error(JSON.stringify({ msg: "tick falló", error: e instanceof Error ? e.message : String(e) }));
    }
    const elapsed = Date.now() - startedAt;
    const rest = Math.max(0, intervalMs - elapsed);
    await new Promise((res) => setTimeout(res, rest));
  }
}

main().catch((e: unknown) => {
  console.error(e);
  process.exit(1);
});
