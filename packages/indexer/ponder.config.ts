/**
 * Config del indexer (SPEC §12, capa 2). Indexa:
 *  · FundRegistry (dirección fija) — el índice de fondos
 *  · Fund — TODOS los fondos, descubiertos por factory pattern desde FundRegistered
 *
 * Env (el .env raíz del monorepo se carga solo):
 *   INDEXER_RPC_URL     — RPC (fallback: RH_RPC_MAINNET)
 *   FUND_REGISTRY       — dirección del FundRegistry (obligatoria)
 *   INDEXER_START_BLOCK — bloque del deploy del protocolo (acota el backfill)
 *   INDEXER_CHAIN_ID    — default 4663 (mainnet Robinhood Chain)
 *   PONDER_PGLITE_DIR   — dir de la BD embebida (default ./.ponder/pglite); DATABASE_URL → Postgres
 */
import { createConfig, factory } from "ponder";
import { parseAbiItem } from "viem";
import { FundAbi, FundRegistryAbi } from "./abis/generated";
import { loadRootEnv } from "./env";

loadRootEnv();

const rpc = process.env.INDEXER_RPC_URL ?? process.env.RH_RPC_MAINNET;
if (!rpc) throw new Error("falta INDEXER_RPC_URL o RH_RPC_MAINNET");
const fundRegistry = process.env.FUND_REGISTRY as `0x${string}` | undefined;
if (!fundRegistry) throw new Error("falta FUND_REGISTRY");
const startBlock = Number(process.env.INDEXER_START_BLOCK ?? "0");

export default createConfig({
  database: process.env.DATABASE_URL
    ? { kind: "postgres", connectionString: process.env.DATABASE_URL }
    : { kind: "pglite", directory: process.env.PONDER_PGLITE_DIR ?? "./.ponder/pglite" },
  chains: {
    robinhood: {
      id: Number(process.env.INDEXER_CHAIN_ID ?? "4663"),
      rpc,
    },
  },
  contracts: {
    FundRegistry: {
      abi: FundRegistryAbi,
      chain: "robinhood",
      address: fundRegistry,
      startBlock,
    },
    Fund: {
      abi: FundAbi,
      chain: "robinhood",
      address: factory({
        address: fundRegistry,
        event: parseAbiItem("event FundRegistered(address indexed fund, address indexed manager)"),
        parameter: "fund",
        startBlock,
      }),
      startBlock,
    },
  },
});
