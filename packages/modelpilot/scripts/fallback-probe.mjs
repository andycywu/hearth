/**
 * Force candidate fallback against the live service, without touching anything.
 *
 * The router builds [chosen, ...alternatives] and walks it, moving to the next
 * candidate only when a failure is *retryable* (429/5xx/network) or the
 * credential is "not configured". A 401 from a bad key breaks the loop instead,
 * so an invalid credential cannot exercise this.
 *
 * What can: the service's own `mock` provider throws a retryable error when the
 * last message contains `[fail:<model id>]`. So make mock-fast rank first —
 * profile the task as summarization (its strength) and drop the quality
 * threshold below its 0.8 — then make it fail. The next candidate is the real
 * provider, and fallback_count should come back 1.
 */
const base = process.env.MODELPILOT_BASE_URL ?? "https://modelpilot.andycywu.workers.dev";

async function call(label, body) {
  const started = Date.now();
  const res = await fetch(`${base}/v1/chat/completions`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${process.env.MODELPILOT_API_KEY}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
  const json = await res.json();
  const ms = Date.now() - started;
  if (!res.ok) {
    console.log(`${label}: HTTP ${res.status} (${ms}ms) — ${json.error?.message}`);
    return;
  }
  const mp = json.modelpilot ?? {};
  console.log(
    `${label}: ${res.status} (${ms}ms) selected=${mp.selected_model} `
    + `fallback_count=${mp.fallback_count} cost=$${mp.actual_cost}`,
  );
  console.log(`         reason: ${mp.routing_reason}`);
  console.log(`         content: ${JSON.stringify(json.choices?.[0]?.message?.content)?.slice(0, 120)}`);
}

// 1. Baseline: does mock-fast actually rank first under these knobs?
await call("rank check ", {
  model: "auto",
  messages: [{ role: "user", content: "Summarize the room state in one line." }],
  metadata: { quality_threshold: 0.7, latency_priority: 0.9, max_cost: 0.05 },
});

// 2. Same shape, but the first candidate is told to fail retryably.
await call("fallback   ", {
  model: "auto",
  messages: [{ role: "user", content: "Summarize the room state in one line. [fail:mock-fast]" }],
  metadata: { quality_threshold: 0.7, latency_priority: 0.9, max_cost: 0.05 },
});

// 3. And what a hard failure of the only candidate looks like: pinned to mock,
//    told to fail, nothing else eligible.
await call("no recovery", {
  model: "mock-fast",
  messages: [{ role: "user", content: "Summarize this. [fail:mock-fast]" }],
  metadata: { quality_threshold: 0.7, latency_priority: 0.9, max_cost: 0.05 },
});
