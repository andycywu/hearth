#!/usr/bin/env node
/**
 * Bundle-size budget guard.
 *
 * Fails (exit 1) if any target bundle exceeds its budget. Runs in CI after the
 * bundles are built so a heavy dependency can't silently bloat the on-device
 * runtime — critical on low-end MTK/NVT SoCs where download/parse time matters.
 *
 *   pnpm build && node tools/bundle.mjs tizen && node tools/bundle.mjs aosp \
 *     && node tools/check-bundle-size.mjs
 */
import { readFileSync, existsSync } from "node:fs";
import { gzipSync } from "node:zlib";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// Raw-byte budgets per target. Generous headroom over the current ~7KB runtime;
// tighten as the UI shell lands.
const BUDGETS = [
  { name: "tizen", file: "apps/tizen-app/main.js", maxBytes: 250_000 },
  { name: "aosp", file: "apps/aosp-app/app/src/main/assets/main.js", maxBytes: 250_000 },
];

let failed = false;
for (const b of BUDGETS) {
  const path = resolve(root, b.file);
  if (!existsSync(path)) {
    console.error(`✗ ${b.name}: bundle not found at ${b.file} — run tools/bundle.mjs first`);
    failed = true;
    continue;
  }
  const buf = readFileSync(path);
  const raw = buf.byteLength;
  const gz = gzipSync(buf).byteLength;
  const ok = raw <= b.maxBytes;
  const pct = ((raw / b.maxBytes) * 100).toFixed(0);
  console.log(
    `${ok ? "✓" : "✗"} ${b.name}: ${fmt(raw)} raw (${fmt(gz)} gzip) — ${pct}% of ${fmt(b.maxBytes)} budget`,
  );
  if (!ok) failed = true;
}

if (failed) {
  console.error("\nBundle-size budget exceeded.");
  process.exit(1);
}
console.log("\nAll bundles within budget.");

function fmt(n) {
  return n >= 1024 ? `${(n / 1024).toFixed(1)}KB` : `${n}B`;
}
