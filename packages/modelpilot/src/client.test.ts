import { describe, it, expect, vi } from "vitest";
import { createModelPilotClient, readAnswer, redact } from "./client.js";
import { resolveModelPilotConfig, offReason } from "./config.js";
import { ModelPilotError } from "./errors.js";
import { sanitizeTelemetry } from "./telemetry.js";
import type { CompletionRequest } from "./task-mapper.js";

// Deliberately not key-shaped. A fixture that looks like a real credential
// trips secret scanners forever — in a file whose whole subject is credentials
// not leaking, that would be an unusually stupid way to fail CI.
const KEY = "NOT-A-REAL-CREDENTIAL-test-fixture-0000";

const request: CompletionRequest = {
  model: "auto",
  messages: [
    { role: "system", content: "Return a single JSON object." },
    { role: "user", content: "Goal: put the news on" },
  ],
  metadata: { quality_threshold: 0.85, latency_priority: 0.7, max_cost: 0.05 },
};

/** An OpenAI-shaped answer with the `modelpilot` extension the Worker adds. */
const completion = (content: unknown, meta: Record<string, unknown> = {}): unknown => ({
  id: "chatcmpl-1",
  object: "chat.completion",
  model: "openai-mini",
  choices: [{ index: 0, message: { role: "assistant", content: typeof content === "string" ? content : JSON.stringify(content) }, finish_reason: "stop" }],
  usage: { prompt_tokens: 220, completion_tokens: 48 },
  modelpilot: {
    request_id: "req-9", selected_model: "openai-mini", provider: "openai",
    routing_reason: "highest policy-adjusted score for structured_extraction",
    fallback_count: 0, actual_cost: 0.0021, baseline_cost: 0.0184,
    evaluation_status: "unverified",
    ...meta,
  },
});

