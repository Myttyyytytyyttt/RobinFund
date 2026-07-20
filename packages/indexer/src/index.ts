/**
 * Handlers de indexación. Reglas (las no-obvias vienen de la revisión adversarial):
 *  · Los agregados corrientes del fondo (totalShares, lpCount, lifetime*) se mantienen por eventos —
 *    exactos porque FundShare no es transferible: las shares SOLO se mueven por mint (DepositExecuted,
 *    PerfFeeCrystallized al FeeSplitter) y burn (WithdrawExecuted).
 *  · Los retiros del FEE SPLITTER no son de LP: actualizan la orden pero NO tocan lpCount, los
 *    lifetime ni posiciones, y en el feed van como fee_redeem (sin esto inflaban lifetimeWithdrawn6).
 *  · UPSERTS DEFENSIVOS: un Fund es operable entre su deploy y su register() (tx separadas), y el
 *    factory pattern solo indexa desde FundRegistered — una orden solicitada en ese hueco no tiene
 *    fila. Un db.update pelado sobre fila inexistente lanza RecordNotFoundError y PARA el indexer
 *    entero (DoS disparable por cualquier LP). Donde el evento de ejecución trae los datos, se
 *    reconstruye la fila; donde no (EntryFeeCharged, OrderCancelled), find + update condicional.
 *  · requestWinding NO emite StateChanged: WindingRequested implica exactamente Active→PendingWinding
 *    y el handler actualiza el estado (sin esto el frontend ofrecía depositar en un fondo winding).
 *  · db.find devuelve el objeto cacheado y update lo MUTA in place: capturar valores ANTES de updates.
 *  · Settled emite el precio PRE-dilución de la perf fee; el precio para TVL es el post-fee
 *    (PerfFeeCrystallized llega antes en la misma tx, así que aquí ya conocemos las shares de la fee).
 */
import { ponder } from "ponder:registry";
import {
  fund,
  lpPosition,
  deposit,
  withdrawal,
  inKindSlice,
  settlement,
  claim,
  trade,
  fundAsset,
  attestation,
  activity,
} from "ponder:schema";
import { FundAbi, FundShareAbi } from "../abis/generated";

type Ctx = { db: any; client: any };

async function feed(
  context: Ctx,
  event: any,
  kind: string,
  lp: `0x${string}` | null,
  amount: bigint | null,
  meta?: Record<string, unknown>,
): Promise<void> {
  await context.db.insert(activity).values({
    id: `${event.transaction.hash}-${event.log.logIndex}`,
    fund: event.log.address,
    kind,
    lp,
    amount,
    meta: meta ? JSON.stringify(meta, (_k, v) => (typeof v === "bigint" ? v.toString() : v)) : null,
    timestamp: event.block.timestamp,
    txHash: event.transaction.hash,
  });
}

// ---------- FundRegistry ----------

ponder.on("FundRegistry:FundRegistered", async ({ event, context }) => {
  const fundAddr = event.args.fund;
  // metadatos leídos on-chain una vez (cacheado por Ponder; todo inmutable en el Fund)
  const share = await context.client.readContract({
    abi: FundAbi,
    address: fundAddr,
    functionName: "share",
  });
  const [name, symbol, stakeEscrow, feeSplitter] = await Promise.all([
    context.client.readContract({ abi: FundShareAbi, address: share, functionName: "name" }),
    context.client.readContract({ abi: FundShareAbi, address: share, functionName: "symbol" }),
    context.client.readContract({ abi: FundAbi, address: fundAddr, functionName: "stakeEscrow" }),
    context.client.readContract({ abi: FundAbi, address: fundAddr, functionName: "FEE_SPLITTER" }),
  ]);

  await context.db.insert(fund).values({
    address: fundAddr,
    manager: event.args.manager,
    name: name as string,
    symbol: symbol as string,
    share: share as `0x${string}`,
    stakeEscrow: stakeEscrow as `0x${string}`,
    feeSplitter: feeSplitter as `0x${string}`,
    createdAt: event.block.timestamp,
    createdAtBlock: event.block.number,
    state: 0,
    frozen: false,
    guardianPaused: false,
    currentPeriod: 1n,
    lastPeWad: null,
    lastPePostFeeWad: null,
    lastSettledAt: null,
    totalShares: 0n,
    lpCount: 0,
    lifetimeDeposited6: 0n,
    lifetimeWithdrawn6: 0n,
  });
});

