/**
 * DRILL COMPLETO: la vida entera de un fondo, de punta a punta, con keeper + compliance signer +
 * indexer corriendo como PROCESOS REALES. El keeper actúa por sus propios ticks; nosotros solo
 * movemos el tiempo, los precios y las tx de usuario, y esperamos a que el sistema reaccione.
 *
 * 9 actos (ver el README). Cada assert suma al scorecard; al final, resumen y teardown.
 *
 * Correr:  pnpm drill   (necesita RH_RPC_MAINNET en el .env raíz + foundry en PATH)
 */
import { erc20Abi, formatUnits, type Address } from "viem";
import {
  bootAnvil,
  dealErc20,
  now,
  setRhjBlocked,
  warpTo,
  write,
  DEPLOYER,
  MANAGER,
  LP1,
  LP2,
  LP3,
  acct,
  USDG,
  TSLA,
  type Devnet,
} from "./chain.js";
import { attest, createFund, deployProtocol, encodePoolKey, gateAbi, pushFeeds, mockFeedAbi, type Protocol } from "./deploy.js";
import { fundAbi, shareAbi, stakeEscrowAbi, gateRevokeAbi } from "./abis.js";
import {
  buildServices,
  gql,
  signerAdmit,
  signerRenew,
  signerRevoke,
  startServices,
  stopServices,
  type Services,
} from "./services.js";

const PORT = 8600 + (process.pid % 300);
const SIGNER_PORT = 8700 + (process.pid % 300);
const INDEXER_PORT = 42300 + (process.pid % 300);
const DAY = 24n * 3600n;

// ---------- scorecard ----------
let passed = 0;
let failed = 0;
const failures: string[] = [];
function check(name: string, cond: boolean, detail = ""): void {
  if (cond) {
    passed++;
    console.log(`  \x1b[32m✓\x1b[0m ${name}`);
  } else {
    failed++;
    failures.push(`${name}${detail ? ` — ${detail}` : ""}`);
    console.log(`  \x1b[31m✗\x1b[0m ${name}${detail ? ` — ${detail}` : ""}`);
  }
}
function act(n: number, title: string): void {
  console.log(`\n\x1b[1m\x1b[36mActo ${n} — ${title}\x1b[0m`);
}

/** Espera a que un predicado on-chain se cumpla (el keeper/monitor actuando en su bucle). */
async function waitFor(label: string, pred: () => Promise<boolean>, timeoutMs = 40_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await pred()) return true;
    await new Promise((r) => setTimeout(r, 1000));
  }
  console.log(`    \x1b[33m(timeout esperando: ${label})\x1b[0m`);
  return false;
}

async function gqlRetry(s: Services, query: string, pred: (d: any) => boolean, timeoutMs = 30_000): Promise<any> {
  const deadline = Date.now() + timeoutMs;
  let last: any = null;
  while (Date.now() < deadline) {
    try {
      last = await gql(s, query);
      if (pred(last)) return last;
    } catch {
      /* aún migrando */
    }
    await new Promise((r) => setTimeout(r, 1500));
  }
  return last;
}

// lectores
const rd = {
  state: (d: Devnet, f: Address) => d.pub.readContract({ address: f, abi: fundAbi, functionName: "state" }) as Promise<number>,
  period: (d: Devnet, f: Address) => d.pub.readContract({ address: f, abi: fundAbi, functionName: "currentPeriod" }) as Promise<bigint>,
  frozen: (d: Devnet, f: Address) => d.pub.readContract({ address: f, abi: fundAbi, functionName: "frozen" }) as Promise<boolean>,
  due: async (d: Devnet, f: Address) => BigInt((await d.pub.readContract({ address: f, abi: fundAbi, functionName: "settlementDue" })) as bigint | number),
  queues: (d: Devnet, f: Address) => d.pub.readContract({ address: f, abi: fundAbi, functionName: "queueLengths" }) as Promise<readonly [bigint, bigint]>,
  shareBal: (d: Devnet, share: Address, who: Address) => d.pub.readContract({ address: share, abi: shareAbi, functionName: "balanceOf", args: [who] }) as Promise<bigint>,
  usdg: (d: Devnet, who: Address) => d.pub.readContract({ address: USDG, abi: erc20Abi, functionName: "balanceOf", args: [who] }) as Promise<bigint>,
  tsla: (d: Devnet, who: Address) => d.pub.readContract({ address: TSLA, abi: erc20Abi, functionName: "balanceOf", args: [who] }) as Promise<bigint>,
  stakeAvail: (d: Devnet, esc: Address) => d.pub.readContract({ address: esc, abi: stakeEscrowAbi, functionName: "stakeAvailable" }) as Promise<bigint>,
  nav: (d: Devnet, f: Address) => d.pub.readContract({ address: f, abi: fundAbi, functionName: "nav" }) as Promise<readonly [bigint, boolean]>,
};

