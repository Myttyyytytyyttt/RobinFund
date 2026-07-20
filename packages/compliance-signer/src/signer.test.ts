import { describe, it, expect } from "vitest";
import {
  concatHex,
  encodeAbiParameters,
  hashTypedData,
  keccak256,
  recoverTypedDataAddress,
  toHex,
  type Address,
  type PublicClient,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { signAttestation, attestationTypedData, MAX_TTL_SECONDS } from "./signer.js";

const SIGNER_PK = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80" as const;
const signer = privateKeyToAccount(SIGNER_PK);
const GATE = "0x000000000000000000000000000000000000dEaD" as Address;
const USER = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8" as Address;
const CHAIN_ID = 4663;

/** Stub de PublicClient: nonce fijo + timestamp de bloque fijo. */
function stubClient(nonce: bigint, timestamp: bigint): PublicClient {
  return {
    readContract: async () => nonce,
    getBlock: async () => ({ timestamp }),
  } as unknown as PublicClient;
}

describe("signAttestation", () => {
  it("firma recuperable al signer, con nonce on-chain y expiry sobre block.timestamp", async () => {
    const att = await signAttestation(stubClient(5n, 1_000_000n), signer, GATE, CHAIN_ID, USER, 3600);
    expect(att.account).toBe(USER);
    expect(att.nonce).toBe("5");
    expect(att.expiry).toBe(1_000_000 + 3600);

    const recovered = await recoverTypedDataAddress({
      ...attestationTypedData(GATE, CHAIN_ID, USER, att.expiry, 5n),
      signature: att.signature,
    });
    expect(recovered.toLowerCase()).toBe(signer.address.toLowerCase());
  });

  it("rechaza TTL fuera de política (0, negativo, > 90d)", async () => {
    const c = stubClient(0n, 1_000_000n);
    await expect(signAttestation(c, signer, GATE, CHAIN_ID, USER, 0)).rejects.toThrow("TTL");
    await expect(signAttestation(c, signer, GATE, CHAIN_ID, USER, -5)).rejects.toThrow("TTL");
    await expect(signAttestation(c, signer, GATE, CHAIN_ID, USER, MAX_TTL_SECONDS + 1)).rejects.toThrow("TTL");
    await expect(signAttestation(c, signer, GATE, CHAIN_ID, USER, MAX_TTL_SECONDS)).resolves.toBeTruthy();
  });

  it("el digest del typed data replica EXACTAMENTE el esquema del contrato", () => {
    // EligibilityGate: digest = keccak(0x1901 ‖ domainSeparator ‖ structHash)
    const expiry = 1_003_600;
    const nonce = 7n;
    const typehash = keccak256(toHex("Attestation(address account,uint48 expiry,uint256 nonce)"));
    const domainSeparator = keccak256(
      encodeAbiParameters(
        [{ type: "bytes32" }, { type: "bytes32" }, { type: "bytes32" }, { type: "uint256" }, { type: "address" }],
        [
          keccak256(toHex("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)")),
          keccak256(toHex("RobinFund EligibilityGate")),
          keccak256(toHex("1")),
          BigInt(CHAIN_ID),
          GATE,
        ],
      ),
    );
    const structHash = keccak256(
      encodeAbiParameters(
        [{ type: "bytes32" }, { type: "address" }, { type: "uint48" }, { type: "uint256" }],
        [typehash, USER, expiry, nonce],
      ),
    );
    const manual = keccak256(concatHex(["0x1901", domainSeparator, structHash]));

    const viaViem = hashTypedData(attestationTypedData(GATE, CHAIN_ID, USER, expiry, nonce));
    expect(viaViem).toBe(manual);
  });
});