// ---------- Fund: depósitos ----------

ponder.on("Fund:DepositRequested", async ({ event, context }) => {
  const { orderId, lp, amount6 } = event.args;
  await context.db
    .insert(deposit)
    .values({
      id: `${event.log.address}-${orderId}`,
      fund: event.log.address,
      orderId,
      lp,
      amount6,
      status: "requested",
      requestedAt: event.block.timestamp,
      txHash: event.transaction.hash,
    })
    .onConflictDoNothing();
  await feed(context, event, "deposit_requested", lp, amount6, { orderId });
});

ponder.on("Fund:DepositExecuted", async ({ event, context }) => {
  const fundAddr = event.log.address;
  const { orderId, lp, amount6, sharesMinted } = event.args;

  // upsert: si la solicitud cayó en el hueco deploy→register, reconstruimos la fila aquí
  await context.db
    .insert(deposit)
    .values({
      id: `${fundAddr}-${orderId}`,
      fund: fundAddr,
      orderId,
      lp,
      amount6,
      status: "executed",
      sharesMinted,
      requestedAt: event.block.timestamp, // desconocido real (hueco): mejor aproximación
      executedAt: event.block.timestamp,
      txHash: event.transaction.hash,
      executedTxHash: event.transaction.hash,
    })
    .onConflictDoUpdate({
      status: "executed",
      sharesMinted,
      executedAt: event.block.timestamp,
      executedTxHash: event.transaction.hash,
    });

  const posId = `${fundAddr}-${lp}`;
  const existing = await context.db.find(lpPosition, { id: posId });
  const isNewHolder = !existing || existing.shares === 0n;
  if (existing) {
    await context.db.update(lpPosition, { id: posId }).set({
      shares: existing.shares + sharesMinted,
      deposited6: existing.deposited6 + amount6,
      lastActionAt: event.block.timestamp,
    });
  } else {
    await context.db.insert(lpPosition).values({
      id: posId,
      fund: fundAddr,
      lp,
      shares: sharesMinted,
      deposited6: amount6,
      withdrawn6: 0n,
      claimed6: 0n,
      firstDepositAt: event.block.timestamp,
      lastActionAt: event.block.timestamp,
    });
  }

  const f = await context.db.find(fund, { address: fundAddr });
  if (!f) return; // el fondo se registra antes de que el factory pattern entregue sus eventos
  await context.db.update(fund, { address: fundAddr }).set({
    totalShares: f.totalShares + sharesMinted,
    lifetimeDeposited6: f.lifetimeDeposited6 + amount6,
    lpCount: f.lpCount + (isNewHolder ? 1 : 0),
  });

  await feed(context, event, "deposit_executed", lp, amount6, { orderId, sharesMinted });
});

ponder.on("Fund:DepositRefunded", async ({ event, context }) => {
  const { orderId, lp, amount6, reason } = event.args;
  await context.db
    .insert(deposit)
    .values({
      id: `${event.log.address}-${orderId}`,
      fund: event.log.address,
      orderId,
      lp,
      amount6,
      status: "refunded",
      refundReason: reason,
      requestedAt: event.block.timestamp,
      txHash: event.transaction.hash,
      executedTxHash: event.transaction.hash,
    })
    .onConflictDoUpdate({ status: "refunded", refundReason: reason, executedTxHash: event.transaction.hash });
  await feed(context, event, "deposit_refunded", lp, amount6, { orderId, reason });
});

ponder.on("Fund:EntryFeeCharged", async ({ event, context }) => {
  // el evento no trae lp/amount: sin fila previa (hueco) no se puede reconstruir — degradar sin tirar
  const id = `${event.log.address}-${event.args.orderId}`;
  const row = await context.db.find(deposit, { id });
  if (row) await context.db.update(deposit, { id }).set({ fee6: event.args.fee6 });
  await feed(context, event, "entry_fee", null, event.args.fee6, {
    orderId: event.args.orderId,
    toManager6: event.args.toManager6,
    toProtocol6: event.args.toProtocol6,
  });
});

