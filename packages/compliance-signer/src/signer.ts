/**
 * Núcleo criptográfico: construye y firma la atestación EIP-712 EXACTAMENTE como la verifica
 * EligibilityGate.attest (typehash `Attestation(address account,uint48 expiry,uint256 nonce)`,
 * domain "RobinFund EligibilityGate" v1). El test de integración lo verifica contra el gate REAL.
 *
 * Reglas que importan:
 *  · El nonce se lee on-chain EN CADA FIRMA, jamás se cachea: `revoke()` lo avanza (G1) y una firma
 *    al nonce viejo debe quedar inválida — cachearlo re-abriría exactamente el bypass que G1 cerró.
 *  · El expiry se calcula sobre el timestamp del último bloque (el contrato compara contra
 *    block.timestamp), con TTL ≤ 90d (política §10.1 — el contrato no lo acota, el signer sí).
 */
import { type Address, type Hex, type PublicClient } from "viem";
import { type PrivateKeyAccount } from "viem/accounts";
import { gateAbi } from "./abi.js";

export const MAX_TTL_SECONDS = 90 * 24 * 3600; // §10.1
export const UINT48_MAX = 2 ** 48 - 1;

export interface SignedAttestation {
  account: Address;
  expiry: number; // uint48, segundos
  nonce: string; // uint256 como decimal string (JSON-safe)
  signature: Hex;
}

/** El typed data EIP-712, único punto de verdad del formato (lo usan firma y verificación). */
export function attestationTypedData(
  gate: Address,
  chainId: number,
  account: Address,
  expiry: number,
  nonce: bigint,
) {
  return {
    domain: {
      name: "RobinFund EligibilityGate",
      version: "1",
      chainId,
      verifyingContract: gate,
    },
    types: {
      Attestation: [
        { name: "account", type: "address" },
        { name: "expiry", type: "uint48" },
        { name: "nonce", type: "uint256" },
      ],
    },
    primaryType: "Attestation" as const,
    message: { account, expiry, nonce },
  } as const;
}

/**
 * Firma una atestación para `account` con TTL `ttlSeconds` (capado a 90d). Lee nonce y timestamp
 * frescos de la chain.
 */
export async function signAttestation(
  publicClient: PublicClient,
  signerAccount: PrivateKeyAccount,
  gate: Address,
  chainId: number,
  account: Address,
  ttlSeconds: number,
): Promise<SignedAttestation> {
  // forma POSITIVA a propósito: NaN falla ambas comparaciones de la forma negada y se colaría
  if (!(Number.isInteger(ttlSeconds) && ttlSeconds > 0 && ttlSeconds <= MAX_TTL_SECONDS)) {
    throw new Error(`TTL fuera de política: ${ttlSeconds}s (máx ${MAX_TTL_SECONDS}s = 90d)`);
  }
  const [nonce, block] = await Promise.all([
    publicClient.readContract({ address: gate, abi: gateAbi, functionName: "nonceOf", args: [account] }) as Promise<bigint>,
    publicClient.getBlock(),
  ]);
  const expiry = Number(block.timestamp) + ttlSeconds;
  if (expiry > UINT48_MAX) throw new Error("expiry desborda uint48");

  const signature = await signerAccount.signTypedData(
    attestationTypedData(gate, chainId, account, expiry, nonce),
  );
  return { account, expiry, nonce: nonce.toString(), signature };
}
