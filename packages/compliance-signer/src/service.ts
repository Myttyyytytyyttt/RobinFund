/**
 * Orquestación del servicio: admisión → firma, renovación, revocación on-chain, estado.
 * Sin HTTP aquí — http.ts expone esto; los tests lo ejercitan directo.
 */
import {
  type Address,
  type Chain,
  type PublicClient,
  type WalletClient,
  getAddress,
} from "viem";
import { type PrivateKeyAccount } from "viem/accounts";
import { gateAbi, accessRegistryAbi } from "./abi.js";
import { signAttestation, type SignedAttestation } from "./signer.js";
import {
  decideAdmission,
  decideRenewal,
  type AdmissionRequest,
  type PolicyDecision,
} from "./policy.js";
import { ComplianceStore } from "./store.js";

export interface ServiceConfig {
  gate: Address;
  /** null desactiva el chequeo RHJ (p.ej. anvil sin fork, donde no existe el registry) */
  accessRegistry: Address | null;
  chainId: number;
  ttlSeconds: number;
  /** ventana de renovación: solo renovable si el expiry on-chain está a menos de esto */
  renewalWindowSeconds: number;
  blockedJurisdictions: readonly string[];
  /** true → la ADMISIÓN también envía la tx attest(). Nunca aplica a renovaciones: /renewals es
   * público y auto-enviar ahí deja que cualquiera queme el gas de la clave del signer. */
  autoSubmit: boolean;
}

export class ComplianceService {
  constructor(
    private readonly publicClient: PublicClient,
    private readonly walletClient: WalletClient,
    private readonly signerAccount: PrivateKeyAccount,
    private readonly chain: Chain,
    private readonly store: ComplianceStore,
    private readonly cfg: ServiceConfig,
  ) {}

  /** Chequeo de arranque: nuestra clave DEBE ser el signer on-chain (si no, nada de lo firmado vale). */
  async assertSignerMatches(): Promise<void> {
    const onchain = (await this.publicClient.readContract({
      address: this.cfg.gate,
      abi: gateAbi,
      functionName: "signer",
    })) as Address;
    if (onchain.toLowerCase() !== this.signerAccount.address.toLowerCase()) {
      throw new Error(
        `la clave local (${this.signerAccount.address}) NO es el signer del gate (${onchain}): firmar sería inútil y revoke revertiría`,
      );
    }
  }

  private async rhjBlocked(address: Address): Promise<boolean> {
    // comparación ESTRICTA: solo el null explícito desactiva el chequeo (un "" de un env
    // malconfigurado no debe apagar un control de compliance en silencio)
    if (this.cfg.accessRegistry === null) return false;
    return (await this.publicClient.readContract({
      address: this.cfg.accessRegistry,
      abi: accessRegistryAbi,
      functionName: "isBlocked",
      args: [address],
    })) as boolean;
  }

  private async revokedAtOnChain(address: Address): Promise<number> {
    const v = (await this.publicClient.readContract({
      address: this.cfg.gate,
      abi: gateAbi,
      functionName: "revokedAt",
      args: [address],
    })) as bigint | number;
    return Number(v);
  }

  private async nowIso(): Promise<string> {
    const block = await this.publicClient.getBlock();
    return new Date(Number(block.timestamp) * 1000).toISOString();
  }

  /**
   * Admisión: política → binding en el store → firma (→ submit opcional).
   * La declaración KYC (usPerson/jurisdiction/personId) viene VERIFICADA de la capa de arriba.
   */
  async admit(req: AdmissionRequest): Promise<
    | { ok: true; attestation: SignedAttestation; submitted: boolean }
    | { ok: false; reason: string }
  > {
    const address = getAddress(req.address);
    const decision: PolicyDecision = decideAdmission(
      { ...req, address },
      {
        blockedJurisdictions: this.cfg.blockedJurisdictions,
        rhjBlocked: await this.rhjBlocked(address),
        existingAddressOfPerson: this.store.activeAddressOf(req.personId),
        existingPersonOfAddress: this.store.personOf(address),
      },
    );
    if (!decision.ok) return decision;

    // ORDEN deliberado: binding ANTES de firmar — si esto falla a medias, el fallo es cerrado
    // (binding sin firma: la unicidad §10.1 queda protegida y un reintento idempotente completa).
    // El orden inverso (firma sin binding) permitiría admitir después OTRA dirección a la misma
    // persona → dos direcciones elegibles a la vez.
    try {
      this.store.admit(req.personId, address, await this.nowIso());
    } catch (e) {
      // carrera entre el chequeo de política y la escritura: mismo rechazo que daría la política
      return { ok: false, reason: e instanceof Error ? e.message : "conflicto de unicidad en el store" };
    }
    let attestation: SignedAttestation;
    try {
      attestation = await this.sign(address);
    } catch (e) {
      // el binding YA persistió: decirlo explícitamente para que el upstream reintente idempotente
      // con la MISMA pareja persona/dirección en vez de tratar esto como no-ocurrido
      const msg = e instanceof Error ? e.message : String(e);
      return {
        ok: false,
        reason: `binding registrado pero la firma falló (${msg}): reintentar la admisión con la MISMA pareja personId/address para completarla`,
      };
    }
    const submitted = this.cfg.autoSubmit ? await this.submit(attestation) : false;
    return { ok: true, attestation, submitted };
  }

