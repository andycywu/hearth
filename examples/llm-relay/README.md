# llm-relay

A minimal OpenAI-compatible relay, so the API key never reaches the TV.

A television is a device you hand to someone else, and the key on it is the same
key on every unit of that model — one extraction is everyone's key and everyone's
bill. Putting the key behind a relay is the only arrangement that survives that.

```bash
UPSTREAM_API_KEY=sk-… node server.mjs
```

Then point the TV at it instead of at the provider:

```bash
adb shell am start -n tv.aiagent.harness/.MainActivity \
  -e start 'index.html?llm=https://relay.example.com/v1'
```

## Environment

| Variable | Default | Notes |
| --- | --- | --- |
| `UPSTREAM_API_KEY` | *(required)* | Refuses to start without it |
| `UPSTREAM_BASE_URL` | `https://api.openai.com/v1` | Any OpenAI-compatible endpoint |
| `PORT` | `8787` | |
| `ALLOW_ORIGIN` | `*` | The TV page's origin — `http://appassets.androidplatform.net` on AOSP; Tizen/webOS have a null origin, so they need `*` |
| `RELAY_TOKEN` | *(none)* | A shared secret the TV must send |

## What this is and isn't

It is a reference — about a hundred lines, no accounts, no per-user rate
limiting, no persistence. What it does do is the part that's easy to get wrong:
pass the request through unchanged so tool calling keeps working, stream the
response straight back so replies still arrive token by token, and never echo the
key or the upstream URL in an error.

`RELAY_TOKEN` is worth being honest about: it is one value shared by every TV, so
it limits casual abuse of an open relay and is **not** access control. A real
deployment issues per-user credentials from its own backend.

See [`docs/on-device-inference.md`](../../docs/on-device-inference.md) for the
other three ways to handle the key, and why they're weaker.
