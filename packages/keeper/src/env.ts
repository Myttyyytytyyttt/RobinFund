/**
 * Carga del .env RAÍZ del monorepo (donde viven todas las keys — pedido del usuario: todo lo
 * sensible SIEMPRE en el .env raíz, gitignored). Sin dependencia de dotenv: parser mínimo.
 */
import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

/** Parsea un archivo .env (KEY=valor, comentarios con #, comillas opcionales). */
export function parseDotenv(content: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of content.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    out[key] = val;
  }
  return out;
}

/** Carga el .env raíz (dos niveles arriba de packages/keeper) en process.env, sin pisar lo ya definido. */
export function loadRootEnv(): void {
  const here = dirname(fileURLToPath(import.meta.url));
  // desde src/ o desde dist/ el raíz queda tres niveles arriba (keeper/{src|dist}/env.*)
  for (const candidate of [resolve(here, "../../../.env"), resolve(here, "../../.env")]) {
    if (!existsSync(candidate)) continue;
    const vars = parseDotenv(readFileSync(candidate, "utf8"));
    for (const [k, v] of Object.entries(vars)) {
      if (process.env[k] === undefined) process.env[k] = v;
    }
    return;
  }
}
