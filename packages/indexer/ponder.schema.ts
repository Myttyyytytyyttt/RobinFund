/**
 * Schema del indexer — diseñado desde las queries del frontend:
 *  · Explore: lista de fondos con stats (TVL = totalShares × lastPePostFeeWad, LPs, estado, manager)
 *  · Fund detail: serie de precios (settlements), actividad, cartera (assets), colas
 *  · Portfolio del LP: posiciones, órdenes vivas, claims cobrados
 *  · Compliance: estado de atestaciones
 *
 * Convenciones: cantidades USDG en *6 (6 dec), precios/shares en WAD (18 dec) como bigint crudo —
 * el frontend formatea. Timestamps en segundos (bigint). IDs compuestos con "-".
 */
import { onchainTable, index } from "ponder";

export const fund = onchainTable(
  "fund",
  (t) => ({
    address: t.hex().primaryKey(),
    manager: t.hex().notNull(),
    name: t.text().notNull(),
    symbol: t.text().notNull(),
    share: t.hex().notNull(),
    stakeEscrow: t.hex().notNull(),
    feeSplitter: t.hex().notNull(), // sus retiros NO son de LP (se excluyen de agregados y posiciones)
    createdAt: t.bigint().notNull(),
    createdAtBlock: t.bigint().notNull(),
    // estado vivo (actualizado por eventos; PendingWinding se infiere de WindingRequested)
    state: t.integer().notNull(), // 0 Active, 1 PendingWinding, 2 Winding, 3 Closed
    frozen: t.boolean().notNull(),
    guardianPaused: t.boolean().notNull(),
    currentPeriod: t.bigint().notNull(),
    lastPeWad: t.bigint(), // precio a la marca del último settlement (canónico de la spec, PRE-dilución de la perf fee)
    lastPePostFeeWad: t.bigint(), // precio POST-perf-fee — usar ESTE para TVL = totalShares × lastPePostFeeWad
    lastSettledAt: t.bigint(),
    // agregados corrientes (excluyen al FeeSplitter)
    totalShares: t.bigint().notNull(), // supply total, INCLUYE las shares del FeeSplitter
    lpCount: t.integer().notNull(), // holders LP con shares > 0
    lifetimeDeposited6: t.bigint().notNull(),
    lifetimeWithdrawn6: t.bigint().notNull(), // solo cash USDG (in-kind: solo su pata USDG — ver README)
  }),
  (table) => ({
    managerIdx: index().on(table.manager),
  }),
);

export const lpPosition = onchainTable(
  "lp_position",
  (t) => ({
    id: t.text().primaryKey(), // `${fund}-${lp}`
    fund: t.hex().notNull(),
    lp: t.hex().notNull(),
    shares: t.bigint().notNull(),
    deposited6: t.bigint().notNull(), // bruto ejecutado
    withdrawn6: t.bigint().notNull(), // cash pagado (in-kind: solo la pata USDG)
    claimed6: t.bigint().notNull(), // claims del first-loss cobrados
    firstDepositAt: t.bigint().notNull(),
    lastActionAt: t.bigint().notNull(),
  }),
  (table) => ({
    fundIdx: index().on(table.fund),
    lpIdx: index().on(table.lp),
  }),
);

export const deposit = onchainTable(
  "deposit",
  (t) => ({
    id: t.text().primaryKey(), // `${fund}-${orderId}`
    fund: t.hex().notNull(),
    orderId: t.bigint().notNull(),
    lp: t.hex().notNull(),
    amount6: t.bigint().notNull(),
    // "cancelled" no ocurre para depósitos: cancelDeposit emite DepositRefunded("cancelada")
    status: t.text().notNull(), // requested | executed | refunded
    sharesMinted: t.bigint(),
    fee6: t.bigint(),
    refundReason: t.text(),
    requestedAt: t.bigint().notNull(),
    executedAt: t.bigint(),
    txHash: t.hex().notNull(), // tx de la SOLICITUD
    executedTxHash: t.hex(), // tx del batch que la ejecutó/refundó
  }),
  (table) => ({
    fundIdx: index().on(table.fund),
    lpIdx: index().on(table.lp),
  }),
);

