import type { Tool } from "@tv-ai-agent/core";
import type { KeyValueStore } from "@tv-ai-agent/platform-api";
import { parseManifest, type SkillManifest } from "./schema.js";
import { createManifestTool, type ManifestToolOptions } from "./tool.js";

/**
 * Source (b) from ADR-0002: skills installed into `platform.storage`.
 *
 * Something — a user, an OEM provisioning step — has to deliberately write a
 * manifest here, and that act is the trust boundary. Nothing is fetched; the
 * runtime never reaches out for a skill on its own.
 */

const KEY = "skills:installed";
/** Enough for a set of skills, small enough not to abuse device storage. */
export const MAX_INSTALLED = 32;

export interface InstallResult {
  ok: boolean;
  errors: string[];
}

/** Manifests currently installed, newest last. Invalid entries are skipped. */
export async function listInstalledManifests(
  storage: KeyValueStore,
  key = KEY,
): Promise<SkillManifest[]> {
  const raw = await storage.get(key);
  if (!raw) return [];
  let entries: unknown;
  try {
    entries = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(entries)) return [];

  const manifests: SkillManifest[] = [];
  for (const entry of entries) {
    const checked = parseManifest(JSON.stringify(entry));
    if (checked.ok) manifests.push(checked.manifest);
  }
  return manifests;
}

/**
 * Install one manifest, replacing any with the same name.
 *
 * Validates before storing so a bad manifest is rejected here, with reasons,
 * rather than on a TV later — the caller can show the errors to whoever is
 * installing it.
 */
export async function installManifest(
  storage: KeyValueStore,
  input: string | unknown,
  key = KEY,
): Promise<InstallResult> {
  const checked = parseManifest(typeof input === "string" ? input : JSON.stringify(input));
  if (!checked.ok) return { ok: false, errors: checked.errors };

  const existing = await listInstalledManifests(storage, key);
  const next = existing.filter((m) => m.name !== checked.manifest.name);
  if (next.length >= MAX_INSTALLED) {
    return { ok: false, errors: [`too many installed skills (max ${MAX_INSTALLED})`] };
  }
  next.push(checked.manifest);
  await storage.set(key, JSON.stringify(next));
  return { ok: true, errors: [] };
}

/** Remove an installed skill by tool name. Returns whether it was there. */
export async function uninstallManifest(
  storage: KeyValueStore,
  name: string,
  key = KEY,
): Promise<boolean> {
  const existing = await listInstalledManifests(storage, key);
  const next = existing.filter((m) => m.name !== name);
  if (next.length === existing.length) return false;
  await storage.set(key, JSON.stringify(next));
  return true;
}

/**
 * Every installed skill as a `Tool`, ready for `new Agent({ tools })`.
 *
 * A manifest whose origin the host doesn't allow is dropped rather than thrown:
 * one bad skill must not stop the agent from starting. `onSkipped` reports them.
 */
export async function loadInstalledSkills(
  storage: KeyValueStore,
  opts: ManifestToolOptions & { key?: string; onSkipped?: (name: string, reason: string) => void },
): Promise<Tool[]> {
  const manifests = await listInstalledManifests(storage, opts.key);
  const tools: Tool[] = [];
  for (const manifest of manifests) {
    try {
      tools.push(createManifestTool(manifest, opts) as Tool);
    } catch (err) {
      opts.onSkipped?.(manifest.name, (err as Error).message);
    }
  }
  return tools;
}
