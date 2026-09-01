#!/usr/bin/env node
/**
 * Generate a CycloneDX 1.5 SBOM (Software Bill of Materials) from the installed
 * dependency tree. Written to sbom.json; attach it to releases.
 *
 *   pnpm install && node tools/sbom.mjs
 */
import { writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { collectDependencies, root } from "./lib-deps.mjs";

const rootPkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const deps = collectDependencies();

const bom = {
  bomFormat: "CycloneDX",
  specVersion: "1.5",
  version: 1,
  metadata: {
    timestamp: new Date().toISOString(),
    tools: [{ vendor: "hearth", name: "tools/sbom.mjs", version: "0.2.0" }],
    component: {
      type: "application",
      name: rootPkg.name,
      version: rootPkg.version,
      licenses: [{ license: { id: "Apache-2.0" } }],
    },
  },
  components: deps.map((d) => ({
    type: "library",
    name: d.name,
    version: d.version,
    purl: `pkg:npm/${encodeURIComponent(d.name)}@${d.version}`,
    licenses: [licenseEntry(d.license)],
  })),
};

function licenseEntry(license) {
  return license === "UNKNOWN" ? { license: { name: "UNKNOWN" } } : { license: { id: license } };
}

const out = join(root, "sbom.json");
writeFileSync(out, JSON.stringify(bom, null, 2) + "\n");
console.log(`Wrote ${bom.components.length} components to sbom.json`);
