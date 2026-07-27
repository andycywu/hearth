# Dev Harness

Run the whole agent stack in a browser — **no TV and no API key required**. Uses
the web/mock adapter, the UI overlay, and an offline scripted brain.

```bash
pnpm dev          # builds, bundles, serves at http://localhost:5173
```

Then type commands: `set volume to 30`, `mute`, `open Netflix`,
`launch it again`, `make it louder`, `what's the volume?`, `switch to hdmi1`. The
overlay shows streamed replies and tool activity; a transcript logs the session
and the status line shows the mock TV state changing.

Open `http://localhost:5173/?diag` to run the capability self-diagnostic (the
same probe the device builds use) instead of the chat UI.

## Point it at a real LLM
Set globals before the bundle loads (e.g. in the browser console or by editing
`index.html`):

```js
window.__AGENT_LLM_BASE_URL__ = "http://127.0.0.1:8080/v1"; // any OpenAI-compatible server
window.__AGENT_LLM_MODEL__ = "your-model";
```

This is the same connector the Tizen/AOSP builds use, so behaviour matches the
device — point it at a localhost llama.cpp/Ollama/vLLM for a fully on-device run.