// ---------- Fund: retiros ----------

ponder.on("Fund:WithdrawRequested", async ({ event, context }) => {
  const { orderId, lp, shares, inKind } = event.args;
  const f = await context.db.find(fund, { address: event.log.address });
  const isFee = !!f && lp.toLowerCase() === f.feeSplitter.toLowerCase();
  await context.db
    .insert(withdrawal)
    .values({
      id: `${event.log.address}-${orderId}`,
      fund: event.log.address,
      orderId,
      lp,
      shares,
      inKind,
      status: "requested",
      requestedAt: event.block.timestamp,
      txHash: event.transaction.hash,
    })
    .onConflictDoNothing();
  await feed(context, event, isFee ? "fee_redeem_requested" : "withdraw_requested", lp, shares, {
    orderId,
    inKind,
  });
});

// InKindSlice llega ANTES que su WithdrawExecuted (misma tx, logIndex menor): acumula el valor por
// orden y deja el detalle por token; WithdrawExecuted cierra la orden y vuelca el total a agregados.
ponder.on("Fund:InKindSlice", async ({ event, context }) => {
  const fundAddr = event.log.address;
  const { orderId, token, amount, valueWad } = event.args;
  const wid = `${fundAddr}-${orderId}`;

  await context.db.insert(inKindSlice).values({
    id: `${event.transaction.hash}-${event.log.logIndex}`,
    fund: fundAddr,
    orderId,
    withdrawalId: wid,
    token,
    amount,
    valueWad,
    timestamp: event.block.timestamp,
    txHash: event.transaction.hash,
  });

  // sin fila (hueco deploy→register): el detalle queda en in_kind_slice; los agregados de ese
  // hueco ya se degradan en todo el indexer — find + update condicional, no upsert (falta lp/shares)
  const row = await context.db.find(withdrawal, { id: wid });
  if (row) {
    await context.db.update(withdrawal, { id: wid }).set({
      inKindValueWad: (row.inKindValueWad ?? 0n) + valueWad,
    });
  }
});

ponder.on("Fund:WithdrawExecuted", async ({ event, context }) => {
  const fundAddr = event.log.address;
  const { orderId, lp, shares, paid6, inKind } = event.args;

  // capturar ANTES del upsert (y antes de que update mute el objeto cacheado): el valor in-kind
  // acumulado por los InKindSlice de esta misma tx — paid6 solo lleva la pata USDG
  const prev = await context.db.find(withdrawal, { id: `${fundAddr}-${orderId}` });
  const inKindValue6 = inKind ? (prev?.inKindValueWad ?? 0n) / 10n ** 12n : 0n;
  const exit6 = paid6 + inKindValue6; // valor total que salió hacia el LP

  await context.db
    .insert(withdrawal)
    .values({
      id: `${fundAddr}-${orderId}`,
      fund: fundAddr,
      orderId,
      lp,
      shares,
      inKind,
      status: "executed",
      paid6,
      requestedAt: event.block.timestamp,
      executedAt: event.block.timestamp,
      txHash: event.transaction.hash,
      executedTxHash: event.transaction.hash,
    })
    .onConflictDoUpdate({
      status: "executed",
      paid6,
      inKind,
      executedAt: event.block.timestamp,
      executedTxHash: event.transaction.hash,
    });

  const f = await context.db.find(fund, { address: fundAddr });
  if (!f) return;

  // el burn de la perf fee redimida por el FeeSplitter NO es un retiro de LP
  if (lp.toLowerCase() === f.feeSplitter.toLowerCase()) {
    await context.db.update(fund, { address: fundAddr }).set({ totalShares: f.totalShares - shares });
    await feed(context, event, "fee_redeem", lp, exit6, { orderId, shares, inKind });
    return;
  }

  const posId = `${fundAddr}-${lp}`;
  const pos = await context.db.find(lpPosition, { id: posId });
  const newShares = pos ? pos.shares - shares : 0n;
  // capturar ANTES del update: find devuelve el objeto cacheado y el update lo MUTA in place
  const exitedFully = !!pos && pos.shares > 0n && newShares === 0n;
  if (pos) {
    await context.db.update(lpPosition, { id: posId }).set({
      shares: newShares,
      withdrawn6: pos.withdrawn6 + exit6,
      lastActionAt: event.block.timestamp,
    });
  }

  await context.db.update(fund, { address: fundAddr }).set({
    totalShares: f.totalShares - shares,
    lifetimeWithdrawn6: f.lifetimeWithdrawn6 + exit6,
    lpCount: f.lpCount - (exitedFully ? 1 : 0),
  });

  await feed(context, event, "withdraw_executed", lp, exit6, { orderId, shares, inKind, paid6, inKindValue6 });
});

