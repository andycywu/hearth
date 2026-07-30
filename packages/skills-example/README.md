# @tv-ai-agent/skills-example

A worked example of a **cross-vendor skill**: `get_weather`, backed by the keyless
[Open-Meteo](https://open-meteo.com) API. It needs no HAL capability and no vendor
signature, so the same code runs on AOSP, Tizen, webOS and the browser harness —
the portability argument in [`docs/skills.md`](../../docs/skills.md), made
concrete.

```ts
import { Agent } from "@tv-ai-agent/core";
import { createWeatherTool } from "@tv-ai-agent/skills-example";

const agent = new Agent({ platform, llm, tools: [createWeatherTool()] });
await agent.run("what's the weather in Taipei?");
// get_weather({ city: "Taipei" }) → { city, country, tempC, summary }
```

Try it in the dev harness (opt-in, because it is the only part of the offline demo
that uses the network):

```bash
pnpm dev
# http://localhost:5173/?skills=weather
```

## What it demonstrates
- `defineTool` with a schema the runtime validates before `execute` runs.
- Two chained HTTP calls (geocode → forecast) collapsed into one small, flat
  result — the model gets a summary, not raw JSON.
- Failure messages written for a model to recover from ("I couldn't find a place
  called …") rather than raw error codes.
- An `AbortController` timeout, so a dropped network can't leave the TV silent.
- 13 unit tests with a fake `fetch`; nothing touches the network.

Not published — it's a reference to copy, not a dependency to take.