  /**
   * Renovación para una dirección ya admitida (extiende expiry). Es PÚBLICA, así que no confía
   * solo en el estado local: lee revokedAt on-chain (antes Y después de firmar — el re-check
   * post-firma cierra la carrera con una revocación en vuelo: si el nonce leído al firmar fue el
   * post-revocación, la revocación ya era visible y el re-check la ve) y acota con la ventana de
   * renovación (sin ella, renovar en bucle = elegibilidad perpetua sin re-verificación).
   */
  async renew(
    addressRaw: Address,
  ): Promise<
    | { ok: true; attestation: SignedAttestation; submitted: boolean }
    | { ok: false; reason: string }
  > {
    const address = getAddress(addressRaw);
    const personId = this.store.personOf(address);
    const rec = personId ? this.store.recordOf(personId) : null;

    const [revokedOnChain, rhjBlocked, expiryOnChain, block] = await Promise.all([
      this.revokedAtOnChain(address),
      this.rhjBlocked(address),
      this.publicClient.readContract({ address: this.cfg.gate, abi: gateAbi, functionName: "expiryOf", args: [address] }) as Promise<bigint | number>,
      this.publicClient.getBlock(),
    ]);
    const secondsToExpiry = Number(expiryOnChain) - Number(block.timestamp);

    const decision = decideRenewal({
      addressAdmitted: this.store.isAdmitted(address),
      personLocallyRevoked: !!rec?.revoked,
      rhjBlocked,
      revokedOnChain: revokedOnChain !== 0,
      withinRenewalWindow: secondsToExpiry < this.cfg.renewalWindowSeconds,
    });
    if (!decision.ok) return decision;

    const attestation = await this.sign(address);

    // re-check post-firma: si una revocación se minó entre las lecturas y la firma, descartar
    if ((await this.revokedAtOnChain(address)) !== 0) {
      return { ok: false, reason: "revocada durante la renovación: firma descartada" };
    }
    return { ok: true, attestation, submitted: false };
  }

  /**
   * Revocación: marca local WRITE-AHEAD → tx on-chain (avanza el nonce, G1). El orden importa:
   * si el proceso muere entre ambos pasos, el estado que queda CIERRA la renovación pública
   * (marcado local sin tx: el admin reintenta la revocación; el orden inverso dejaba una ventana
   * en la que una renovación firmaba el nonce post-revocación y deshacía la revocación).
   */
  async revoke(addressRaw: Address): Promise<{ ok: true; txHash: string } | { ok: false; reason: string }> {
    const address = getAddress(addressRaw);
    this.store.revokeByAddress(address, await this.nowIso()); // write-ahead (null si desconocida: la tx va igual — revocar una dirección nunca atestada también mata firmas pre-emitidas)
    const hash = await this.walletClient.writeContract({
      address: this.cfg.gate,
      abi: gateAbi,
      functionName: "revoke",
      args: [address],
      account: this.signerAccount,
      chain: this.chain,
    });
    const receipt = await this.publicClient.waitForTransactionReceipt({ hash });
    if (receipt.status !== "success") {
      // la marca local se queda puesta A PROPÓSITO (fail-closed): renovaciones cerradas hasta que
      // el admin reintente la revocación o re-admita deliberadamente
      return { ok: false, reason: `revoke revirtió (${hash}); marca local puesta — reintentar la revocación` };
    }
    return { ok: true, txHash: hash };
  }

  /** Estado combinado on-chain + local de una dirección (sin PII: el personId no sale de aquí). */
  async status(addressRaw: Address): Promise<{
    address: Address;
    eligible: boolean;
    expiry: number;
    revokedAt: number;
    nonce: string;
    admittedLocally: boolean;
  }> {
    const address = getAddress(addressRaw);
    const [eligible, expiry, revokedAt, nonce] = await Promise.all([
      this.publicClient.readContract({ address: this.cfg.gate, abi: gateAbi, functionName: "isEligible", args: [address] }) as Promise<boolean>,
      this.publicClient.readContract({ address: this.cfg.gate, abi: gateAbi, functionName: "expiryOf", args: [address] }) as Promise<bigint | number>,
      this.publicClient.readContract({ address: this.cfg.gate, abi: gateAbi, functionName: "revokedAt", args: [address] }) as Promise<bigint | number>,
      this.publicClient.readContract({ address: this.cfg.gate, abi: gateAbi, functionName: "nonceOf", args: [address] }) as Promise<bigint>,
    ]);
    return {
      address,
      eligible,
      expiry: Number(expiry),
      revokedAt: Number(revokedAt),
      nonce: nonce.toString(),
      admittedLocally: this.store.isAdmitted(address),
    };
  }

  private sign(address: Address): Promise<SignedAttestation> {
    return signAttestation(
      this.publicClient,
      this.signerAccount,
      this.cfg.gate,
      this.cfg.chainId,
      address,
      this.cfg.ttlSeconds,
    );
  }

  /** Envía attest() on-chain (permissionless — cualquiera podría; aquí por conveniencia). */
  private async submit(a: SignedAttestation): Promise<boolean> {
    const hash = await this.walletClient.writeContract({
      address: this.cfg.gate,
      abi: gateAbi,
      functionName: "attest",
      args: [a.account, a.expiry, BigInt(a.nonce), a.signature],
      account: this.signerAccount,
      chain: this.chain,
    });
    const receipt = await this.publicClient.waitForTransactionReceipt({ hash });
    return receipt.status === "success";
  }
}