ponder.on("Fund:OrderCancelled", async ({ event, context }) => {
  // isDeposit=true es código muerto en el contrato (cancelDeposit emite DepositRefunded);
  // se maneja igual por si un upgrade lo activa. Sin fila (hueco): no hay nada que marcar.
  const id = `${event.log.address}-${event.args.orderId}`;
  if (event.args.isDeposit) {
    const row = await context.db.find(deposit, { id });
    if (row) await context.db.update(deposit, { id }).set({ status: "refunded", refundReason: "cancelada" });
  } else {
    const row = await context.db.find(withdrawal, { id });
    if (row) await context.db.update(withdrawal, { id }).set({ status: "cancelled" });
  }
});

ponder.on("Fund:ConvertedToInKind", async ({ event, context }) => {
  const id = `${event.log.address}-${event.args.orderId}`;
  const row = await context.db.find(withdrawal, { id });
  if (row) await context.db.update(withdrawal, { id }).set({ inKind: true });
});

ponder.on("Fund:ForcedRedemption", async ({ event, context }) => {
  await feed(context, event, "forced_redemption", event.args.lp, event.args.shares);
});

// ---------- Fund: settlement y first-loss ----------

ponder.on("Fund:Settled", async ({ event, context }) => {
  const fundAddr = event.log.address;
  const { period, peWad, fundingWad, lambdaWad, degraded } = event.args;
  const id = `${fundAddr}-${period}`;

  // PerfFeeCrystallized se emite ANTES en la misma tx: sus shares ya están en totalShares y en la
  // fila settlement. peWad es PRE-dilución; el precio para TVL es el post-fee.
  const existing = await context.db.find(settlement, { id });
  const sFee = existing?.perfFeeShares ?? 0n;
  const f = await context.db.find(fund, { address: fundAddr });
  const supply = f ? f.totalShares : 0n;
  const pePostFeeWad = supply > 0n && sFee > 0n ? (peWad * (supply - sFee)) / supply : peWad;

  await context.db
    .insert(settlement)
    .values({
      id,
      fund: fundAddr,
      period,
      peWad,
      pePostFeeWad,
      fundingWad,
      lambdaWad,
      degraded,
      timestamp: event.block.timestamp,
      blockNumber: event.block.number,
      txHash: event.transaction.hash,
    })
    .onConflictDoUpdate({ peWad, pePostFeeWad, fundingWad, lambdaWad, degraded });

  if (f) {
    await context.db.update(fund, { address: fundAddr }).set({
      currentPeriod: period + 1n,
      lastPeWad: peWad,
      lastPePostFeeWad: pePostFeeWad,
      lastSettledAt: event.block.timestamp,
    });
  }

  await feed(context, event, "settled", null, peWad, { period, fundingWad, lambdaWad, degraded });
});

ponder.on("Fund:PerfFeeCrystallized", async ({ event, context }) => {
  const fundAddr = event.log.address;
  const { period, feeWad, sharesMinted } = event.args;
  await context.db
    .insert(settlement)
    .values({
      id: `${fundAddr}-${period}`,
      fund: fundAddr,
      period,
      peWad: 0n, // lo completa Settled (misma tx, logIndex posterior)
      fundingWad: 0n,
      lambdaWad: 0n,
      degraded: false,
      perfFeeWad: feeWad,
      perfFeeShares: sharesMinted,
      timestamp: event.block.timestamp,
      blockNumber: event.block.number,
      txHash: event.transaction.hash,
    })
    .onConflictDoUpdate({ perfFeeWad: feeWad, perfFeeShares: sharesMinted });

  // la perf fee mintea shares al FeeSplitter → cuentan en el supply (no en lpCount)
  const f = await context.db.find(fund, { address: fundAddr });
  if (f) await context.db.update(fund, { address: fundAddr }).set({ totalShares: f.totalShares + sharesMinted });
});

