import { getAddress, type Address, type Hex } from "viem";
import { z } from "zod";

export const MIN_INITIAL_STAKE_6 = 2_000_000_000n;
export const MAX_INITIAL_STAKE_6 = 10_000_000_000_000n;

export const vaultAddressSchema = z.string().transform((value, context) => {
  try {
    return getAddress(value).toLowerCase() as Address;
  } catch {
    context.addIssue({ code: "custom", message: "invalid EVM address" });
    return z.NEVER;
  }
});

export const vaultAgentIdSchema = z.string()
  .regex(/^0x[0-9a-fA-F]{64}$/)
  .transform((value) => value.toLowerCase() as Hex);

export const vaultPolicySchema = z.object({
  maxTradeBps: z.number().int().min(100).max(2_000).default(1_000),
  maxConcentrationBps: z.number().int().min(1_000).max(5_000).default(3_500),
  dailyTurnoverBps: z.number().int().min(500).max(10_000).default(5_000),
  maxSlippageBps: z.number().int().min(10).max(100).default(75),
  maxTradesPerDay: z.number().int().min(1).max(200).default(24),
  minTradeInterval: z.number().int().min(60).max(3_600).default(300),
  maxIntentLifetime: z.number().int().min(1).max(300).default(300),
  allowedAssets: z.array(vaultAddressSchema).min(1).max(32),
});

function stake6(value: string): bigint {
  const [whole = "0", fraction = ""] = value.split(".");
  return BigInt(whole) * 1_000_000n + BigInt(fraction.padEnd(6, "0"));
}

export const vaultEconomySchema = z.object({
  name: z.string().trim().min(3).max(48),
  symbol: z.string().trim().regex(/^[A-Z0-9]{2,8}$/),
  initialStake: z.string()
    .regex(/^\d+(?:\.\d{1,6})?$/)
    .refine((value) => {
      const amount = stake6(value);
      return amount >= MIN_INITIAL_STAKE_6 && amount <= MAX_INITIAL_STAKE_6;
    }, "initial stake must be between 2,000 and 10,000,000 USDG"),
  perfFeeBps: z.number().int().min(0).max(3_000),
  feeMinBps: z.number().int().min(0).max(500),
  feeMaxBps: z.number().int().min(0).max(500),
  managerEntryShareBps: z.number().int().min(0).max(5_000),
  kFactor: z.number().int().min(1).max(25),
  periodDays: z.number().int().min(7).max(90),
  cooldownHours: z.number().int().min(1).max(168),
}).refine((value) => value.feeMinBps <= value.feeMaxBps, {
  message: "entry fee range is inverted",
  path: ["feeMaxBps"],
});

export const vaultDeploymentRequestSchema = z.object({
  agentId: vaultAgentIdSchema,
  signer: vaultAddressSchema,
  policy: vaultPolicySchema,
  economy: vaultEconomySchema,
});

export type VaultDeploymentRequest = z.infer<typeof vaultDeploymentRequestSchema>;

export function parseInitialStake6(value: string): bigint {
  return stake6(value);
}
