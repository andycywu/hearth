# Write a cross-vendor skill

A **skill** is one or more tools you register with the agent. The agent core, the
adapters and the UI stay untouched — you add capability, not plumbing. This is
where the "one runtime across AOSP / Tizen / webOS and MediaTek / Novatek" claim
gets tested: a skill written once should run on every target without a per-vendor
fork.

Whether it does comes down to one question.

## The one question: does it need device privilege?

| | **Pure-logic / external-service skill** | **Capability-gated skill** |
|---|---|---|
| Examples | weather, sports scores, recipes, translation, reminders, "what's on tonight" | HDMI input switch, standby, injecting keys into another app, tuner control |
| Needs | `fetch` and/or arithmetic | a privileged platform API |
| Signing | none | partner/platform certificate (Tizen) or system signature (Android) |
| Portability | **identical on every target** | per-OS, per-firmware, often per-vendor |
| Where it lives | your own tool via `defineTool` | `platform-api` → every adapter → contract test → tool |

Write skills in the left column wherever you can. They are the ones that ship
today on a retail TV with no vendor relationship — the ✅ column of
[`POC.md`](POC.md). Anything in the right column belongs in the HAL, not in a
skill: extend `platform-api`, implement it in **every** adapter, add it to
`assertProviderContract`, then expose a tool. That path is
[`extending.md`](extending.md) → "New OS target" and the rules in
[`internal/HANDOFF.md`](internal/HANDOFF.md).

The two mix cleanly: a skill may *use* a device capability as long as it checks
first, so the same bundle degrades instead of breaking.

```ts
// A skill that dims the lights AND pauses playback, on TVs that can pause.
if (platform.has("media") && platform.media) await platform.media.pause();
```

## Start from a scaffold

```bash
npm create tv-agent-skill sleep-timer        # pure logic, no network
npm create tv-agent-skill sports-scores --http   # calls an HTTP API
```

Both generate a package whose tests already pass, so your first run is green and
you edit from there. Inside this repo it lands in `packages/` and links with
`workspace:*`; outside, it's a standalone package. `--http` includes the two
things a TV skill needs that a server-side one doesn't: an `AbortController`
timeout and tests with `fetch` mocked.

## Anatomy of a skill

One tool = a spec the model reads plus an `execute` you write. `defineTool` gives
you inferred argument types.

```ts
import { Agent, defineTool } from "@tv-ai-agent/core";

const setSleepTimer = defineTool(
  {
    name: "set_sleep_timer",
    description: "Turn the TV off after a number of minutes.",
    parameters: {
      minutes: { type: "number", description: "Minutes from now, 1-240", required: true },
    },
    confirm: true,          // high-impact → the host asks first
  },
  async ({ minutes }) => {
    // ...your logic...
    return { ok: true, minutes };
  },
);

const agent = new Agent({ platform, llm, tools: [setSleepTimer] });
```

What the runtime does for you:

- **Validation is a security boundary.** `parameters` is enforced before
  `execute` runs (required keys, `enum`, string→number/boolean coercion), so you
  never hand raw model output to a device API. See `validateArgs`.
- **Errors are recoverable.** Throw, and the message is fed back to the model as
  a structured tool result so it can try something else — the turn doesn't abort.
  Write messages a model can act on: *"I couldn't find a place called
  'Atlantis'"*, not *"ENOTFOUND"*.
- **`confirm: true`** routes through the host's confirm handler
  (`createConfirmHandler()` in `@tv-ai-agent/ui`). Use it for anything the user
  would be annoyed to see happen silently.
- **The built-in `help` tool** lists whatever you registered, so "what can you
  do?" stays accurate for free.

## Guidelines

1. **Keep the device out of it** unless you need it. A skill that only calls an
   HTTP API has no adapter surface to get wrong.
2. **Gate every device call behind `has()`** and give the user something useful
   when the answer is no.
3. **Return small, flat objects.** The result goes back into the prompt; a 200-row
   JSON payload costs latency and confuses small local models. Summarize in the
   tool, not in the model.
4. **Set a timeout.** A TV waiting on a network a hotel firewall is dropping must
   still answer. The example uses `AbortController` with an 8s default.
5. **Keyless APIs first.** Anything requiring a secret needs a story for where
   the secret lives on a device you don't control.
6. **Respect CSP.** Every app host ships a `Content-Security-Policy` meta tag.
   `connect-src` already allows `https:` plus localhost, so a keyless HTTPS API
   works out of the box; a plain-HTTP endpoint does not, by design.
7. **Test with a fake `fetch`.** Skill tests must not hit the network.

## The worked example

