# A5 — Skill tutorial + example skill

> The owner deferred this earlier — **confirm it's wanted before doing.**

## Why
The whole value proposition is "write a skill once, run on every TV". Prove it
with a concrete, runnable example and a short guide, reusing the existing
`defineTool` extension point (no core changes).

## Deliverables
1. **`docs/skills.md`** — "Write a cross-vendor skill":
   - The two kinds of skill: **pure-logic / external-service** (100% portable,
     no signing) vs **capability-gated** (needs privilege). Reuse the framing in
     `docs/POC.md` and the chat rationale.
   - How a skill = one or more tools via `defineTool`, registered through
     `AgentOptions.tools` (link `docs/extending.md`).
   - Guidance: keep skills pure/portable; call external APIs from the web bundle;
     gate device control behind `has()`.
2. **An example skill** — a small, dependency-free tool that calls a public API.
   Suggested: a "weather" skill.
   - **New:** `packages/skills-example/` (private workspace package) OR simpler,
     `apps/dev-harness/src/skills/weather.ts`. Prefer a package if you want it
     reusable:
     ```ts
     import { defineTool } from "@tv-ai-agent/core";
     export const weatherTool = defineTool(
       { name: "get_weather", description: "Current weather for a city.",
         parameters: { city: { type: "string", description: "City name", required: true } } },
       async ({ city }) => {
         // Use a keyless API (e.g. open-meteo geocoding + forecast) via fetch.
         // Return a compact { city, tempC, summary } object.
       },
     );
     ```
   - Wire it into the dev harness: `new Agent({ ..., tools: [weatherTool] })` and
     add a scripted-brain rule (or rely on a real LLM) so "what's the weather in
     Taipei?" triggers `get_weather`.
3. **Tests:** unit-test the tool with a mock `fetch` (assert it parses the API
   shape into the compact result). Do **not** hit the network in tests.

## Acceptance
- `docs/skills.md` exists and is linked from `README.md` + `docs/extending.md`.
- The example tool has a passing unit test (mock fetch).
- In `pnpm dev`, asking for the weather (with a real LLM via `?llm=`) calls
  `get_weather` and renders the result. (Scripted-brain path optional.)
- Main green gate passes; no new deps in `packages/core`.

## Verify
```bash
pnpm test         # weather tool test green
pnpm dev          # try it with ?llm=<local model>
```

## Notes
- Pick a **keyless** weather API (e.g. Open-Meteo) so the demo needs no secrets.
- Respect CSP: if bundled into a device app later, add the API origin to
  `connect-src` in that app's `index.html`.
