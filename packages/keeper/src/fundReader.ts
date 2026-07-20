/**
 * Lector on-chain: construye el estado de un fondo que el keeper necesita para settlear.
 * Descubre el set de LPs desde los eventos DepositExecuted (todos los que alguna vez depositaron;
 * los que salieron aportan pérdida 0 por la regla de burn del NI) y lee el estado por LP.
 */
import {
  type Address,
  type PublicClient,
  getAddress,
} from "viem";
import { fundAbi, shareAbi, stakeEscrowAbi } from "./abi.js";
import { sharePriceWad, type LpState, type SettlementMark } from "./grossClaims.js";

const USDG_TO_WAD = 10n ** 12n;

export interface FundSnapshot {
  navWad: bigint;
  navValid: boolean;
  totalSupply: bigint;
  niAggregateWad: bigint;
  stakeAvailableWad: bigint;
  currentPeriod: bigint;
  settlementDue: bigint;
  state: number; // 0 Active, 1 PendingWinding, 2 Winding, 3 Closed
  frozen: boolean;
  guardianPaused: boolean;
  periodSeconds: bigint;
  withdrawCooldownSeconds: bigint;
  feeSplitter: Address;
  shareToken: Address;
}

/** Descubre las direcciones que alguna vez fueron LP (DepositExecuted.lp). */
export async function discoverLps(
  client: PublicClient,
  fund: Address,
  fromBlock: bigint,
  toBlock: bigint,
): Promise<Address[]> {
  const logs = await client.getContractEvents({
    address: fund,
    abi: fundAbi,
    eventName: "DepositExecuted",
    fromBlock,
    toBlock,
  });
  const set = new Set<string>();
  for (const log of logs) {
    const lp = (log.args as { lp?: Address }).lp;
    if (lp) set.add(getAddress(lp));
  }
  return [...set].map((a) => a as Address);
}

export async function readSnapshot(client: PublicClient, fund: Address): Promise<FundSnapshot> {
  const [navRes, totalSupply, niAgg, currentPeriod, due, state, frozen, guardianPaused, cfg, feeSplitter, shareToken, stakeEscrow] =
    await Promise.all([
      client.readContract({ address: fund, abi: fundAbi, functionName: "nav" }),
      readShare(client, fund, "totalSupply"),
      client.readContract({ address: fund, abi: fundAbi, functionName: "niAggregateWad" }),
      client.readContract({ address: fund, abi: fundAbi, functionName: "currentPeriod" }),
      client.readContract({ address: fund, abi: fundAbi, functionName: "settlementDue" }),
      client.readContract({ address: fund, abi: fundAbi, functionName: "state" }),
      client.readContract({ address: fund, abi: fundAbi, functionName: "frozen" }),
      client.readContract({ address: fund, abi: fundAbi, functionName: "guardianPaused" }),
      client.readContract({ address: fund, abi: fundAbi, functionName: "config" }),
      client.readContract({ address: fund, abi: fundAbi, functionName: "FEE_SPLITTER" }),
      client.readContract({ address: fund, abi: fundAbi, functionName: "share" }),
      client.readContract({ address: fund, abi: fundAbi, functionName: "stakeEscrow" }),
    ]);

  const stakeAvail = await client.readContract({
    address: stakeEscrow as Address,
    abi: stakeEscrowAbi,
    functionName: "stakeAvailable",
  });

  const nav = navRes as { navWad: bigint; valid: boolean };
  const config = cfg as readonly [number, number, number, number, number, number, number];

  return {
    navWad: nav.navWad,
    navValid: nav.valid,
    totalSupply,
    niAggregateWad: niAgg as bigint,
    stakeAvailableWad: (stakeAvail as bigint) * USDG_TO_WAD,
    currentPeriod: BigInt(currentPeriod as bigint | number),
    settlementDue: BigInt(due as bigint | number),
    state: Number(state),
    frozen: frozen as boolean,
    guardianPaused: guardianPaused as boolean,
    periodSeconds: BigInt(config[5]),
    withdrawCooldownSeconds: BigInt(config[6]),
    feeSplitter: getAddress(feeSplitter as Address),
    shareToken: getAddress(shareToken as Address),
  };
}

async function readShare(client: PublicClient, fund: Address, fn: "totalSupply"): Promise<bigint> {
  const shareAddr = await client.readContract({ address: fund, abi: fundAbi, functionName: "share" });
  return (await client.readContract({ address: shareAddr as Address, abi: shareAbi, functionName: fn })) as bigint;
}

/** Estado de un LP con su dirección (el runner la necesita para forceRedeem). */
export type AddressedLpState = LpState & { address: Address };

/** Lee el estado NI de cada LP (excluyendo el FeeSplitter). */
export async function readLpStates(
  client: PublicClient,
  fund: Address,
  shareToken: Address,
  feeSplitter: Address,
  lps: Address[],
): Promise<AddressedLpState[]> {
  const out: AddressedLpState[] = [];
  for (const lp of lps) {
    if (getAddress(lp) === feeSplitter) continue; // excluido de la contabilidad NI (§7.3)
    const [acct, shares] = await Promise.all([
      client.readContract({ address: fund, abi: fundAbi, functionName: "accountOf", args: [lp] }),
      client.readContract({ address: shareToken, abi: shareAbi, functionName: "balanceOf", args: [lp] }),
    ]);
    const a = acct as { niWad: bigint; vestTime: number };
    out.push({ address: getAddress(lp), niWad: a.niWad, shares: shares as bigint, vestTime: BigInt(a.vestTime) });
  }
  return out;
}

/** Construye la marca de settlement (Pe, markTime, period) desde el snapshot y el timestamp actual. */
export function buildMark(snap: FundSnapshot, markTime: bigint): SettlementMark {
  return {
    peWad: sharePriceWad(snap.navWad, snap.totalSupply),
    markTime,
    periodSeconds: snap.periodSeconds,
  };
}
