/**
 * Lógica de decisión del settlement (pura, testeable) + orquestación.
 *
 * El keeper es el que llama `settle(grossClaims)` en la primera ventana válida ≥ due (§9). Separamos
 * la DECISIÓN (qué hacer, dado un snapshot y el timestamp) del EFECTO (enviar la tx), para poder
 * testear la decisión sin cadena.
 */
import { type Address, type PublicClient, type WalletClient } from "viem";
import { fundAbi } from "./abi.js";
import { computeGrossClaims, previewSettlement } from "./grossClaims.js";
import { readSnapshot, discoverLps, readLpStates, buildMark, type FundSnapshot } from "./fundReader.js";

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
  const snap = await readSnapshot(publicClient, fund);
  const now = BigInt(Math.floor(Date.now() / 1000));

  // computar grossClaims desde el estado on-chain de los LPs
  const currentBlock = await publicClient.getBlockNumber();
  const lps = await discoverLps(publicClient, fund, opts.fromBlock, currentBlock);
  const lpStates = await readLpStates(publicClient, fund, snap.shareToken, snap.feeSplitter, lps);
  const mark = buildMark(snap, now);
  const grossClaimsWad = computeGrossClaims(lpStates, mark);

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
