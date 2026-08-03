import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, existsSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const generator = join(dirname(fileURLToPath(import.meta.url)), "index.mjs");

/** Run the generator in a throwaway directory and return where it wrote. */
function generate(args, { workspace = false } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "tv-skill-"));
  if (workspace) {
    // Enough of a monorepo for findWorkspaceRoot to recognise it.
    writeFileSync(join(dir, "pnpm-workspace.yaml"), 'packages:\n  - "packages/*"\n');
    mkdirSync(join(dir, "packages"));
  }
  const out = execFileSync(process.execPath, [generator, ...args], { cwd: dir, encoding: "utf8" });
  return { dir, out };
}
const cleanup = (dir) => rmSync(dir, { recursive: true, force: true });

test("generates a complete skill package", () => {
  const { dir } = generate(["my-skill"]);
  const root = join(dir, "my-skill");
  for (const f of ["package.json", "tsconfig.json", "README.md",
                   "src/index.ts", "src/my-skill.ts", "src/my-skill.test.ts"]) {
    assert.ok(existsSync(join(root, f)), `missing ${f}`);
  }
  cleanup(dir);
});

test("names things consistently from one kebab-case argument", () => {
  const { dir } = generate(["sleep-timer"]);
  const root = join(dir, "sleep-timer");
  const skill = readFileSync(join(root, "src", "sleep-timer.ts"), "utf8");
  // Tool names are snake_case; the factory is PascalCase.
  assert.match(skill, /name: "sleep_timer"/);
  assert.match(skill, /export function createSleepTimerTool/);
  assert.match(readFileSync(join(root, "src", "index.ts"), "utf8"), /createSleepTimerTool/);
  assert.equal(JSON.parse(readFileSync(join(root, "package.json"), "utf8")).name,
    "@tv-ai-agent/sleep-timer");
  cleanup(dir);
});

test("outside a workspace it depends on the published core", () => {
  const { dir } = generate(["my-skill"]);
  const pkg = JSON.parse(readFileSync(join(dir, "my-skill", "package.json"), "utf8"));
  assert.match(pkg.dependencies["@tv-ai-agent/core"], /^\^\d/);
  const ts = JSON.parse(readFileSync(join(dir, "my-skill", "tsconfig.json"), "utf8"));
  assert.ok(!ts.extends, "a standalone package can't extend the monorepo base config");
  assert.ok(!ts.references, "and has nothing to reference");
  cleanup(dir);
});

test("inside a workspace it lands in packages/ and links by workspace protocol", () => {
  const { dir } = generate(["my-skill"], { workspace: true });
  const root = join(dir, "packages", "my-skill");
  assert.ok(existsSync(root), "should generate into packages/");
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  assert.equal(pkg.dependencies["@tv-ai-agent/core"], "workspace:*");
  const ts = JSON.parse(readFileSync(join(root, "tsconfig.json"), "utf8"));
  assert.equal(ts.extends, "../../tsconfig.base.json");
  assert.deepEqual(ts.references, [{ path: "../core" }]);
  cleanup(dir);
});

test("--http generates the fetch variant, with the timeout and mocked tests", () => {
  const { dir } = generate(["weather-ish", "--http"]);
  const skill = readFileSync(join(dir, "weather-ish", "src", "weather-ish.ts"), "utf8");
  assert.match(skill, /AbortController/);
  assert.match(skill, /timeoutMs/);
  const spec = readFileSync(join(dir, "weather-ish", "src", "weather-ish.test.ts"), "utf8");
  assert.match(spec, /fakeFetch/);
  assert.doesNotMatch(spec, /await fetch\(/, "tests must not reach the network");
  cleanup(dir);
});

test("rejects a name that isn't kebab-case", () => {
  for (const bad of ["MySkill", "my_skill", "-leading", "trailing-", "my--skill"]) {
    assert.throws(() => generate([bad]), /kebab-case|Command failed/i, `accepted ${bad}`);
  }
});

test("refuses to overwrite a non-empty directory", () => {
  const dir = mkdtempSync(join(tmpdir(), "tv-skill-"));
  mkdirSync(join(dir, "taken"));
  writeFileSync(join(dir, "taken", "keep.txt"), "important");
  assert.throws(
    () => execFileSync(process.execPath, [generator, "taken"], { cwd: dir, encoding: "utf8" }),
    /Command failed/,
  );
  assert.equal(readFileSync(join(dir, "taken", "keep.txt"), "utf8"), "important");
  cleanup(dir);
});

test("prints the two lines needed to register the skill", () => {
  const { dir, out } = generate(["my-skill"]);
  assert.match(out, /createMySkillTool/);
  assert.match(out, /new Agent\(/);
  cleanup(dir);
});