export const withdrawal = onchainTable(
  "withdrawal",
  (t) => ({
    id: t.text().primaryKey(), // `${fund}-${orderId}`
    fund: t.hex().notNull(),
    orderId: t.bigint().notNull(),
    lp: t.hex().notNull(),
    shares: t.bigint().notNull(),
    inKind: t.boolean().notNull(),
    status: t.text().notNull(), // requested | executed | cancelled
    paid6: t.bigint(), // in-kind: SOLO la pata USDG (el valor de los tokens entregados no se emite — fleco de contrato)
    requestedAt: t.bigint().notNull(),
    executedAt: t.bigint(),
    txHash: t.hex().notNull(),
    executedTxHash: t.hex(),
  }),
  (table) => ({
    fundIdx: index().on(table.fund),
    lpIdx: index().on(table.lp),
  }),
);

/** Serie de precios + first-loss por período: la línea del chart del fondo. */
export const settlement = onchainTable(
  "settlement",
  (t) => ({
    id: t.text().primaryKey(), // `${fund}-${period}`
    fund: t.hex().notNull(),
    period: t.bigint().notNull(),
    peWad: t.bigint().notNull(), // precio a la marca (pre-dilución de la perf fee)
    pePostFeeWad: t.bigint(), // precio tras mintear la perf fee (para TVL/valor de posición)
    fundingWad: t.bigint().notNull(),
    lambdaWad: t.bigint().notNull(),
    degraded: t.boolean().notNull(),
    perfFeeWad: t.bigint(),
    perfFeeShares: t.bigint(),
    timestamp: t.bigint().notNull(),
    blockNumber: t.bigint().notNull(),
    txHash: t.hex().notNull(),
  }),
  (table) => ({
    fundIdx: index().on(table.fund),
  }),
);

export const claim = onchainTable(
  "claim",
  (t) => ({
    id: t.text().primaryKey(), // `${fund}-${period}-${lp}`
    fund: t.hex().notNull(),
    lp: t.hex().notNull(),
    period: t.bigint().notNull(),
    claim6: t.bigint().notNull(),
    timestamp: t.bigint().notNull(),
  }),
  (table) => ({
    fundIdx: index().on(table.fund),
    lpIdx: index().on(table.lp),
  }),
);

export const trade = onchainTable(
  "trade",
  (t) => ({
    id: t.text().primaryKey(), // `${fund}-${txHash}-${logIndex}`
    fund: t.hex().notNull(),
    adapterId: t.bigint().notNull(),
    tokenIn: t.hex().notNull(),
    tokenOut: t.hex().notNull(),
    spent: t.bigint().notNull(),
    received: t.bigint().notNull(),
    adverseWad: t.bigint().notNull(),
    timestamp: t.bigint().notNull(),
    txHash: t.hex().notNull(),
  }),
  (table) => ({
    fundIdx: index().on(table.fund),
  }),
);

/** Activos que el fondo ha operado alguna vez (composición de cartera; balances se leen live). */
export const fundAsset = onchainTable(
  "fund_asset",
  (t) => ({
    id: t.text().primaryKey(), // `${fund}-${token}`
    fund: t.hex().notNull(),
    token: t.hex().notNull(),
    registeredAt: t.bigint().notNull(),
  }),
  (table) => ({
    fundIdx: index().on(table.fund),
  }),
);

export const attestation = onchainTable("attestation", (t) => ({
  account: t.hex().primaryKey(),
  expiry: t.bigint().notNull(),
  revokedAt: t.bigint().notNull(), // 0 = activa
  updatedAt: t.bigint().notNull(),
}));

/** Feed unificado de actividad por fondo (la capa social del frontend pinta desde aquí). */
export const activity = onchainTable(
  "activity",
  (t) => ({
    id: t.text().primaryKey(), // `${txHash}-${logIndex}`
    fund: t.hex().notNull(),
    kind: t.text().notNull(), // deposit_requested | deposit_executed | deposit_refunded | withdraw_requested | withdraw_executed | fee_redeem_requested | fee_redeem | settled | claim | trade | state_changed | frozen | guardian_pause | forced_redemption | winding_requested | entry_fee
    lp: t.hex(), // null en eventos de fondo
    amount: t.bigint(), // magnitud principal del evento (semántica según kind)
    meta: t.text(), // JSON string con el detalle específico (órdenes: incluye orderId)
    timestamp: t.bigint().notNull(),
    txHash: t.hex().notNull(),
  }),
  (table) => ({
    fundIdx: index().on(table.fund),
    timestampIdx: index().on(table.timestamp),
  }),
);