async function fundChildren(d: Devnet, f: Address): Promise<{ share: Address; stake: Address; feeSplitter: Address }> {
  const [share, stake, feeSplitter] = await Promise.all([
    d.pub.readContract({ address: f, abi: fundAbi, functionName: "share" }) as Promise<Address>,
    d.pub.readContract({ address: f, abi: fundAbi, functionName: "stakeEscrow" }) as Promise<Address>,
    d.pub.readContract({ address: f, abi: fundAbi, functionName: "FEE_SPLITTER" }) as Promise<Address>,
  ]);
  return { share, stake, feeSplitter };
}

/** Solicita depósito, avanza la latencia de cola, publica ronda fresca, y espera a que el keeper ejecute. */
async function depositAndExecute(d: Devnet, p: Protocol, s: Services, f: Address, who: number, amount6: bigint): Promise<void> {
  await write(d, who, USDG, erc20Abi, "approve", [f, amount6]);
  await write(d, who, f, fundAbi, "requestDeposit", [amount6]);
  const [depBefore] = await rd.queues(d, f);
  await warpTo(d, (await now(d)) + 700n); // > MIN_QUEUE_LATENCY (10 min)
  await pushFeeds(d, p); // ronda posterior a la solicitud (forward pricing)
  await waitFor(`batch ejecuta depósito de LP${who - 3}`, async () => {
    const [dep] = await rd.queues(d, f);
    return dep < depBefore;
  });
}

