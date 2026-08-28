#!/usr/bin/env node
/**
 * Scaffold a TV AI Agent skill.
 *
 *   npm create hearth-skill my-skill        # or: pnpm new:skill my-skill
 *   npm create hearth-skill my-skill --http # variant that calls an HTTP API
 *
 * Generates a package that already passes its own tests, so the first thing you
 * see is green rather than a compile error. Inside this monorepo it lands in
 * packages/ and wires up with `workspace:*`; anywhere else it's a standalone
 * package depending on the published core.
 */
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve, basename } from "node:path";

const CORE_VERSION = "^0.1.0";

const args = process.argv.slice(2).filter((a) => a !== "--");
const flags = new Set(args.filter((a) => a.startsWith("--")));
const positional = args.filter((a) => !a.startsWith("--"));
const http = flags.has("--http");

const rawName = positional[0];
if (!rawName || flags.has("--help")) {
  console.log(`
  Usage: npm create hearth-skill <name> [--http]

    <name>   kebab-case, e.g. sleep-timer, sports-scores
    --http   generate the variant that calls an HTTP API (timeout + mocked tests)
`);
  process.exit(rawName ? 0 : 1);
}

const name = rawName.replace(/^@[^/]+\//, "");
if (!/^[a-z][a-z0-9]*(-[a-z0-9]+)*$/.test(name)) {
  fail(`"${name}" should be kebab-case: lowercase letters, digits and single hyphens.`);
}

/** my-skill → my_skill (tool names are snake_case; models cope best with those). */
const toolName = name.replace(/-/g, "_");
/** my-skill → MySkill */
const pascal = name.split("-").map((p) => p[0].toUpperCase() + p.slice(1)).join("");

// Inside the monorepo, generate a workspace package; outside, a standalone one.
const workspaceRoot = findWorkspaceRoot(process.cwd());
const target = workspaceRoot ? join(workspaceRoot, "packages", name) : resolve(process.cwd(), name);
const coreSpec = workspaceRoot ? "workspace:*" : CORE_VERSION;

if (existsSync(target) && readdirSync(target).length > 0) {
  fail(`${target} already exists and isn't empty.`);
}

function findWorkspaceRoot(from) {
  let dir = resolve(from);
  for (let i = 0; i < 8; i++) {
    if (existsSync(join(dir, "pnpm-workspace.yaml")) && existsSync(join(dir, "packages"))) return dir;
    const up = resolve(dir, "..");
    if (up === dir) break;
    dir = up;
  }
  return undefined;
}
function fail(msg) {
  console.error(`\n  ${msg}\n`);
  process.exit(1);
}
function write(rel, contents) {
  const path = join(target, rel);
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, contents, "utf8");
  console.log(`  + ${join(workspaceRoot ? `packages/${name}` : name, rel).replace(/\\/g, "/")}`);
}

mkdirSync(target, { recursive: true });
console.log(`\nCreating the ${name} skill${http ? " (HTTP variant)" : ""}:\n`);

write("package.json", JSON.stringify({
  name: `@hearthkit/${name}`,
  version: "0.1.0",
  private: true,
  description: `A TV AI Agent skill: ${toolName}.`,
  type: "module",
  main: "dist/index.js",
  types: "dist/index.d.ts",
  scripts: { build: "tsc -b", typecheck: "tsc --noEmit", test: "vitest run --passWithNoTests" },
  dependencies: { "@hearthkit/core": coreSpec },
  license: "Apache-2.0",
}, null, 2) + "\n");

write("tsconfig.json", JSON.stringify({
  extends: workspaceRoot ? "../../tsconfig.base.json" : undefined,
  compilerOptions: workspaceRoot
    ? { composite: true, outDir: "dist", rootDir: "src" }
    : {
        target: "ES2020", module: "ESNext", moduleResolution: "Bundler", strict: true,
        declaration: true, outDir: "dist", rootDir: "src",
      },
  include: ["src/**/*"],
  exclude: ["src/**/*.test.ts", "dist"],
  ...(workspaceRoot ? { references: [{ path: "../core" }] } : {}),
}, null, 2).replace(/^\s*"extends": undefined,\n/m, "") + "\n");

write("src/index.ts", `export { create${pascal}Tool, type ${pascal}Result } from "./${name}.js";\n`);