const ok = (body: unknown, status = 200): typeof fetch =>
  (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;

function client(fetchImpl: typeof fetch, opts: { timeoutMs?: number } = {}) {
  return createModelPilotClient({
    baseUrl: "https://modelpilot.example/",
    apiKey: KEY,
    fetchImpl,
    ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
  });
}

describe("ModelPilotClient", () => {
  it("posts an OpenAI-compatible completion, with a bearer header", async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const fetchImpl = (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return new Response(JSON.stringify(completion({ action: "no_op" })));
    }) as unknown as typeof fetch;

    await client(fetchImpl).complete(request);

    // The path the service has, not the one the integration used to assume.
    expect(calls[0]?.url).toBe("https://modelpilot.example/v1/chat/completions");
    expect(calls[0]?.init.method).toBe("POST");
    const headers = calls[0]?.init.headers as Record<string, string>;
    expect(headers.authorization).toBe(`Bearer ${KEY}`);
    // The credential is a header and nothing else: not the URL, not the body.
    expect(calls[0]?.url).not.toContain(KEY);
    expect(String(calls[0]?.init.body)).not.toContain(KEY);
  });

  it("never asks for a stream, which the service rejects outright", async () => {
    const bodies: string[] = [];
    const fetchImpl = (async (_u: string, init: RequestInit) => {
      bodies.push(String(init.body));
      return new Response(JSON.stringify(completion({ action: "no_op" })));
    }) as unknown as typeof fetch;

    await client(fetchImpl).complete(request);
    expect(JSON.parse(bodies[0]!).stream).toBeUndefined();
  });

  it("reads the answer out of choices, and the routing metadata out of the extension", async () => {
    const plan = { action: "pause", target: "tv", parameters: {}, expected_state: {}, risk: "low" };
    const result = await client(ok(completion(plan))).complete(request);

    expect(result).toMatchObject({
      requestId: "req-9",
      selectedModel: "openai-mini",
      provider: "openai",
      fallbackCount: 0,
      actualCost: 0.0021,
      baselineCost: 0.0184,
      evaluationStatus: "unverified",
    });
    // A model returns a string. Unwrapping it is the parser's job, not this one's.
    expect(result.output).toBe(JSON.stringify(plan));
    expect(result.missing).toEqual([]);
  });

  it("does not treat the service's CST bookkeeping as a verdict on the answer", async () => {
    // `evaluation_status` is `unverified` on every completion the real service
    // returns — it only moves when a verifier posts to /v1/feedback. Reading it
    // as "unusable" is what made enforce mode refuse every answer it received.
    const result = await client(ok(completion({ action: "no_op" }))).complete(request);
    expect(result.evaluationStatus).toBe("unverified");
    // Recorded, and nothing about it stops the answer being read.
    expect(result.output).toContain("no_op");
  });

  it("prefers the routed model over the envelope's, and says which fields were absent", () => {
    const result = readAnswer({
      model: "gpt-5-mini",
      choices: [{ message: { role: "assistant", content: "{}" } }],
      modelpilot: { selected_model: "openai-mini" },
    }, 12);

    expect(result.selectedModel).toBe("openai-mini");
    expect(result.missing).toEqual(["request_id", "actual_cost"]);
  });

  it("hands the whole body to the parser when there is no completion in it", () => {
    // A deployment answering something else must produce a rejection that names
    // what arrived, not one that says `undefined`.
    const result = readAnswer({ unexpected: "shape" }, 5);
    expect(result.output).toEqual({ unexpected: "shape" });
  });

  it("classifies failures so the caller knows whether to fall back", async () => {
    const cases: [number, string, boolean][] = [
      [401, "unauthorized", true],
      [403, "unauthorized", true],
      [429, "rate_limited", true],
      [400, "rejected", true],
      [422, "rejected", true],
      [500, "server", true],
      [503, "server", true],
    ];
    for (const [status, kind, fallback] of cases) {
      const err = await client(ok({ error: { message: "nope" } }, status)).complete(request).catch((e) => e);
      expect(err, `${status}`).toBeInstanceOf(ModelPilotError);
      expect((err as ModelPilotError).kind, `${status}`).toBe(kind);
      expect((err as ModelPilotError).fallbackAllowed).toBe(fallback);
    }
  });

  it("carries the service's own reason, which is the difference between two very different problems", async () => {
    // 422 is what a tenant with no provider credential gets — or one whose
    // quality threshold excluded the entire catalogue. Without the message it
    // reads identically to "ModelPilot is broken".
    const err = await client(ok({
      error: { message: "No eligible configured model satisfies this request policy", type: "routing_error" },
    }, 422)).complete(request).catch((e) => e);
    expect((err as ModelPilotError).message).toMatch(/No eligible configured model/);

    const quota = await client(ok({
      error: { message: "Monthly request limit reached", type: "rate_limit_error" },
    }, 429)).complete(request).catch((e) => e);
    expect((quota as ModelPilotError).kind).toBe("rate_limited");
    expect((quota as ModelPilotError).message).toMatch(/Monthly request limit/);
  });

  it("gives up at its timeout, and says so", async () => {
    const hang = ((_u: string, init: RequestInit) => new Promise((_resolve, reject) => {
      init.signal?.addEventListener("abort", () => {
        const err = new Error("aborted");
        err.name = "AbortError";
        reject(err);
      });
    })) as unknown as typeof fetch;

    const err = await client(hang, { timeoutMs: 20 }).complete(request).catch((e) => e);
    expect((err as ModelPilotError).kind).toBe("timeout");
    expect((err as ModelPilotError).message).toMatch(/within 20ms/);
  });

  it("calls its own abort a timeout, whatever shape the runtime rejects with", async () => {
    // Node's fetch rejects with the *reason* passed to `abort()`, not with an
    // AbortError, so a name check alone reported every real timeout as
    // `unreachable`. The mock-server run said
    // "unreachable: could not reach ModelPilot: timeout" — two diagnoses in one
    // line — while this file's other timeout test passed, because it throws a
    // properly named AbortError of its own.
    const hang = ((_u: string, init: RequestInit) => new Promise((_resolve, reject) => {
      init.signal?.addEventListener("abort", () => {
        reject((init.signal as AbortSignal & { reason?: unknown }).reason);
      });
    })) as unknown as typeof fetch;

    const err = await client(hang, { timeoutMs: 20 }).complete(request).catch((e) => e);
    expect((err as ModelPilotError).kind).toBe("timeout");
    expect((err as ModelPilotError).message).toMatch(/within 20ms/);
  });

  it("honours a caller's AbortSignal, and distinguishes it from a timeout", async () => {
    const hang = ((_u: string, init: RequestInit) => new Promise((_resolve, reject) => {
      init.signal?.addEventListener("abort", () => {
        const err = new Error("aborted");
        err.name = "AbortError";
        reject(err);
      });
    })) as unknown as typeof fetch;

    const controller = new AbortController();
    const promise = client(hang, { timeoutMs: 5000 })
      .complete(request, { signal: controller.signal })
      .catch((e) => e);
    controller.abort();
    const err = await promise;
    expect((err as ModelPilotError).kind).toBe("timeout");
    expect((err as ModelPilotError).message).toMatch(/cancelled/);
  });

  it("treats an unreachable host as unreachable, not as a refusal", async () => {
    const dead = (async () => { throw new TypeError("Failed to fetch"); }) as unknown as typeof fetch;
    const err = await client(dead).complete(request).catch((e) => e);
    expect((err as ModelPilotError).kind).toBe("unreachable");
    expect((err as ModelPilotError).fallbackAllowed).toBe(true);
  });

  it("lists the catalogue from the path the service has", async () => {
    const urls: string[] = [];
    const fetchImpl = (async (url: string) => {
      urls.push(url);
      return new Response(JSON.stringify({ object: "list", data: [{ id: "openai-mini" }] }));
    }) as unknown as typeof fetch;

    await client(fetchImpl).listModels();
    expect(urls).toEqual(["https://modelpilot.example/v1/models"]);
  });

  it("posts a verdict to the endpoint that keeps ModelPilot's own metric honest", async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const fetchImpl = (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return new Response(JSON.stringify({ status: "accepted" }));
    }) as unknown as typeof fetch;

    await client(fetchImpl).reportOutcome("req-9", { success: true, comment: "locally verified" });

    expect(calls[0]?.url).toBe("https://modelpilot.example/v1/feedback");
    expect(JSON.parse(String(calls[0]?.init.body))).toEqual({
      request_id: "req-9", success: true, comment: "locally verified",
    });
  });

  it("omits a score rather than inventing one", async () => {
    // The endpoint takes an optional score. A made-up number is noise in
    // somebody else's denominator, so nothing sends one by default.
    const bodies: string[] = [];
    const fetchImpl = (async (_u: string, init: RequestInit) => {
      bodies.push(String(init.body));
      return new Response(JSON.stringify({ status: "accepted" }));
    }) as unknown as typeof fetch;

    await client(fetchImpl).reportOutcome("req-9", { success: false });
    expect(JSON.parse(bodies[0]!)).toEqual({ request_id: "req-9", success: false });
  });

  it("attributes the call to an install, without identifying hardware", async () => {
    const calls = [];
    const fetchImpl = (async (_u, init) => {
      calls.push(init);
      return new Response(JSON.stringify(completion({ action: "no_op" })));
    }) as unknown as typeof fetch;

    await createModelPilotClient({
      baseUrl: "https://modelpilot.example", apiKey: KEY, fetchImpl,
      identity: { installId: "hth_0123456789abcdef0123456789abcdef", runtimeVersion: "0.1.0", mode: "shadow" },
    }).complete(request);

    const headers = calls[0]?.headers as Record<string, string>;
    // Enough for a backend to count televisions, versions and modes. Nothing
    // about the household, and no second endpoint to do it through.
    expect(headers["x-hearth-install"]).toBe("hth_0123456789abcdef0123456789abcdef");
    expect(headers["x-hearth-runtime"]).toBe("0.1.0");
    expect(headers["x-hearth-mode"]).toBe("shadow");
  });

  it("sends no attribution headers when the host configured no identity", async () => {
    const calls = [];
    const fetchImpl = (async (_u, init) => {
      calls.push(init);
      return new Response(JSON.stringify(completion({ action: "no_op" })));
    }) as unknown as typeof fetch;

    await client(fetchImpl).complete(request);
    const headers = calls[0]?.headers as Record<string, string>;
    expect(headers["x-hearth-install"]).toBeUndefined();
  });
});

