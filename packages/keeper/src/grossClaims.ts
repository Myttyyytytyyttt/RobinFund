/**
 * Cálculo de grossClaims para el settlement (SPEC §6, replica `_touch`/`_settle` de Fund.sol).
 *
 * El first-loss del protocolo necesita que un actor OFF-CHAIN sume la pérdida vesteada de cada LP y
 * se la pase a `settle(grossClaimsWad)` — el contrato no puede iterar todos los LPs on-chain. Este
 * módulo es la fuente de verdad de ese cálculo y DEBE coincidir bit a bit con la aritmética WAD del
 * contrato. Consecuencia de discrepar: `λ = min(1, funding/grossClaims)` sale mal escalado (efecto
 * de reparto acotado — NUNCA afecta a la solvencia, porque `funding = min(stake, neteado)` es
 * keeper-independiente, ver README/§6). Aun así lo queremos exacto.
 */

export const WAD = 10n ** 18n;

/** Estado de un LP en el momento de la marca (leído on-chain). */
export interface LpState {
  /** Capital neto invertido de por vida, WAD (int, puede ser negativo). `accountOf(lp).niWad`. */
  niWad: bigint;
  /** Shares del LP (18 dec). `share.balanceOf(lp)`. */
  shares: bigint;
  /** Media ponderada de timestamps de depósito (segundos). `accountOf(lp).vestTime`. */
  vestTime: bigint;
}

export interface SettlementMark {
  /** sharePrice a la marca (WAD). `_sharePrice(nav().navWad)` = (nav+VIRT_A)*WAD/(supply+VIRT_S). */
  peWad: bigint;
  /** Timestamp de la marca (segundos) — el `block.timestamp` del tx de settle. */
  markTime: bigint;
  /** Duración del período contable (segundos). `config.period`. Base del vesting de cobertura. */
  periodSeconds: bigint;
}

/**
 * Pérdida vesteada de UN LP (pre-λ), en WAD. Replica exactamente el cuerpo del loop de `_touch`.
 *   value      = shares * Pe / WAD
 *   si NI ≤ value → 0 (sin pérdida, o entró por encima del valor de marca)
 *   loss       = NI - value
 *   age        = max(0, markTime - vestTime)
 *   coverage   = age ≥ period ? WAD : age*WAD/period   (vesting lineal, v0.7)
 *   vestedLoss = loss * coverage / WAD
 */
export function lpVestedLoss(lp: LpState, mark: SettlementMark): bigint {
  const value = (lp.shares * mark.peWad) / WAD;
  if (lp.niWad <= value) return 0n;
  const loss = lp.niWad - value;
  const age = mark.markTime > lp.vestTime ? mark.markTime - lp.vestTime : 0n;
  const coverage = age >= mark.periodSeconds ? WAD : (age * WAD) / mark.periodSeconds;
  return (loss * coverage) / WAD;
}

/**
 * grossClaims = Σ_lp vestedLoss_lp (WAD). El FeeSplitter y las cuentas fuera de la contabilidad NI
 * no deben incluirse (el llamador filtra: solo cuentas de LP con `settledThrough` al día).
 */
export function computeGrossClaims(lps: LpState[], mark: SettlementMark): bigint {
  let total = 0n;
  for (const lp of lps) total += lpVestedLoss(lp, mark);
  return total;
}

/** sharePrice a la marca desde el NAV crudo y el supply — replica `_sharePrice`. */
const VIRT = 10n ** 6n; // VIRT_SHARES == VIRT_ASSETS
export function sharePriceWad(navWad: bigint, totalSupply: bigint): bigint {
  return ((navWad + VIRT) * WAD) / (totalSupply + VIRT);
}

/**
 * Chequeo de cordura previo a firmar el settlement: el `funding` que el contrato calculará
 * (keeper-independiente) y el λ resultante. Útil para logs/alertas del keeper — NO se envía on-chain.
 */
export function previewSettlement(params: {
  grossClaimsWad: bigint;
  niAggregateWad: bigint;
  supplyLpWad: bigint;
  peWad: bigint;
  stakeAvailableWad: bigint;
  frozen: boolean;
}): { fundingWad: bigint; lambdaWad: bigint } {
  const { grossClaimsWad, niAggregateWad, supplyLpWad, peWad, stakeAvailableWad, frozen } = params;
  let netted = 0n;
  if (niAggregateWad > 0n && !frozen) {
    const lpValue = (supplyLpWad * peWad) / WAD;
    if (niAggregateWad > lpValue) netted = niAggregateWad - lpValue;
  }
  const funding = netted < stakeAvailableWad ? netted : stakeAvailableWad;
  let lambda: bigint;
  if (grossClaimsWad === 0n) lambda = 0n;
  else {
    lambda = (funding * WAD) / grossClaimsWad;
    if (lambda > WAD) lambda = WAD;
  }
  return { fundingWad: funding, lambdaWad: lambda };
}