write(`src/${name}.ts`, http ? httpSkill() : pureSkill());
write(`src/${name}.test.ts`, http ? httpTest() : pureTest());
write("README.md", readme());

console.log(`
Next:

  ${workspaceRoot ? `pnpm install && pnpm --filter @hearthkit/${name} test` : `cd ${name} && npm install && npm test`}

Then register it with an agent:

  import { create${pascal}Tool } from "@hearthkit/${name}";
  const agent = new Agent({ platform, llm, tools: [create${pascal}Tool()] });

Guide: https://github.com/andycywu/hearth/blob/main/docs/skills.md
`);

// --- templates -------------------------------------------------------------

function pureSkill() {
  return `import { defineTool, type Tool } from "@hearthkit/core";

/**
 * ${toolName} — a pure-logic skill.
 *
 * It touches no device capability, so the same code runs on Android TV, Tizen,
 * webOS and in the browser harness. Keep it that way if you can: the moment a
 * skill needs a privileged platform API it stops being portable. See
 * docs/skills.md.
 */

export interface ${pascal}Result {
  /** Keep results small and flat — they go back into the model's context. */
  ok: true;
  input: string;
  answer: string;
}

export function create${pascal}Tool(): Tool<{ input: string }, ${pascal}Result> {
  return defineTool<{ input: string }, ${pascal}Result>(
    {
      name: "${toolName}",
      // The model picks tools by this description. Say when to use it, not how.
      description: "Describe what this does and when the assistant should use it.",
      parameters: {
        input: { type: "string", description: "What the user asked about", required: true },
      },
      // confirm: true,   // uncomment for anything with side effects
    },
    async ({ input }) => {
      const trimmed = input.trim();
      // Throw with a sentence a model can act on — it's fed back as a tool
      // result, so the turn recovers instead of dying.
      if (!trimmed) throw new Error("I need something to work with.");

      return { ok: true, input: trimmed, answer: \`You said: \${trimmed}\` };
    },
  );
}
`;
}

function pureTest() {
  return `import { describe, it, expect } from "vitest";
import { create${pascal}Tool } from "./${name}.js";

describe("${toolName}", () => {
  it("declares a schema the model can fill in", () => {
    const tool = create${pascal}Tool();
    expect(tool.spec.name).toBe("${toolName}");
    expect(tool.spec.parameters.input?.required).toBe(true);
  });

  it("returns a small flat result", async () => {
    const result = await create${pascal}Tool().execute({ input: "hello" });
    expect(result).toEqual({ ok: true, input: "hello", answer: "You said: hello" });
  });

  it("explains an empty input instead of throwing something cryptic", async () => {
    await expect(create${pascal}Tool().execute({ input: "   " }))
      .rejects.toThrow(/need something/i);
  });
});
`;
}

function httpSkill() {
  return `import { defineTool, type Tool } from "@hearthkit/core";

/**
 * ${toolName} — a skill that calls an HTTP API.
 *
 * No device capability, so it runs identically on every TV target. Two things
 * that matter on a TV specifically: a timeout (a dropped network must not leave
 * the set silent) and a small flat result (it goes back into the model's
 * context). See docs/skills.md.
 */

export interface ${pascal}Options {
  /** Injected by tests; defaults to the global fetch. */
  fetchImpl?: typeof fetch;
  /** Give up after this long. Default 8000ms. */
  timeoutMs?: number;
}

export interface ${pascal}Result {
  query: string;
  answer: string;
}

const ENDPOINT = "https://example.com/api";   // ← your API

export function create${pascal}Tool(opts: ${pascal}Options = {}): Tool<{ query: string }, ${pascal}Result> {
  const doFetch = opts.fetchImpl ?? ((...a: Parameters<typeof fetch>) => fetch(...a));
  const timeoutMs = opts.timeoutMs ?? 8000;

  return defineTool<{ query: string }, ${pascal}Result>(
    {
      name: "${toolName}",
      description: "Describe what this does and when the assistant should use it.",
      parameters: {
        query: { type: "string", description: "What to look up", required: true },
      },
    },
    async ({ query }) => {
      const q = query.trim();
      if (!q) throw new Error("I need something to look up.");

      const controller = typeof AbortController === "function" ? new AbortController() : undefined;
      const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : undefined;
      try {
        const res = await doFetch(
          \`\${ENDPOINT}?q=\${encodeURIComponent(q)}\`,
          controller ? { signal: controller.signal } : {},
        );
        if (!res.ok) throw new Error(\`the service answered HTTP \${res.status}\`);
        const data = await res.json() as { answer?: string };
        if (!data.answer) throw new Error(\`I couldn't find anything for "\${q}".\`);
        return { query: q, answer: data.answer };
      } catch (err) {
        if ((err as Error)?.name === "AbortError") {
          throw new Error(\`the service didn't answer within \${timeoutMs}ms.\`);
        }
        throw err;
      } finally {
        if (timer !== undefined) clearTimeout(timer);
      }
    },
  );
}
`;
}

