/**
 * Monitores del keeper (SPEC §10.3, §8, C29). Vigilan condiciones que requieren reacción:
 *  · el fondo fue bloqueado por RHJ → declarar Frozen
 *  · un token de la cartera sufrió drift de beacon → suspender en el TokenRegistry (permissionless)
 * Aquí la LÓGICA DE DECISIÓN pura; el runner del keeper la ejecuta y dispara las tx.
 */
import { type Address, type PublicClient } from "viem";
import { accessRegistryAbi } from "./abi.js";

export type Alert =
  | { kind: "fund-blocked"; fund: Address }
  | { kind: "beacon-drift"; token: Address; oldImpl: Address; newImpl: Address };

/** ¿RHJ bloqueó este fondo? → hay que declararlo Frozen (§10.3). */
export async function checkFundBlocked(
  client: PublicClient,
  accessRegistry: Address,
  fund: Address,
): Promise<Alert | null> {
  const blocked = await client.readContract({
    address: accessRegistry,
    abi: accessRegistryAbi,
    functionName: "isBlocked",
    args: [fund],
  });
  return blocked ? { kind: "fund-blocked", fund } : null;
}

const BEACON_SLOT = "0xa3f0ad74e5423aebfd80d3ef4346578335a9a72aeaee59ff6cb3582b35133d50" as const;

/**
 * ¿La implementación del beacon de un Stock Token cambió respecto a la conocida? → suspender el
 * activo (C29). Lee el slot ERC-1967 del beacon (verificado en Fase 0: el access registry ES el beacon).
 */
export async function checkBeaconDrift(
  client: PublicClient,
  token: Address,
  beacon: Address,
  knownImpl: Address,
): Promise<Alert | null> {
  // el beacon expone implementation(); lo leemos vía el slot para robustez
  const raw = await client.getStorageAt({ address: beacon, slot: BEACON_SLOT });
  if (!raw) return null;
  const current = ("0x" + raw.slice(-40)) as Address;
  if (current.toLowerCase() !== knownImpl.toLowerCase()) {
    return { kind: "beacon-drift", token, oldImpl: knownImpl, newImpl: current };
  }
  return null;
}