describe("the API key never reaches a log", () => {
  it("is absent from every error message and thrown value", async () => {
    const failures = [
      ok({ error: { message: "bad" } }, 401),
      ok({ error: { message: "bad" } }, 500),
      (async () => { throw new TypeError(`Failed to fetch https://modelpilot.example?token=${KEY}`); }) as unknown as typeof fetch,
      // And a server that echoes the credential back in its own error body.
      ok({ error: { message: `rejected token ${KEY}` } }, 400),
    ];
    for (const fetchImpl of failures) {
      const err = await client(fetchImpl).complete(request).catch((e) => e);
      const dump = `${(err as Error).message} ${(err as Error).stack ?? ""} ${JSON.stringify(err, Object.getOwnPropertyNames(err))}`;
      expect(dump).not.toContain(KEY);
    }
  });

  it("is stripped from text that arrived from somewhere else", () => {
    // Both halves matter: the key we hold, and the credential-shaped thing we
    // were never given and so cannot match exactly.
    expect(redact(`fetch failed for https://x?token=${KEY}`, KEY)).not.toContain(KEY);
    // Shape-y enough to exercise the pattern, short and obviously synthetic so
    // no scanner mistakes it for the thing it is imitating.
    expect(redact("Authorization: Bearer xx-EXAMPLE-other-credential")).not.toContain("EXAMPLE-other-credential");
    expect(redact('{"api_key":"abcdefghijklmnop"}')).not.toContain("abcdefghijklmnop");
    // And it must not mangle an ordinary message.
    expect(redact("Failed to fetch")).toBe("Failed to fetch");
  });

  it("is absent from anything the client writes to the console", async () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const info = vi.spyOn(console, "info").mockImplementation(() => {});

    await client(ok(completion({ action: "no_op" }))).complete(request);
    await client(ok({}, 500)).complete(request).catch(() => {});

    // The client logs nothing at all — the host owns output. That is the easiest
    // version of this guarantee to keep, so it is the one implemented.
    for (const s of [spy, warn, error, info]) {
      for (const call of s.mock.calls) {
        expect(JSON.stringify(call)).not.toContain(KEY);
      }
    }
    expect(spy).not.toHaveBeenCalled();
    vi.restoreAllMocks();
  });

  it("is absent from a telemetry record, along with prompts and room state", () => {
    const record = sanitizeTelemetry({
      local_workflow_id: "wf-1", mode: "shadow", task_type: "input_switched", status: "ok",
      // A caller trying to be helpful, and a sink that must not receive it.
      ...({ api_key: KEY, prompt: "the whole instruction", room_state: { people: 3 } } as unknown as object),
    });
    const dump = JSON.stringify(record);
    expect(dump).not.toContain(KEY);
    expect(dump).not.toContain("the whole instruction");
    expect(dump).not.toContain("people");
    // Dropping a field silently would be its own bug.
    expect(dump).toContain("dropped_fields");
  });
});

