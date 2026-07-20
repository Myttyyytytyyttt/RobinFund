/**
 * Carga del .env RAÍZ del monorepo en process.env (sin pisar lo definido). Ponder solo carga
 * .env.local del propio paquete; nuestras keys viven en el .env raíz (pedido del usuario).
 */
import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

export function loadRootEnv(): void {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidate = resolve(here, "../../.env");
  if (!existsSync(candidate)) return;
  for (const raw of readFileSync(candidate, "utf8").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = val;
  }
}
