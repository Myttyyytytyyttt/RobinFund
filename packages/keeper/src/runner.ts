/**
 * Runner del keeper: por cada fondo del FundRegistry evalúa estado y dispara las acciones que tocan.
 *
 * Separación en dos capas (mismo patrón que settlement.ts):
 *  · `planActions` — PURA: dado el estado observado, devuelve la lista ordenada de tx a enviar.
 *  · `tickFund` / `runTick` — I/O: leen la chain, llaman al planner, envían las tx y esperan receipts.
 *
 * Reglas del planner (orden importa):
 *  1. Fondo bloqueado por RHJ y aún no Frozen → `declareFrozen` (§10.3; anula depósitos en cola).
 *  2. Settlement decidido:
 *     · NAV válido → `executeBatch(gross)` — settlea Y procesa colas en una sola tx.
 *     · NAV inválido (ventana degradada) → `settle(gross)` DIRECTO. Nunca executeBatch: haría el
 *       settle degradado y después revertiría (NavInvalid) al procesar colas, deshaciendo el settle.
 *  3. Sin settlement pendiente pero con órdenes en cola:
 *     · NAV válido → `executeBatch(gross)`.
 *     · NAV inválido con retiro in-kind ejecutable en cabeza → `executeInKindWithdrawals` (válvula D12).
 *  4. LPs inelegibles pasada la gracia de 30d → `forceRedeem(lp)` (§10.2, permissionless).
 */
import { type Address, type PublicClient, type WalletClient } from "viem";
import { fundAbi, fundRegistryAbi, gateAbi } from "./abi.js";
import { assessFund, type FundAssessment, type SettleAction } from "./settlement.js";
import { checkFundBlocked } from "./monitors.js";
import { shouldForceRedeem } from "./monitors.js";
import type { FundSnapshot } from "./fundReader.js";

export type TxIntent =
  | { fn: "declareFrozen"; args: readonly [] }
  | { fn: "settle"; args: readonly [bigint] }
  | { fn: "executeBatch"; args: readonly [bigint] }
  | { fn: "executeInKindWithdrawals"; args: readonly [] }
  | { fn: "forceRedeem"; args: readonly [Address] };

export interface PlanInput {
  snap: FundSnapshot;
  queues: { deposits: bigint; withdrawals: bigint };
  action: SettleAction;
  grossClaimsWad: bigint;
  /** ¿El ACCESS registry de RHJ tiene bloqueado al fondo? */
  blocked: boolean;
  /** Con NAV inválido: ¿la cabeza de la cola de retiros es in-kind con cooldown vencido? */
  headWithdrawInKindReady: boolean;
  /** LPs inelegibles con gracia vencida y shares vivas. */
  redeemables: Address[];
}

export function planActions(p: PlanInput): TxIntent[] {
  const out: TxIntent[] = [];

  if (p.blocked && !p.snap.frozen) out.push({ fn: "declareFrozen", args: [] });

  const hasQueued = p.queues.deposits + p.queues.withdrawals > 0n;
  if (p.action.kind === "settle") {
    if (p.snap.navValid) out.push({ fn: "executeBatch", args: [p.action.grossClaimsWad] });
    else out.push({ fn: "settle", args: [p.action.grossClaimsWad] });
  } else if (hasQueued && p.snap.navValid && p.snap.state !== 3) {
    out.push({ fn: "executeBatch", args: [p.grossClaimsWad] });
  }

  // válvula in-kind: con NAV inválido los retiros in-kind no esperan a nadie (D12/S4)
  if (!p.snap.navValid && p.queues.withdrawals > 0n && p.headWithdrawInKindReady) {
    out.push({ fn: "executeInKindWithdrawals", args: [] });
  }

  for (const lp of p.redeemables) out.push({ fn: "forceRedeem", args: [lp] });
  return out;
}

// ---------- Capa I/O ----------

export interface KeeperConfig {
  fundRegistry: Address;
  /** ACCESS registry de RHJ (AddressBook.ACCESS_REGISTRY); null desactiva el monitor de bloqueo. */
  accessRegistry: Address | null;
  /** Bloque desde el que buscar eventos DepositExecuted (deploy del protocolo). */
  fromBlock: bigint;
  /** false = dry-run: planifica y reporta pero no envía ninguna tx. */
  send: boolean;
}

export interface SentTx {
  fn: TxIntent["fn"];
  hash: `0x${string}`;
  status: "success" | "reverted";
}

export interface FundReport {
  fund: Address;
  action: SettleAction;
  preview: { fundingWad: bigint; lambdaWad: bigint };
  intents: TxIntent[];
  sent: SentTx[];
  error?: string;
}