function httpTest() {
  return `import { describe, it, expect } from "vitest";
import { create${pascal}Tool } from "./${name}.js";

/** Tests must never hit the network. */
function fakeFetch(replies: Array<{ ok?: boolean; status?: number; body?: unknown }>) {
  const urls: string[] = [];
  const impl = (async (url: string) => {
    urls.push(String(url));
    const next = replies.shift() ?? { ok: false, status: 500 };
    return { ok: next.ok ?? true, status: next.status ?? 200, json: async () => next.body };
  }) as unknown as typeof fetch;
  return { impl, urls };
}

describe("${toolName}", () => {
  it("declares a schema the model can fill in", () => {
    const tool = create${pascal}Tool();
    expect(tool.spec.name).toBe("${toolName}");
    expect(tool.spec.parameters.query?.required).toBe(true);
  });

  it("calls the API and returns a small flat result", async () => {
    const { impl, urls } = fakeFetch([{ body: { answer: "42" } }]);
    const result = await create${pascal}Tool({ fetchImpl: impl }).execute({ query: "meaning of life" });
    expect(result).toEqual({ query: "meaning of life", answer: "42" });
    expect(urls[0]).toContain(encodeURIComponent("meaning of life"));
  });

  it("surfaces an HTTP failure", async () => {
    const { impl } = fakeFetch([{ ok: false, status: 503 }]);
    await expect(create${pascal}Tool({ fetchImpl: impl }).execute({ query: "x" }))
      .rejects.toThrow(/HTTP 503/);
  });

  it("explains an empty result rather than returning nothing", async () => {
    const { impl } = fakeFetch([{ body: {} }]);
    await expect(create${pascal}Tool({ fetchImpl: impl }).execute({ query: "nothing" }))
      .rejects.toThrow(/couldn't find anything/i);
  });

  it("turns a timeout into a readable message", async () => {
    const impl = (async () => {
      const err = new Error("aborted");
      err.name = "AbortError";
      throw err;
    }) as unknown as typeof fetch;
    await expect(create${pascal}Tool({ fetchImpl: impl, timeoutMs: 25 }).execute({ query: "x" }))
      .rejects.toThrow(/didn't answer within 25ms/);
  });
});
`;
}

function readme() {
  return `# @hearthkit/${name}

A [Hearth](https://github.com/andycywu/hearth) skill. One tool,
\`${toolName}\`, that runs unchanged on Android TV, Tizen, webOS and in the
browser harness${http ? " — it only needs `fetch`" : " — it needs no device capability at all"}.

\`\`\`ts
import { Agent } from "@hearthkit/core";
import { create${pascal}Tool } from "@hearthkit/${name}";

const agent = new Agent({ platform, llm, tools: [create${pascal}Tool()] });
\`\`\`

## Develop

\`\`\`bash
pnpm test          # ${http ? "network is mocked; nothing here touches it" : "no network, no device"}
\`\`\`

Try it against the browser harness: register the tool in
\`apps/dev-harness/src/main.ts\`, then \`pnpm dev\`.

## What to change

1. \`spec.description\` — the model chooses tools by this. Say *when* to use it.
2. \`spec.parameters\` — described well enough that a 3B local model fills them in.
   They're validated before your code runs.
3. \`execute\` — return something small and flat; it goes back into the prompt.
4. Add \`confirm: true\` if it has side effects the user should approve.
${http ? "5. `ENDPOINT` — point it at your API.\n" : ""}
Throw plain sentences on failure: the message is fed back to the model, so it can
recover instead of the turn dying.

Full guide: [docs/skills.md](https://github.com/andycywu/hearth/blob/main/docs/skills.md)
`;
}
