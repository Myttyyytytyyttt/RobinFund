/**
 * Lógica de decisión del settlement (pura, testeable) + orquestación.
 *
 * El keeper es el que llama `settle(grossClaims)` en la primera ventana válida ≥ due (§9). Separamos
 * la DECISIÓN (qué hacer, dado un snapshot y el timestamp) del EFECTO (enviar la tx), para poder
 * testear la decisión sin cadena.
 *
 * El reloj de referencia es SIEMPRE el timestamp del último bloque, no el de pared: el contrato
 * compara contra block.timestamp, y en una chain con drift (o un anvil warpeado) el reloj de pared
 * decidiría mal.
 */
import { type Address, type PublicClient, type WalletClient } from "viem";
import { fundAbi } from "./abi.js";
import { computeGrossClaims, previewSettlement } from "./grossClaims.js";
import {
  readSnapshot,
  discoverLps,
  readLpStates,
  buildMark,
  type FundSnapshot,
  type AddressedLpState,
} from "./fundReader.js";

export type SettleAction =
  | { kind: "settle"; grossClaimsWad: bigint; reason: string }
  | { kind: "wait"; reason: string };

/**
 * Decide si settlear AHORA. El settlement solo procede si está due y el NAV es válido (o degradado
 * tras MAX_SETTLEMENT_DELAY, que el contrato maneja — aquí solo evitamos llamar cuando revertiría).
 */
export function decideSettle(
  snap: FundSnapshot,
  nowSeconds: bigint,
  grossClaimsWad: bigint,
  maxSettlementDelaySeconds = BigInt(7 * 24 * 3600),
): SettleAction {
  if (snap.state === 3) return { kind: "wait", reason: "fondo Closed" };
  if (nowSeconds < snap.settlementDue) {
    return { kind: "wait", reason: `settlement no due (faltan ${snap.settlementDue - nowSeconds}s)` };
  }
  const degradedWindowOpen = nowSeconds >= snap.settlementDue + maxSettlementDelaySeconds;
  if (!snap.navValid && !degradedWindowOpen) {
    return { kind: "wait", reason: "NAV inválido y ventana degradada no abierta aún" };
  }
  return {
    kind: "settle",
    grossClaimsWad,
    reason: snap.navValid ? "due + NAV válido" : "due + settlement degradado (7d sin ventana)",
  };
}

/** Evaluación completa de un fondo: snapshot + LPs + grossClaims + decisión. Solo lecturas. */
export interface FundAssessment {
  snap: FundSnapshot;
  nowSeconds: bigint; // timestamp del último bloque
  lps: AddressedLpState[];
  grossClaimsWad: bigint;
  action: SettleAction;
  preview: { fundingWad: bigint; lambdaWad: bigint };
}

export async function assessFund(
  publicClient: PublicClient,
  fund: Address,
  fromBlock: bigint,
): Promise<FundAssessment> {
  const snap = await readSnapshot(publicClient, fund);
  const latest = await publicClient.getBlock();
  const now = latest.timestamp;

  // computar grossClaims desde el estado on-chain de los LPs
  const lpAddrs = await discoverLps(publicClient, fund, fromBlock, latest.number);
  const lps = await readLpStates(publicClient, fund, snap.shareToken, snap.feeSplitter, lpAddrs);
  const mark = buildMark(snap, now);
  const grossClaimsWad = computeGrossClaims(lps, mark);

  const action = decideSettle(snap, now, grossClaimsWad);
  const supplyLp = snap.totalSupply; // fee-splitter shares se restan on-chain; aquí es aproximación de preview
  const preview = previewSettlement({
    grossClaimsWad,
    niAggregateWad: snap.niAggregateWad,
    supplyLpWad: supplyLp,
    peWad: mark.peWad,
    stakeAvailableWad: snap.stakeAvailableWad,
    frozen: snap.frozen,
  });

  return { snap, nowSeconds: now, lps, grossClaimsWad, action, preview };
}

export interface RunResult {
  action: SettleAction;
  preview?: { fundingWad: bigint; lambdaWad: bigint };
}

/**
 * Corre el ciclo de settlement de UN fondo: lee estado, computa grossClaims, decide, y (si toca)
 * envía `settle`. `send=false` hace dry-run (solo devuelve la decisión).
 */
export async function runSettlement(
  publicClient: PublicClient,
  walletClient: WalletClient | null,
  fund: Address,
  opts: { fromBlock: bigint; send: boolean; account?: Address },
): Promise<RunResult> {
  const { action, preview } = await assessFund(publicClient, fund, opts.fromBlock);

  if (action.kind === "settle" && opts.send) {
    if (!walletClient || !opts.account) throw new Error("send=true requiere walletClient + account");
    await walletClient.writeContract({
      address: fund,
      abi: fundAbi,
      functionName: "settle",
      args: [action.grossClaimsWad],
      account: opts.account,
      chain: null,
    });
  }
  return { action, preview };
}
