/**
 * Genera abis/generated.ts desde los artefactos de forge (packages/contracts/out).
 * Fuente de verdad única: si cambia un contrato, `forge build && pnpm gen-abis`.
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const out = resolve(here, "../../contracts/out");

const CONTRACTS = [
  ["FundAbi", "Fund.sol/Fund.json"],
  ["FundRegistryAbi", "FundRegistry.sol/FundRegistry.json"],
  ["EligibilityGateAbi", "EligibilityGate.sol/EligibilityGate.json"],
  ["FundShareAbi", "FundShare.sol/FundShare.json"],
];

let ts = `// GENERADO por scripts/gen-abis.mjs — NO editar a mano. Regenerar: forge build && pnpm gen-abis\n`;
for (const [name, path] of CONTRACTS) {
  const artifact = JSON.parse(readFileSync(resolve(out, path), "utf8"));
  ts += `\nexport const ${name} = ${JSON.stringify(artifact.abi, null, 2)} as const;\n`;
}

mkdirSync(resolve(here, "../abis"), { recursive: true });
writeFileSync(resolve(here, "../abis/generated.ts"), ts, "utf8");
console.log(`abis/generated.ts escrito (${CONTRACTS.length} contratos)`);
