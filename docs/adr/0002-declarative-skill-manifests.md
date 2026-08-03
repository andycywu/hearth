# ADR-0002: Declarative skill manifests

- Status: Accepted
- Date: 2026-08-03

## Context

A skill today is TypeScript compiled into the bundle: `new Agent({ tools: [...] })`.
That is fine for the people building the runtime and wrong for everyone else —
adding a skill means a rebuild, a repackage and a reinstall on every TV.

We want skills to be addable without rebuilding, which is what turns this from a
library into something with an ecosystem. The obvious route — download and
`eval()` JavaScript — is the one we refuse: every host ships
`script-src 'self'`, and a TV that will later hold privileged capabilities is
the last place to introduce remote code execution.

Most useful skills don't need code. Weather, sports scores, recipes, transit,
smart-home bridges: each is "call this HTTP endpoint with these arguments and
summarize the answer". That is expressible as **data**.

## Decision

A skill may be a **manifest**: a JSON document describing one tool — its schema,
one HTTP request, and how to reduce the response to a small flat object. The
runtime interprets it. **No code is loaded, ever.**

```jsonc
{
  "name": "get_weather",
  "description": "Current weather for a city.",
  "parameters": {
    "city": { "type": "string", "description": "City name", "required": true }
  },
  "request": {
    "url": "https://api.open-meteo.com/v1/forecast?latitude={lat}&longitude={lon}&current=temperature_2m"
  },
  "response": { "tempC": "current.temperature_2m" }
}
```

### Sources, and which we accept

| | Source | Decision |
|---|---|---|
| (a) | Bundled with the app at build time | **Yes** — zero new risk |
| (b) | Installed into `platform.storage` by the user or OEM | **Yes** — a deliberate act is the trust boundary |
| (c) | Fetched from a URL at boot | **No** |

(c) is rejected because it lets a server change what the TV does with no user
action, and it breaks offline start-up. If it is ever wanted it needs signed
manifests, a pinned origin and explicit consent — a distribution decision, quite
separate from the plugin format. The format is identical in all three cases, so
adding a source later is a policy change, not a rewrite.

(b) depends on `platform.storage` actually persisting, which it did not until
recently — see the M2.5 fix.

### Guardrails

A manifest is data, but it *does* describe an outbound request carrying
model-generated arguments. So:

- **The host owns the allowlist.** `createManifestTool(manifest, { allowOrigins })`.
  A manifest cannot widen it. Nothing is allowed by default.
- **https only**, or loopback for an on-device service.
- **No headers from the manifest.** Otherwise a skill could attach credentials
  to a request of its choosing.
- **Only declared parameters interpolate.** `{city}` resolves to a validated
  argument; conversation text never reaches a URL or body. Values are
  percent-encoded in URLs.
- **Anything not `GET` is forced to `confirm: true`.** A side effect gets a
  human in the loop.
- **Response mapping is dot/bracket paths only** — `current.temperature_2m`,
  `results[0].name`. No expressions, therefore no evaluator.
- **Strict validation.** Unknown fields are an error, so a typo can't silently
  disable a guardrail. Callers get a list of problems, which lets an installer
  reject a bad manifest instead of failing later on a TV.
- **Caps** on manifest size, parameter count and response body size.

### What this deliberately does not do

Chained requests, auth flows, pagination, conditionals. A skill needing those is
a code skill (`defineTool`) — the manifest format is for the flat majority, not a
programming language in JSON.

## Consequences

- Skills become installable data. An OEM can ship different skills per region or
  model without touching the app; a developer can iterate without a reinstall.
- The CSP and the "no remote code" property are preserved exactly.
- The interpreter is a new surface to keep small and well-tested; its security
  properties are only as good as its tests, so the guardrails above are each
  covered by cases that assert the *refusal*.
- Manifests can express less than code. That is the trade being made, and the
  escape hatch (`defineTool`) stays.
