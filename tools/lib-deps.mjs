// Shared helper: walk node_modules and yield installed package manifests.
// Used by license-check.mjs and sbom.mjs. Zero dependencies.
import { readdirSync, readFileSync, existsSync, statSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

export const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function readManifest(dir) {
  const p = join(dir, "package.json");
  if (!existsSync(p)) return null;
  try {
    const j = JSON.parse(readFileSync(p, "utf8"));
    if (!j.name || !j.version) return null;
    return { name: j.name, version: j.version, license: normalizeLicense(j), dir };
  } catch {
    return null;
  }
}

function normalizeLicense(pkg) {
  if (typeof pkg.license === "string") return pkg.license;
  if (pkg.license && typeof pkg.license === "object" && pkg.license.type) return pkg.license.type;
  if (Array.isArray(pkg.licenses)) return pkg.licenses.map((l) => l.type ?? l).join(" OR ");
  return "UNKNOWN";
}

/** Yields { name, version, license } for every installed dependency (deduped). */
export function collectDependencies() {
  const nm = join(root, "node_modules");
  const seen = new Map();
  if (!existsSync(nm)) return [];
  for (const entry of readdirSync(nm)) {
    if (entry.startsWith(".")) continue;
    const full = join(nm, entry);
    if (entry.startsWith("@")) {
      // scoped: node_modules/@scope/pkg
      for (const sub of readdirSync(full)) {
        const m = readManifest(join(full, sub));
        if (m && isWorkspaceExternal(m.name)) seen.set(`${m.name}@${m.version}`, m);
      }
    } else if (statSync(full).isDirectory()) {
      const m = readManifest(full);
      if (m && isWorkspaceExternal(m.name)) seen.set(`${m.name}@${m.version}`, m);
    }
  }
  return [...seen.values()].sort((a, b) => a.name.localeCompare(b.name));
}

// Skip our own workspace packages — they are Apache-2.0 by definition.
function isWorkspaceExternal(name) {
  return !name.startsWith("@tv-ai-agent/");
}
