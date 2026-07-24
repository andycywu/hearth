#!/usr/bin/env node
/**
 * Local diagnostics runner (web/mock adapter). Prints a capability report.
 *
 *   pnpm build && node tools/diagnostics.mjs [--writes]
 *
 * On a real device the same runDiagnostics() runs inside the app — open the app
 * with `?diag` (see the app entry files under apps/) to get an on-screen report
 * from the actual Tizen / AOSP adapter on MTK/NVT hardware.
 */
import { runDiagnostics, reportToMarkdown } from "../packages/core/dist/index.js";
import { createWebAdapter } from "../packages/adapter-web/dist/index.js";

const allowWrites = process.argv.includes("--writes");
const report = await runDiagnostics(createWebAdapter(), { allowWrites });
console.log(reportToMarkdown(report));
console.log("summary:", JSON.stringify(report.summary));
