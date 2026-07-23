import { getAddress, type Address } from "viem";

export class SponsorAuthError extends Error {
  constructor(readonly code: string, message: string, readonly status = 401) {
    super(message);
  }
}

interface SponsorAuthOptions {
  supabaseUrl: string;
  publishableKey: string;
}

type UserIdentity = {
  provider?: string;
  provider_id?: string;
  id?: string;
  identity_data?: Record<string, unknown>;
};

function identityAddress(identity: UserIdentity): Address | null {
  if (identity.provider !== "web3") return null;
  const fromProvider = identity.provider_id?.match(/^web3:ethereum:(0x[0-9a-fA-F]{40})$/)?.[1]
    ?? identity.id?.match(/^web3:ethereum:(0x[0-9a-fA-F]{40})$/)?.[1];
  const custom = identity.identity_data?.custom_claims;
  const fromClaims = custom && typeof custom === "object"
    ? (custom as Record<string, unknown>).address
    : undefined;
  const candidate = fromProvider ?? identity.identity_data?.address ?? fromClaims;
  if (typeof candidate !== "string") return null;
  try {
    return getAddress(candidate).toLowerCase() as Address;
  } catch {
    return null;
  }
}

export class SupabaseSponsorAuth {
  constructor(
    private readonly options: SponsorAuthOptions,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async authenticate(authorization: string | undefined): Promise<Address> {
    if (!authorization?.startsWith("Bearer ")) {
      throw new SponsorAuthError("SPONSOR_SESSION_REQUIRED", "Supabase SIWE session required");
    }
    const response = await this.fetchImpl(new URL("/auth/v1/user", this.options.supabaseUrl), {
      headers: {
        authorization,
        apikey: this.options.publishableKey,
      },
      signal: AbortSignal.timeout(8_000),
    });
    if (!response.ok) throw new SponsorAuthError("SPONSOR_SESSION_INVALID", "Supabase SIWE session is invalid");
    const user = await response.json() as { identities?: UserIdentity[] };
    const addresses = (user.identities ?? []).map(identityAddress).filter((value): value is Address => value != null);
    if (addresses.length !== 1) {
      throw new SponsorAuthError("SPONSOR_WEB3_IDENTITY_MISSING", "Session has no unique verified Web3 identity", 403);
    }
    return addresses[0]!;
  }
}
