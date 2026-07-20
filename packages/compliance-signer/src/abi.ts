/**
 * ABI mínimo del EligibilityGate + ACCESS registry que el servicio consume.
 * Fuente de verdad: packages/contracts/src/EligibilityGate.sol. Si cambia la firma, actualizar aquí.
 */
export const gateAbi = [
  { type: "function", name: "signer", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  { type: "function", name: "isEligible", stateMutability: "view", inputs: [{ type: "address" }], outputs: [{ type: "bool" }] },
  { type: "function", name: "ineligibleSince", stateMutability: "view", inputs: [{ type: "address" }], outputs: [{ type: "uint48" }] },
  { type: "function", name: "expiryOf", stateMutability: "view", inputs: [{ type: "address" }], outputs: [{ type: "uint48" }] },
  { type: "function", name: "revokedAt", stateMutability: "view", inputs: [{ type: "address" }], outputs: [{ type: "uint48" }] },
  { type: "function", name: "nonceOf", stateMutability: "view", inputs: [{ type: "address" }], outputs: [{ type: "uint256" }] },
  {
    type: "function",
    name: "attest",
    stateMutability: "nonpayable",
    inputs: [
      { name: "account", type: "address" },
      { name: "expiry", type: "uint48" },
      { name: "nonce", type: "uint256" },
      { name: "signature", type: "bytes" },
    ],
    outputs: [],
  },
  { type: "function", name: "revoke", stateMutability: "nonpayable", inputs: [{ name: "account", type: "address" }], outputs: [] },
] as const;

/** ACCESS registry de RHJ — política: no atestar direcciones que RHJ tiene bloqueadas. */
export const accessRegistryAbi = [
  { type: "function", name: "isBlocked", stateMutability: "view", inputs: [{ type: "address" }], outputs: [{ type: "bool" }] },
] as const;
