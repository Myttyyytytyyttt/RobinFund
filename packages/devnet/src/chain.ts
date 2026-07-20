/**
 * Capa de chain del devnet: anvil forkeando mainnet, clientes viem, control de tiempo, feeds mock,
 * deal de ERC-20 y manipulación del ACCESS registry (para el simulacro de Frozen).
 */
import { spawn, type ChildProcess } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createPublicClient,
  createTestClient,
  createWalletClient,
  defineChain,
  encodeFunctionData,
  erc20Abi,
  http,
  numberToHex,
  type Address,
  type Chain,
  type Hex,
  type PublicClient,
  type TestClient,
  type WalletClient,
} from "viem";
import { privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";

export const here = dirname(fileURLToPath(import.meta.url));
export const rootDir = resolve(here, "../../..");
export const contractsDir = resolve(rootDir, "packages/contracts");

// direcciones reales (AddressBook.sol)
export const USDG = "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168" as Address;
export const TSLA = "0x322F0929c4625eD5bAd873c95208D54E1c003b2d" as Address;
export const ACCESS_REGISTRY = "0xe10b6f6B275de231345c20D14Ab812db62151b00" as Address;
export const TSLA_FEED = "0x4A1166a659A55625345e9515b32adECea5547C38" as Address;

// cuentas anvil (mnemonic de test estándar)
export const PK = [
  "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80", // 0 deployer/operador
  "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d", // 1 cuenta auxiliar
  "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a", // 2 keeper
  "0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6", // 3 manager
  "0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a", // 4 LP1
  "0x8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba", // 5 LP2
  "0x92db14e403b83dfe3df233f83dfa3a0d7096f21ca9b0d6d6b8d88b2b4ec1564e", // 6 LP3
  "0x4bbbf85ce3377467afe5d46f804f221813b2bb87f24d81f60f1fcdbf7cbf4356", // 7 treasury
  "0xdbda1821b80551c9d65939329250298aa3472ba22feea921c0cf5d620ea67b97", // 8 multisig
] as const;
export const acct: PrivateKeyAccount[] = PK.map((pk) => privateKeyToAccount(pk as Hex));
export const [DEPLOYER, AUXILIARY, KEEPER, MANAGER, LP1, LP2, LP3, TREASURY, MULTISIG] = [0, 1, 2, 3, 4, 5, 6, 7, 8];

export interface Devnet {
  anvil: ChildProcess;
  chain: Chain;
  chainId: number;
  rpcUrl: string;
  pub: PublicClient;
  test: TestClient;
  wallets: WalletClient[];
  heartbeat: ReturnType<typeof setInterval>;
}

export function loadRootEnv(): void {
  const p = resolve(rootDir, ".env");
  if (!existsSync(p)) return;
  for (const raw of readFileSync(p, "utf8").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const k = line.slice(0, eq).trim();
    let v = line.slice(eq + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    if (process.env[k] === undefined) process.env[k] = v;
  }
}

export async function bootAnvil(port: number): Promise<Devnet> {
  loadRootEnv();
  const forkUrl = process.env.RH_RPC_MAINNET;
  if (!forkUrl) throw new Error("falta RH_RPC_MAINNET en el .env raíz");
  const rpcUrl = `http://127.0.0.1:${port}`;

  const anvil = spawn("anvil", ["--fork-url", forkUrl, "--port", String(port)], { stdio: "ignore" });
  const probe = createPublicClient({ transport: http(rpcUrl) });
  let chainId = 0;
  for (let i = 0; i < 120; i++) {
    try {
      chainId = await probe.getChainId();
      break;
    } catch {
      await new Promise((r) => setTimeout(r, 500));
    }
  }
  if (!chainId) {
    anvil.kill();
    throw new Error("anvil no arrancó");
  }

  const chain = defineChain({
    id: chainId,
    name: "robinfund-devnet",
    nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
    rpcUrls: { default: { http: [rpcUrl] } },
  });
  const pub = createPublicClient({ chain, transport: http(rpcUrl) });
  const test = createTestClient({ mode: "anvil", chain, transport: http(rpcUrl) });
  const wallets = acct.map((a) => createWalletClient({ account: a, chain, transport: http(rpcUrl) }));

  // latido: un bloque cada 2s para que keeper (timestamps frescos) y ponder (realtime) avancen
  const heartbeat = setInterval(() => {
    test.mine({ blocks: 1 }).catch(() => undefined);
  }, 2000);

  return { anvil, chain, chainId, rpcUrl, pub, test, wallets, heartbeat };
}

export async function now(d: Devnet): Promise<bigint> {
  return (await d.pub.getBlock()).timestamp;
}

/** Avanza el reloj de la chain hasta `target` (siempre hacia delante). */
export async function warpTo(d: Devnet, target: bigint): Promise<void> {
  const t = await now(d);
  if (target <= t) return;
  await d.test.setNextBlockTimestamp({ timestamp: target });
  await d.test.mine({ blocks: 1 });
}

export async function write(
  d: Devnet,
  who: number,
  address: Address,
  abi: unknown,
  functionName: string,
  args: unknown[],
): Promise<Hex> {
  const w = d.wallets[who]!;
  const hash = await w.writeContract({ address, abi, functionName, args, account: w.account!, chain: d.chain } as never);
  const receipt = await d.pub.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") throw new Error(`${functionName} revirtió (${hash})`);
  return hash;
}

/**
 * Escribe el slot de storage que respalda una lectura view (balanceOf, isBlocked…): descubre los
 * slots con eth_createAccessList, prueba cada uno y RESTAURA los que no eran (los proxies incluyen
 * su slot de implementación en la lista — pisarlo sin restaurar brickea el contrato).
 */
export async function forceViewResult(
  d: Devnet,
  target: Address,
  calldata: Hex,
  desiredRaw: Hex,
  check: () => Promise<boolean>,
): Promise<void> {
  const res = (await d.pub.request({
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    method: "eth_createAccessList" as any,
    params: [{ to: target, data: calldata }, "latest"] as never,
  })) as { accessList: { address: Address; storageKeys: Hex[] }[] };
  const keys = res.accessList
    .filter((e) => e.address.toLowerCase() === target.toLowerCase())
    .flatMap((e) => e.storageKeys);
  for (const key of keys) {
    const prev = await d.pub.getStorageAt({ address: target, slot: key });
    await d.test.setStorageAt({ address: target, index: key, value: desiredRaw });
    let ok = false;
    try {
      ok = await check();
    } catch {
      ok = false;
    }
    if (ok) return;
    await d.test.setStorageAt({ address: target, index: key, value: (prev ?? numberToHex(0, { size: 32 })) as Hex });
  }
  throw new Error(`no encontré el slot que respalda la lectura en ${target}`);
}

export async function dealErc20(d: Devnet, token: Address, to: Address, amount: bigint): Promise<void> {
  const data = encodeFunctionData({ abi: erc20Abi, functionName: "balanceOf", args: [to] });
  await forceViewResult(d, token, data, numberToHex(amount, { size: 32 }), async () => {
    const bal = await d.pub.readContract({ address: token, abi: erc20Abi, functionName: "balanceOf", args: [to] });
    return bal === amount;
  });
}

/** Bloquea/desbloquea una dirección en el ACCESS registry REAL de RHJ (solo posible en un fork). */
export async function setRhjBlocked(d: Devnet, account: Address, blocked: boolean): Promise<void> {
  const isBlockedAbi = [
    { type: "function", name: "isBlocked", stateMutability: "view", inputs: [{ type: "address" }], outputs: [{ type: "bool" }] },
  ] as const;
  const data = encodeFunctionData({ abi: isBlockedAbi, functionName: "isBlocked", args: [account] });
  await forceViewResult(d, ACCESS_REGISTRY, data, numberToHex(blocked ? 1 : 0, { size: 32 }), async () => {
    const v = await d.pub.readContract({
      address: ACCESS_REGISTRY,
      abi: isBlockedAbi,
      functionName: "isBlocked",
      args: [account],
    });
    return v === blocked;
  });
}