export async function listFunds(client: PublicClient, registry: Address): Promise<Address[]> {
  const count = (await client.readContract({
    address: registry,
    abi: fundRegistryAbi,
    functionName: "fundCount",
  })) as bigint;
  const out: Address[] = [];
  for (let i = 0n; i < count; i++) {
    out.push(
      (await client.readContract({
        address: registry,
        abi: fundRegistryAbi,
        functionName: "funds",
        args: [i],
      })) as Address,
    );
  }
  return out;
}

/** Reúne los insumos del planner para un fondo (solo lecturas). */
export async function gatherPlanInput(
  publicClient: PublicClient,
  fund: Address,
  cfg: KeeperConfig,
  assessment?: FundAssessment,
): Promise<{ assess: FundAssessment; input: PlanInput }> {
  const assess = assessment ?? (await assessFund(publicClient, fund, cfg.fromBlock));
  const { snap, nowSeconds } = assess;

  const [dep, wd] = (await publicClient.readContract({
    address: fund,
    abi: fundAbi,
    functionName: "queueLengths",
  })) as readonly [bigint, bigint];

  const blocked = cfg.accessRegistry
    ? (await checkFundBlocked(publicClient, cfg.accessRegistry, fund)) !== null
    : false;

  // cabeza de la cola de retiros: solo importa con NAV inválido (válvula in-kind)
  let headWithdrawInKindReady = false;
  if (!snap.navValid && wd > 0n) {
    const head = (await publicClient.readContract({
      address: fund,
      abi: fundAbi,
      functionName: "withdrawHead",
    })) as bigint;
    const o = (await publicClient.readContract({
      address: fund,
      abi: fundAbi,
      functionName: "withdrawQueue",
      args: [head],
    })) as readonly [Address, bigint, bigint | number, boolean, boolean];
    const requestTime = BigInt(o[2]);
    headWithdrawInKindReady =
      o[4] && !o[3] && nowSeconds >= requestTime + snap.withdrawCooldownSeconds;
  }

  // compliance: LPs con shares vivas e inelegibles pasada la gracia
  const redeemables: Address[] = [];
  const gate = (await publicClient.readContract({
    address: fund,
    abi: fundAbi,
    functionName: "GATE",
  })) as Address;
  for (const lp of assess.lps) {
    if (lp.shares === 0n) continue;
    const since = (await publicClient.readContract({
      address: gate,
      abi: gateAbi,
      functionName: "ineligibleSince",
      args: [lp.address],
    })) as bigint | number;
    if (shouldForceRedeem(BigInt(since), nowSeconds)) redeemables.push(lp.address);
  }

  const input: PlanInput = {
    snap,
    queues: { deposits: dep, withdrawals: wd },
    action: assess.action,
    grossClaimsWad: assess.grossClaimsWad,
    blocked,
    headWithdrawInKindReady,
    redeemables,
  };
  return { assess, input };
}

/** Un ciclo completo sobre UN fondo: evaluar → planificar → (send) ejecutar. */
export async function tickFund(
  publicClient: PublicClient,
  walletClient: WalletClient | null,
  fund: Address,
  cfg: KeeperConfig,
): Promise<FundReport> {
  const { assess, input } = await gatherPlanInput(publicClient, fund, cfg);
  const intents = planActions(input);
  const sent: SentTx[] = [];

  if (cfg.send && intents.length > 0) {
    if (!walletClient?.account) throw new Error("send=true requiere walletClient con account");
    for (const intent of intents) {
      const hash = await walletClient.writeContract({
        address: fund,
        abi: fundAbi,
        functionName: intent.fn,
        args: intent.args as never,
        account: walletClient.account,
        chain: walletClient.chain ?? null,
      });
      const receipt = await publicClient.waitForTransactionReceipt({ hash });
      sent.push({ fn: intent.fn, hash, status: receipt.status });
      if (receipt.status === "reverted") break; // no seguir apilando sobre un estado inesperado
    }
  }

  return { fund, action: assess.action, preview: assess.preview, intents, sent };
}

/** Un ciclo sobre TODOS los fondos del registry. Los errores por fondo no tumban el tick. */
export async function runTick(
  publicClient: PublicClient,
  walletClient: WalletClient | null,
  cfg: KeeperConfig,
): Promise<FundReport[]> {
  const funds = await listFunds(publicClient, cfg.fundRegistry);
  const reports: FundReport[] = [];
  for (const fund of funds) {
    try {
      reports.push(await tickFund(publicClient, walletClient, fund, cfg));
    } catch (e) {
      reports.push({
        fund,
        action: { kind: "wait", reason: "error" },
        preview: { fundingWad: 0n, lambdaWad: 0n },
        intents: [],
        sent: [],
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }
  return reports;
}