ponder.on("Fund:ClaimMaterialized", async ({ event, context }) => {
  const fundAddr = event.log.address;
  const { lp, period, claim6 } = event.args;
  await context.db
    .insert(claim)
    .values({
      id: `${fundAddr}-${period}-${lp}`,
      fund: fundAddr,
      lp,
      period,
      claim6,
      timestamp: event.block.timestamp,
    })
    .onConflictDoNothing();
  const pos = await context.db.find(lpPosition, { id: `${fundAddr}-${lp}` });
  if (pos) {
    await context.db.update(lpPosition, { id: `${fundAddr}-${lp}` }).set({ claimed6: pos.claimed6 + claim6 });
  }
  await feed(context, event, "claim", lp, claim6, { period });
});

// ---------- Fund: trading, estados, gobernanza ----------

ponder.on("Fund:Traded", async ({ event, context }) => {
  const { adapterId, tokenIn, tokenOut, spent, received, adverseWad } = event.args;
  await context.db.insert(trade).values({
    id: `${event.log.address}-${event.transaction.hash}-${event.log.logIndex}`,
    fund: event.log.address,
    adapterId,
    tokenIn,
    tokenOut,
    spent,
    received,
    adverseWad,
    timestamp: event.block.timestamp,
    txHash: event.transaction.hash,
  });
  await feed(context, event, "trade", null, spent, { tokenIn, tokenOut, received, adverseWad });
});

ponder.on("Fund:AssetRegistered", async ({ event, context }) => {
  await context.db
    .insert(fundAsset)
    .values({
      id: `${event.log.address}-${event.args.token}`,
      fund: event.log.address,
      token: event.args.token,
      registeredAt: event.block.timestamp,
    })
    .onConflictDoNothing();
});

ponder.on("Fund:StateChanged", async ({ event, context }) => {
  await context.db.update(fund, { address: event.log.address }).set({ state: Number(event.args.newState) });
  await feed(context, event, "state_changed", null, BigInt(event.args.newState));
});

ponder.on("Fund:FrozenDeclared", async ({ event, context }) => {
  await context.db.update(fund, { address: event.log.address }).set({ frozen: true });
  await feed(context, event, "frozen", null, null);
});

ponder.on("Fund:GuardianPauseSet", async ({ event, context }) => {
  await context.db.update(fund, { address: event.log.address }).set({ guardianPaused: event.args.paused });
  await feed(context, event, "guardian_pause", null, event.args.paused ? 1n : 0n);
});

ponder.on("Fund:WindingRequested", async ({ event, context }) => {
  // requestWinding NO emite StateChanged pero la transición Active→PendingWinding es exacta:
  // sin esto el frontend muestra Active (y ofrece depositar) durante días hasta el settlement
  await context.db.update(fund, { address: event.log.address }).set({ state: 1 });
  await feed(context, event, "winding_requested", null, BigInt(event.args.due));
});

// ---------- EligibilityGate ----------

ponder.on("EligibilityGate:Attested", async ({ event, context }) => {
  await context.db
    .insert(attestation)
    .values({
      account: event.args.account,
      expiry: BigInt(event.args.expiry),
      revokedAt: 0n,
      updatedAt: event.block.timestamp,
    })
    .onConflictDoUpdate({ expiry: BigInt(event.args.expiry), revokedAt: 0n, updatedAt: event.block.timestamp });
});

ponder.on("EligibilityGate:Revoked", async ({ event, context }) => {
  await context.db
    .insert(attestation)
    .values({
      account: event.args.account,
      expiry: 0n,
      revokedAt: BigInt(event.args.at),
      updatedAt: event.block.timestamp,
    })
    .onConflictDoUpdate({ revokedAt: BigInt(event.args.at), updatedAt: event.block.timestamp });
});