async function main(): Promise<void> {
  console.log("\x1b[1mRobinFund — drill de devnet local\x1b[0m");
  console.log("Compilando servicios (keeper, signer, indexer)…");
  buildServices();
  console.log("Levantando anvil (fork de mainnet 4663)…");
  const d = await bootAnvil(PORT);
  let services: Services | null = null;
  try {
    console.log(`  chain ${d.chainId} viva en ${d.rpcUrl}`);
    console.log("Desplegando el protocolo con los scripts reales…");
    const p = await deployProtocol(d);
    const fund = await createFund(d, p, "Devnet Alpha Fund", "DAF");
    const { share, stake, feeSplitter } = await fundChildren(d, fund);
    console.log(`  fondo: ${fund}`);

    console.log("Arrancando servicios (keeper + compliance signer + indexer)…");
    services = await startServices(d.rpcUrl, d.chainId, p, {
      signerPort: SIGNER_PORT,
      indexerPort: INDEXER_PORT,
      keeperIntervalS: 3,
    });
    const s = services;
    console.log(`  signer:  ${s.signerUrl}`);
    console.log(`  graphql: ${s.indexerUrl}/graphql`);

    // ===== Acto 1 — Onboarding vía la API real del signer =====
    act(1, "Onboarding (compliance signer)");
    // el manager ya fue atestado por el bootstrap del deploy (createFund lo exige); lo re-verificamos
    const mgrAtt = await attestViaBootstrap(d, p); // asegura manager elegible en el gate
    check("manager elegible en el gate", mgrAtt);
    let onboarded = 0;
    for (const [i, who] of [[1, LP1], [2, LP2], [3, LP3]] as const) {
      const r = await signerAdmit(s, {
        personId: `kyc-lp${i}`,
        address: acct[who]!.address,
        usPerson: false,
        jurisdiction: "ES",
      });
      if (r.ok && r.attestation) {
        const a = r.attestation;
        await write(d, who, p.eligibilityGate, gateAbi, "attest", [a.account, a.expiry, BigInt(a.nonce), a.signature]);
        onboarded++;
      }
    }
    check("3 LPs admitidos y atestados on-chain", onboarded === 3, `${onboarded}/3`);
    const usPerson = await signerAdmit(s, { personId: "kyc-us", address: acct[7]!.address, usPerson: true, jurisdiction: "US" });
    check("US person rechazado (Condición 28)", !usPerson.ok && usPerson.status === 403);

    // ===== Acto 2 — Capital: stake + depósitos + el keeper ejecuta =====
    act(2, "Capital (stake + depósitos, batches por el keeper)");
    await dealErc20(d, USDG, acct[MANAGER]!.address, 30_000_000000n);
    for (const lp of [LP1, LP2, LP3]) await dealErc20(d, USDG, acct[lp]!.address, 20_000_000000n);
    await write(d, MANAGER, USDG, erc20Abi, "approve", [stake, 5_000_000000n]);
    await write(d, MANAGER, stake, stakeEscrowAbi, "addStake", [5_000_000000n]);
    check("stake del manager bloqueado (5.000 USDG)", (await rd.stakeAvail(d, stake)) === 5_000_000000n);

    await depositAndExecute(d, p, s, fund, LP1, 3_000_000000n);
    await depositAndExecute(d, p, s, fund, LP2, 5_000_000000n);
    await depositAndExecute(d, p, s, fund, LP3, 2_000_000000n);
    const shLp1 = await rd.shareBal(d, share, acct[LP1]!.address);
    const shLp2 = await rd.shareBal(d, share, acct[LP2]!.address);
    const shLp3 = await rd.shareBal(d, share, acct[LP3]!.address);
    check("LP1 recibió shares", shLp1 > 0n);
    check("LP2 ~mayor posición que LP1", shLp2 > shLp1);
    check("LP3 recibió shares", shLp3 > 0n);

    // ===== Acto 3 — Trading real contra Uniswap v4 =====
    act(3, "Trading real (Uniswap v4 del fork)");
    const baselineTsla = (await d.pub.readContract({ address: p.tslaMockFeed, abi: mockFeedAbi, functionName: "answer" })) as bigint;
    const tslaBefore = await rd.tsla(d, fund);
    // compra en chunks de 1.000 USDG (un 4.000 de golpe dispara SlippageExceeded); paramos al primer rebote
    let bought = 0;
    for (let i = 0; i < 3; i++) {
      try {
        await write(d, MANAGER, fund, fundAbi, "execute", [0n, USDG, TSLA, 1_000_000000n, encodePoolKey()]);
        bought++;
      } catch {
        break; // guardarraíl de slippage: dejamos de comprar
      }
    }
    const tslaAfter = await rd.tsla(d, fund);
    check("el fondo compró TSLA en Uniswap v4", tslaAfter > tslaBefore, `${bought}×1k USDG → ${formatUnits(tslaAfter, 18)} TSLA`);
    const [navW, navValid] = await rd.nav(d, fund);
    check("NAV válido y valora acciones + USDG", navValid && navW > 0n);

    // ===== Acto 4 — Período con ganancia: perf fee =====
    act(4, "Período con ganancia (perf fee cristaliza)");
    const periodBefore = await rd.period(d, fund);
    await warpTo(d, (await rd.due(d, fund)) + 60n);
    await pushFeeds(d, p, (baselineTsla * 150n) / 100n); // TSLA +50% sobre baseline
    const settled4 = await waitFor("keeper settlea el período con ganancia", async () => (await rd.period(d, fund)) > periodBefore, 60_000);
    check("el keeper settleó (período avanzó)", settled4);
    const feeShares = await rd.shareBal(d, share, feeSplitter);
    check("perf fee cristalizada al FeeSplitter", feeShares > 0n);

    // ===== Acto 5 — Período con pérdida: first-loss REAL =====
    act(5, "Período con pérdida (first-loss: stake cubre)");
    const stakeBeforeLoss = await rd.stakeAvail(d, stake);
    const periodBeforeLoss = await rd.period(d, fund);
    await warpTo(d, (await rd.due(d, fund)) + 60n);
    await pushFeeds(d, p, (baselineTsla * 40n) / 100n); // TSLA a 0,4× baseline → LPs bajo su NI de por vida
    const settled5 = await waitFor("keeper settlea el período con pérdida", async () => (await rd.period(d, fund)) > periodBeforeLoss, 60_000);
    check("el keeper settleó el período con pérdida", settled5);
    const stakeAfterLoss = await rd.stakeAvail(d, stake);
    check("el stake del manager se slasheó (fondeó el first-loss)", stakeAfterLoss < stakeBeforeLoss,
      `${formatUnits(stakeBeforeLoss, 6)} → ${formatUnits(stakeAfterLoss, 6)}`);
    // un LP cobra su claim: _touch materializa al tocar; forzamos con claim()
    const lp1UsdgBefore = await rd.usdg(d, acct[LP1]!.address);
    await write(d, LP1, fund, fundAbi, "claim", []);
    const lp1UsdgAfter = await rd.usdg(d, acct[LP1]!.address);
    check("LP1 cobró su claim del first-loss", lp1UsdgAfter > lp1UsdgBefore,
      `+${formatUnits(lp1UsdgAfter - lp1UsdgBefore, 6)} USDG`);

    // ===== Acto 6 — Salidas variadas =====
    act(6, "Salidas (cash, in-kind, cancelación)");
    // LP2 sale cash entero
    const lp2Shares = await rd.shareBal(d, share, acct[LP2]!.address);
    await write(d, LP2, fund, fundAbi, "requestWithdraw", [lp2Shares, false]);
    // LP3 sale in-kind (recibe TSLA + USDG)
    const lp3Shares = await rd.shareBal(d, share, acct[LP3]!.address);
    await write(d, LP3, fund, fundAbi, "requestWithdraw", [lp3Shares, true]);
    const lp3TslaBefore = await rd.tsla(d, acct[LP3]!.address);
    await warpTo(d, (await now(d)) + DAY + 700n); // cooldown 24h + latencia
    await pushFeeds(d, p);
    const lp2Out = await waitFor("keeper ejecuta la salida cash de LP2", async () => (await rd.shareBal(d, share, acct[LP2]!.address)) === 0n, 60_000);
    check("LP2 salió cash (shares a 0)", lp2Out);
    const lp3Out = await waitFor("keeper ejecuta la salida in-kind de LP3", async () => (await rd.shareBal(d, share, acct[LP3]!.address)) === 0n, 60_000);
    check("LP3 salió in-kind", lp3Out);
    check("LP3 recibió TSLA en especie", (await rd.tsla(d, acct[LP3]!.address)) > lp3TslaBefore);

    // ===== Acto 7 — Compliance en acción (forceRedeem + G1) =====
    act(7, "Compliance (revoke → keeper forceRedeem; G1)");
    // re-depositamos LP1 para tener a quién forzar (ya cobró; sigue con shares del acto 2/5)
    const lp1Shares = await rd.shareBal(d, share, acct[LP1]!.address);
    if (lp1Shares === 0n) {
      await depositAndExecute(d, p, s, fund, LP1, 2_000_000000n);
    }
    const rev = await signerRevoke(s, acct[LP1]!.address);
    check("signer revocó a LP1 on-chain", rev.status === 200 && !!rev.txHash);
    const renew = await signerRenew(s, acct[LP1]!.address);
    check("G1: renovación del revocado denegada", renew.status === 403);
    await warpTo(d, (await now(d)) + 31n * DAY); // pasa la gracia de compliance (30d)
    await pushFeeds(d, p);
    const forced = await waitFor("keeper detecta inelegible y encola forceRedeem", async () => {
      const [, wd] = await rd.queues(d, fund);
      return wd > 0n || (await rd.shareBal(d, share, acct[LP1]!.address)) === 0n;
    }, 60_000);
    check("el keeper disparó forceRedeem sobre LP1", forced);

    // ===== Acto 8 — Simulacro de crisis: Frozen por RHJ =====
    act(8, "Crisis (RHJ bloquea el fondo → Frozen)");
    await setRhjBlocked(d, fund, true);
    const froze = await waitFor("keeper declara Frozen", async () => rd.frozen(d, fund), 60_000);
    check("el keeper declaró el fondo Frozen", froze);
    // un depósito nuevo debe rebotar en Frozen
    await write(d, LP2, USDG, erc20Abi, "approve", [fund, 1_000_000000n]);
    let depositRejected = false;
    try {
      await write(d, LP2, fund, fundAbi, "requestDeposit", [1_000_000000n]);
    } catch {
      depositRejected = true;
    }
    check("depósitos rechazados en Frozen", depositRejected);
    await setRhjBlocked(d, fund, false); // desbloqueamos para poder cerrar ordenado

    // ===== Acto 9 — Cierre ordenado =====
    act(9, "Cierre (winding → Winding/Closed)");
    // sacar el resto de LPs (el fondo quedó frozen en el acto 8: no puede liquidar TSLA, así que su
    // terminal correcto es Winding vía la válvula in-kind, no Closed)
    await drainToClose(d, p, s, fund, share);
    const reachedTerminal = await waitFor(
      "el keeper settlea PendingWinding → Winding",
      async () => (await rd.state(d, fund)) >= 2,
      50_000,
    );
    const st = await rd.state(d, fund);
    check("el fondo alcanzó un estado terminal de cierre (Winding/Closed)", reachedTerminal, `state=${st}`);

    // ===== Verificación cruzada en el indexer =====
    act(0, "Indexer (GraphQL) refleja todo");
    const fundsData = await gqlRetry(s, `{ funds { items { address name lpCount lifetimeDeposited6 lastPeWad } } }`, (x) => x?.funds?.items?.length > 0, 40_000);
    check("el indexer conoce el fondo", fundsData?.funds?.items?.length === 1);
    const setData = await gqlRetry(s, `{ settlements { items { period peWad fundingWad } } }`, (x) => (x?.settlements?.items?.length ?? 0) >= 2, 40_000);
    check("el indexer tiene la serie de precios (≥2 settlements)", (setData?.settlements?.items?.length ?? 0) >= 2);
    const lossSettle = (setData?.settlements?.items ?? []).find((x: any) => BigInt(x.fundingWad) > 0n);
    check("el indexer registró el período con first-loss (funding > 0)", !!lossSettle);
    const actData = await gqlRetry(s, `{ activitys { items { kind } } }`, (x) => (x?.activitys?.items?.length ?? 0) > 5, 40_000);
    const kinds = new Set((actData?.activitys?.items ?? []).map((x: any) => x.kind));
    check("el feed de actividad tiene depósitos, settlements y trades", kinds.has("deposit_executed") && kinds.has("settled") && kinds.has("trade"));

    // ===== scorecard =====
    console.log(`\n\x1b[1m${"─".repeat(48)}\x1b[0m`);
    console.log(`\x1b[1mScorecard:\x1b[0m ${passed} ✓  ${failed ? `\x1b[31m${failed} ✗\x1b[0m` : "0 ✗"}  de ${passed + failed}`);
    if (failures.length) {
      console.log("\nFallos:");
      for (const f of failures) console.log(`  · ${f}`);
    }
    console.log(failed === 0 ? "\n\x1b[32m\x1b[1mTODO EL SISTEMA FUNCIONA end-to-end.\x1b[0m" : "\n\x1b[33mHay fallos que revisar.\x1b[0m");
  } catch (e) {
    console.error("\n\x1b[31mDRILL ABORTADO:\x1b[0m", e instanceof Error ? e.stack : e);
    if (services) {
      console.error("\n--- keeper ---\n" + (services.logs.keeper ?? "").slice(-1500));
      console.error("\n--- signer ---\n" + (services.logs.signer ?? "").slice(-800));
    }
    failed++;
  } finally {
    if (services) stopServices(services);
    clearInterval(d.heartbeat);
    d.anvil.kill();
  }
  process.exit(failed === 0 ? 0 : 1);
}

/** Asegura que el manager esté atestado en el gate (createFund ya lo exige, esto es defensa). */
async function attestViaBootstrap(d: Devnet, p: Protocol): Promise<boolean> {
  const eligible = (await d.pub.readContract({
    address: p.eligibilityGate,
    abi: [{ type: "function", name: "isEligible", stateMutability: "view", inputs: [{ type: "address" }], outputs: [{ type: "bool" }] }],
    functionName: "isEligible",
    args: [acct[MANAGER]!.address],
  })) as boolean;
  return eligible;
}

/** Saca a los LPs restantes y liquida TSLA→USDG para poder cerrar. Best-effort (el cierre exacto
 * depende del residuo; el assert del acto 9 acepta Winding o Closed). */
async function drainToClose(d: Devnet, p: Protocol, s: Services, fund: Address, share: Address): Promise<void> {
  try {
    await write(d, MANAGER, fund, fundAbi, "requestWinding", []);
  } catch {
    /* puede estar ya en winding/closed */
  }
  // en Winding el manager liquida TSLA a USDG
  const tslaBal = await rd.tsla(d, fund);
  if (tslaBal > 0n) {
    try {
      await write(d, MANAGER, fund, fundAbi, "execute", [0n, TSLA, USDG, tslaBal, encodePoolKey()]);
    } catch {
      /* slippage/estado: seguimos */
    }
  }
  // in-kind saca a cualquiera que quede sin depender de NAV
  for (const lp of [LP1, LP2, LP3]) {
    const bal = await rd.shareBal(d, share, acct[lp]!.address);
    if (bal > 0n) {
      try {
        await write(d, lp, fund, fundAbi, "requestWithdraw", [bal, true]);
      } catch {
        /* ignore */
      }
    }
  }
  await warpTo(d, (await now(d)) + DAY + 700n);
  await pushFeeds(d, p);
  await waitFor("colas drenadas en cierre", async () => {
    const [, wd] = await rd.queues(d, fund);
    return wd === 0n;
  }, 40_000);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
