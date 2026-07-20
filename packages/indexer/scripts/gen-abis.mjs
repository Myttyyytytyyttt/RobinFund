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

// Librerías enlazadas que emiten eventos vía delegatecall DESDE el Fund (p.ej. InKindSlice en
// NAVLib.distributeInKind): el log sale con la dirección del Fund, así que sus eventos deben
// fundirse en FundAbi para que Ponder los decodifique como eventos del Fund.
const FUND_LINKED_LIBS = ["NAVLib.sol/NAVLib.json"];

let ts = `// GENERADO por scripts/gen-abis.mjs — NO editar a mano. Regenerar: forge build && pnpm gen-abis\n`;
for (const [name, path] of CONTRACTS) {
  const artifact = JSON.parse(readFileSync(resolve(out, path), "utf8"));
  let abi = artifact.abi;
  if (name === "FundAbi") {
    for (const libPath of FUND_LINKED_LIBS) {
      const lib = JSON.parse(readFileSync(resolve(out, libPath), "utf8"));
      abi = abi.concat(lib.abi.filter((item) => item.type === "event"));
    }
  }
  ts += `\nexport const ${name} = ${JSON.stringify(abi, null, 2)} as const;\n`;
}

mkdirSync(resolve(here, "../abis"), { recursive: true });
writeFileSync(resolve(here, "../abis/generated.ts"), ts, "utf8");
console.log(`abis/generated.ts escrito (${CONTRACTS.length} contratos)`);
