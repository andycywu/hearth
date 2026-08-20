import type { Tool } from "@hearthkit/core";
import { parseManifest, type SkillManifest } from "./schema.js";
import { createManifestTool, type ManifestToolOptions } from "./tool.js";

/**
 * Source (a) from ADR-0002: manifests shipped inside the app bundle.
 *
 * These went through review before the app was built, so they carry the same
 * trust as the code around them — but they get the same validation anyway, so
 * a typo fails loudly at boot rather than confusing the model at run time.
 */
export async function loadBundledSkills(
  manifests: Array<SkillManifest | string | unknown>,
  opts: ManifestToolOptions & { onSkipped?: (name: string, reason: string) => void },
): Promise<Tool[]> {
  const tools: Tool[] = [];
  const seen = new Set<string>();

  for (const [index, input] of manifests.entries()) {
    const checked = parseManifest(typeof input === "string" ? input : JSON.stringify(input));
    if (!checked.ok) {
      opts.onSkipped?.(`bundled skill #${index}`, checked.errors.join("; "));
      continue;
    }
    const { name } = checked.manifest;
    // Two tools of one name would make the model's choice ambiguous.
    if (seen.has(name)) {
      opts.onSkipped?.(name, "a bundled skill of this name is already loaded");
      continue;
    }
    try {
      tools.push(createManifestTool(checked.manifest, opts) as Tool);
      seen.add(name);
    } catch (err) {
      opts.onSkipped?.(name, (err as Error).message);
    }
  }
  return tools;
}