describe("configuration", () => {
  it("never reads the key from the launch URL", () => {
    const config = resolveModelPilotConfig({
      search: `?modelpilot=enforce&key=${KEY}&modelpilotKey=${KEY}`,
      env: {},
      globals: {},
    });
    // No credential means no calls, whatever the URL asked for.
    expect(config.apiKey).toBeUndefined();
    expect(config.mode).toBe("off");
    expect(JSON.stringify(config)).not.toContain(KEY);
  });

  it("takes the key from a host global or the environment", () => {
    expect(resolveModelPilotConfig({ globals: { __MODELPILOT_API_KEY__: KEY } }).apiKey).toBe(KEY);
    expect(resolveModelPilotConfig({ env: { MODELPILOT_API_KEY: KEY } }).apiKey).toBe(KEY);
  });

  it("defaults to shadow, and to the production endpoint", () => {
    const config = resolveModelPilotConfig({ env: { MODELPILOT_API_KEY: KEY } });
    expect(config.mode).toBe("shadow");
    expect(config.baseUrl).toBe("https://modelpilot.andycywu.workers.dev");
    expect(config.timeoutMs).toBe(5000);
    expect(config.maxTaskBudget).toBe(0.05);
  });

  it("forces off when there is no key, and says why", () => {
    expect(resolveModelPilotConfig({ env: { MODELPILOT_MODE: "enforce" } }).mode).toBe("off");
    expect(offReason({ env: { MODELPILOT_MODE: "enforce" } })).toMatch(/no MODELPILOT_API_KEY/);
  });

  it("lets a URL flag pick the mode, for bring-up without a rebuild", () => {
    const config = resolveModelPilotConfig({
      search: "?modelpilot=enforce", globals: { __MODELPILOT_API_KEY__: KEY },
    });
    expect(config).toMatchObject({ mode: "enforce", source: "query" });
  });
});
