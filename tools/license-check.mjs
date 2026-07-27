#!/usr/bin/env node
/**
 * Dependency license gate. Fails (exit 1) if any installed dependency uses a
 * strong-copyleft / network-copyleft license incompatible with shipping this
 * Apache-2.0 project. Warns on unknown licenses for manual review.
 *
 *   pnpm install && node tools/license-check.mjs
 */
import { collectDependencies } from "./lib-deps.mjs";

function isDenied(license) {
  const s = license.toUpperCase();
  if (s.includes("AGPL") || s.includes("SSPL")) return true;
  // GPL (but not LGPL, which is fine for linking).
  if (s.includes("GPL") && !s.includes("LGPL")) return true;
  if (s.includes("CC-BY-NC") || s.includes("NONCOMMERCIAL")) return true;
  return false;
}

const deps = collectDependencies();
const denied = [];
const unknown = [];
for (const d of deps) {
  if (isDenied(d.license)) denied.push(d);
  else if (d.license === "UNKNOWN") unknown.push(d);
}

console.log(`Scanned ${deps.length} dependencies.`);
if (unknown.length) {
  console.warn(`\n⚠ ${unknown.length} with unknown license (review manually):`);
  for (const d of unknown) console.warn(`   ${d.name}@${d.version}`);
}
if (denied.length) {
  console.error(`\n✗ ${denied.length} disallowed license(s):`);
  for (const d of denied) console.error(`   ${d.name}@${d.version} — ${d.license}`);
  process.exit(1);
}
console.log("\n✓ No disallowed licenses found.");