[`packages/skills-example`](../packages/skills-example) implements `get_weather`
against Open-Meteo (no API key) in ~100 lines, with 13 tests and no network in
any of them.

```ts
import { createWeatherTool } from "@tv-ai-agent/skills-example";

const agent = new Agent({ platform, llm, tools: [createWeatherTool()] });
await agent.run("what's the weather in Taipei?");
// → get_weather({ city: "Taipei" }) → { city, country, tempC, summary }
```

Try it in the dev harness — the skill is opt-in because it is the one thing in
the offline demo that touches the network:

```bash
pnpm dev
# http://localhost:5173/?skills=weather   then ask: what's the weather in Taipei?
```

That works with the **offline scripted brain** as well as a real model: the
scripted brain only proposes `get_weather` when the host actually registered it,
which is the same capability discipline the tools use for `has("media")`. With a
real endpoint (`?llm=http://127.0.0.1:11434/v1&model=…`) the model decides on its
own, and phrasings the pattern matcher can't parse start working too.

Nothing in that tool is platform-specific, which is the whole point: bundle it
into the Tizen `.wgt`, the Android APK or the webOS `.ipk` and it behaves the
same on all three.

## Without writing code: a skill manifest

Some skills are nothing but "call this URL, keep these three fields." For those
you can skip TypeScript entirely and ship a JSON **manifest** — data the runtime
interprets, never code it runs. That means a skill can be added to a TV that has
already shipped, and reviewed by someone who doesn't read TypeScript.

```json
{
  "name": "get_current_weather",
  "description": "Current temperature and wind at a latitude/longitude.",
  "parameters": {
    "latitude":  { "type": "number", "description": "Decimal degrees", "required": true },
    "longitude": { "type": "number", "description": "Decimal degrees", "required": true }
  },
  "request": {
    "url": "https://api.open-meteo.com/v1/forecast?latitude={latitude}&longitude={longitude}&current=temperature_2m",
    "timeoutMs": 8000
  },
  "response": { "temperatureC": "current.temperature_2m" }
}
```

That is the whole format: a schema the model chooses on, one HTTP request whose
`{placeholders}` are filled from validated arguments, and paths that reduce the
response to something small enough to put back in a prompt. The shipped copy is
[`examples/open-meteo-weather.json`](../packages/skill-manifest/examples/open-meteo-weather.json).

Two ways in, and the host decides which origins any of them may reach:

```ts
import { loadBundledSkills, loadInstalledSkills } from "@tv-ai-agent/skill-manifest";
import weather from "./skills/weather.json";

const allowOrigins = ["https://api.open-meteo.com"];   // the host owns this list
const tools = [
  ...await loadBundledSkills([weather], { allowOrigins }),        // (a) in the app bundle
  ...await loadInstalledSkills(platform.storage, { allowOrigins,  // (b) installed on the device
      onSkipped: (name, why) => console.warn(`skipping ${name}: ${why}`) }),
];
new Agent({ platform, llm, tools });
```

Installing at run time is `installManifest(platform.storage, json)`, which
validates first and returns every problem at once. There is deliberately no
third source: the runtime never fetches a skill on its own.

**What a manifest cannot do**, and why — the reasoning is in
[ADR-0002](adr/0002-declarative-skill-manifests.md):

| It can't… | Because |
|---|---|
| reach an origin the host didn't allowlist | a manifest must not widen its own reach; checked at load, not first call |
| put a `{placeholder}` in the host | an allowlist is worthless if an argument picks the destination |
| send headers | otherwise a skill could attach the host's credentials to a request of its choosing |
| use plain HTTP to a remote host | https, or loopback for a service on the TV itself |
| interpolate anything but a declared parameter | the registry validated those against the schema; conversation text was never validated |
| do a non-GET without asking | `confirm` is forced true for POST, whatever the manifest says |
| evaluate an expression in `response` | paths only (`a.b[0].c`), so there is no evaluator to escape from — and paths can't walk the prototype chain |

Unknown fields are rejected rather than ignored, so a typo can't quietly turn a
guardrail off. Reach for a real `defineTool` skill when you need arithmetic,
more than one request, a device capability, or anything conditional.

## Checklist before you ship a skill

- [ ] No `tizen.*`, no Android bridge, no `webOS.*` outside an adapter.
- [ ] Every device capability it uses is behind `has()`.
- [ ] Arguments are described well enough that a 3B local model fills them in.
- [ ] `confirm: true` on anything with side effects the user should approve.
- [ ] Failure messages read like sentences.
- [ ] Tests pass with `fetch` mocked; no network in CI.
- [ ] If it calls a non-HTTPS or unusual origin, the host `index.html`
      `connect-src` is updated.
