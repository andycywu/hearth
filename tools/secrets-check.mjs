#!/usr/bin/env node
/**
 * Refuse to let a credential reach the repository.
 *
 *   node tools/secrets-check.mjs [--staged]
 *
 * Scans tracked files (or, with `--staged`, what is about to be committed) for
 * things shaped like API keys. It runs in CI, and it is worth running as a
 * pre-commit hook — the cheapest moment to catch a key is before it exists in
 * history, because after that the only real fix is rotating it.
 *
 * Two things this is not. It is not a guarantee: a key that looks like nothing in
 * particular passes, which is why the actual defence is that no host reads a key
 * from anywhere a repository can see it (environment, host global, or the Android
 * keystore — never a URL, never a source file). And it is not a secret scanner
 * with a threat model; it is a tripwire for the mistake people actually make,
 * which is pasting a key into a config or a test while debugging.
 */
import { execFileSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";

const staged = process.argv.includes("--staged");

/**
 * Patterns for credentials, not for the word "key".
 *
 * Each one wants *length and entropy shape*, because `apiKey: opts.apiKey` is a
 * variable reference and `apiKey: "sk-abc"` is a paste. Getting that wrong in the
 * noisy direction makes the check something people disable.
 */
const PATTERNS = [
  [/\bsk-[A-Za-z0-9]{20,}\b/, "OpenAI-style secret key"],
  [/\bsk-ant-[A-Za-z0-9_-]{20,}\b/, "Anthropic-style key"],
  [/\bAIza[A-Za-z0-9_-]{30,}\b/, "Google API key"],
  [/\bghp_[A-Za-z0-9]{30,}\b/, "GitHub personal access token"],
  [/\bxox[baprs]-[A-Za-z0-9-]{10,}\b/, "Slack token"],
  [/\b(?:mp|modelpilot)_(?:live|prod|sk)_[A-Za-z0-9_-]{12,}\b/, "ModelPilot-style key"],
  [/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/, "private key block"],
  [
    // An assignment of a long opaque literal to something credential-named.
    /(?:api[_-]?key|secret|token|password|credential)\s*[:=]\s*["'`][A-Za-z0-9_\-./+]{24,}["'`]/i,
    "credential assigned a literal value",
  ],
];

/** Files that legitimately contain credential-shaped text. */
const ALLOWED_PATHS = [
  /^tools\/secrets-check\.mjs$/,           // this file: the patterns themselves
  /^pnpm-lock\.yaml$/,                     // integrity hashes, not credentials
  /\.(png|jpg|jar|wgt|ipk|apk|bin|map)$/,
];

/**
 * Markers that make a match obviously synthetic.
 *
 * These are substrings, so they must be things that cannot appear in a real
 * credential by accident. The first version of this list contained `"sk-"`,
 * which whitelisted *every* OpenAI-style key — the tripwire reported a clean
 * tree while a freshly generated `sk-` key sat staged in front of it. A probe
 * caught it, which is the only reason this file is worth anything: an allowlist
 * entry that is a prefix of the thing it is allowing is not an exception, it is
 * an off switch.
 */
const SYNTHETIC_MARKERS = [
  "NOT-A-REAL",
  "EXAMPLE",
  "PLACEHOLDER",
  "your-key-here",
  "xxxxxxxx",
  "…",
];

function tracked() {
  const args = staged
    ? ["diff", "--cached", "--name-only", "--diff-filter=ACM"]
    : ["ls-files"];
  return execFileSync("git", args, { encoding: "utf8" })
    .split("\n")
    .map((f) => f.trim())
    .filter(Boolean);
}

const findings = [];

for (const file of tracked()) {
  if (ALLOWED_PATHS.some((re) => re.test(file))) continue;
  let text;
  try {
    if (statSync(file).size > 2 << 20) continue;      // no giant binaries
    text = readFileSync(file, "utf8");
  } catch {
    continue;                                          // deleted, or not readable as text
  }

  text.split("\n").forEach((line, i) => {
    for (const [pattern, what] of PATTERNS) {
      const hit = pattern.exec(line);
      if (!hit) continue;
      if (SYNTHETIC_MARKERS.some((v) => hit[0].includes(v))) continue;
      findings.push({ file, line: i + 1, what, sample: mask(hit[0]) });
    }
  });
}

/** Show enough to find it, not enough to use it. */
function mask(value) {
  return value.length <= 12 ? "***" : `${value.slice(0, 6)}…${value.slice(-2)}`;
}

if (findings.length) {
  console.error(`\n✖ ${findings.length} possible credential(s) in ${staged ? "the staged changes" : "tracked files"}:\n`);
  for (const f of findings) {
    console.error(`  ${f.file}:${f.line}  ${f.what}  (${f.sample})`);
  }
  console.error(`
If it is real: do not just delete the line — it is already in your working tree
and possibly in history. Rotate the credential first, then remove it, and put it
where a host actually reads one:

  CLI / Node        MODELPILOT_API_KEY in the environment
  dev harness       window.__MODELPILOT_API_KEY__ before the bundle loads
  Android TV        adb shell am start -n tv.aiagent.harness/.MainActivity -e mpKey <key>

If it is a fixture: make it not look like a credential, or give it one of the
synthetic markers listed in tools/secrets-check.mjs (NOT-A-REAL, EXAMPLE, …).
`);
  process.exit(1);
}

console.log(`✓ No credential-shaped strings in ${staged ? "staged changes" : "tracked files"}.`);
