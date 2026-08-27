import { describe, it, expect, vi } from "vitest";
import { createModelPilotClient, isVerified, readTaskResult, redact } from "./client.js";
import { resolveModelPilotConfig, offReason } from "./config.js";
import { ModelPilotError } from "./errors.js";
import { sanitizeTelemetry } from "./telemetry.js";
import type { TaskRequest } from "./task-mapper.js";

// Deliberately not key-shaped. A fixture that looks like a real credential
// trips secret scanners forever — in a file whose whole subject is credentials
// not leaking, that would be an unusually stupid way to fail CI.
const KEY = "NOT-A-REAL-CREDENTIAL-test-fixture-0000";

const request: TaskRequest = {
  task: { instruction: "plan a step", context: "{}" },
  strategy: "plan_execute_verify",
  requirements: {
    intelligence: "reasoning", capabilities: ["planning"], qualitySla: 0.9,
    maxCost: 0.05, maxLatencyMs: 5000, privacy: "no_training", risk: "medium",
    approvalMode: "high_risk",
    dataPolicy: {
      sensitivity: "confidential", retentionRequirement: "zero",
      trainingUse: "prohibited", toolEgress: "denied", humanReview: "allowed",
    },
  },
  economics: { maxTaskBudget: 0.05, currency: "USD" },
  verification: { type: "json_schema", requiredKeys: ["action"] },
};

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
  it("posts the task to the documented path with a bearer header", async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const fetchImpl = (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return new Response(JSON.stringify({ taskId: "t1", status: "verified", output: { action: "no_op" } }));
    }) as unknown as typeof fetch;

    await client(fetchImpl).executeVerifiedTask(request);

    expect(calls[0]?.url).toBe("https://modelpilot.example/v1/tasks/execute");
    expect(calls[0]?.init.method).toBe("POST");
    const headers = calls[0]?.init.headers as Record<string, string>;
    expect(headers.authorization).toBe(`Bearer ${KEY}`);
    // The credential is a header and nothing else: not the URL, not the body.
    expect(calls[0]?.url).not.toContain(KEY);
    expect(String(calls[0]?.init.body)).not.toContain(KEY);
  });

  it("reads ids, status and cost without inventing a schema", async () => {
    const result = await client(ok({
      task_id: "t-9", trajectory_id: "tr-9", status: "verified",
      actual_cost: 0.012, output: { action: "pause" },
    })).executeVerifiedTask(request);

    expect(result).toMatchObject({ taskId: "t-9", trajectoryId: "tr-9", status: "verified", actualCost: 0.012 });
    expect(result.missing).toEqual([]);
    expect(isVerified(result)).toBe(true);
  });

  it("says which fields a response did not carry, rather than defaulting them", () => {
    const result = readTaskResult({ output: { action: "no_op" } }, 12);
    expect(result.missing).toEqual(["taskId", "trajectoryId", "status", "actualCost"]);
    // Unknown is not "verified". A service that said nothing has not told us it
    // verified anything, and that difference stops a device operation.
    expect(isVerified(result)).toBe(false);
  });

  it("classifies failures so the caller knows whether to fall back", async () => {
    const cases: [number, string, boolean][] = [
      [401, "unauthorized", true],
      [403, "unauthorized", true],
      [400, "rejected", true],
      [500, "server", true],
      [503, "server", true],
    ];
    for (const [status, kind, fallback] of cases) {
      const err = await client(ok({ error: "nope" }, status)).executeVerifiedTask(request).catch((e) => e);
      expect(err, `${status}`).toBeInstanceOf(ModelPilotError);
      expect((err as ModelPilotError).kind, `${status}`).toBe(kind);
      expect((err as ModelPilotError).fallbackAllowed).toBe(fallback);
    }
  });

  it("gives up at its timeout, and says so", async () => {
    const hang = ((_u: string, init: RequestInit) => new Promise((_resolve, reject) => {
      init.signal?.addEventListener("abort", () => {
        const err = new Error("aborted");
        err.name = "AbortError";
        reject(err);
      });
    })) as unknown as typeof fetch;

    const err = await client(hang, { timeoutMs: 20 }).executeVerifiedTask(request).catch((e) => e);
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
      .executeVerifiedTask(request, { signal: controller.signal })
      .catch((e) => e);
    controller.abort();
    const err = await promise;
    expect((err as ModelPilotError).kind).toBe("timeout");
    expect((err as ModelPilotError).message).toMatch(/cancelled/);
  });

  it("treats an unreachable host as unreachable, not as a refusal", async () => {
    const dead = (async () => { throw new TypeError("Failed to fetch"); }) as unknown as typeof fetch;
    const err = await client(dead).executeVerifiedTask(request).catch((e) => e);
    expect((err as ModelPilotError).kind).toBe("unreachable");
    expect((err as ModelPilotError).fallbackAllowed).toBe(true);
  });

  it("fetches evidence and trajectory from the documented paths", async () => {
    const urls: string[] = [];
    const fetchImpl = (async (url: string) => {
      urls.push(url);
      return new Response(JSON.stringify({ ok: true }));
    }) as unknown as typeof fetch;

    const c = client(fetchImpl);
    await c.getTaskEvidence("t 1/2");
    await c.getTaskTrajectory("tr-1");
    expect(urls).toEqual([
      "https://modelpilot.example/v1/tasks/t%201%2F2",
      "https://modelpilot.example/v1/trajectories/tr-1",
    ]);
  });

  it("attributes the call to an install, without identifying hardware", async () => {
    const calls = [];
    const fetchImpl = (async (_u, init) => {
      calls.push(init);
      return new Response(JSON.stringify({ taskId: "t", status: "verified", output: { action: "no_op" } }));
    }) as unknown as typeof fetch;

    await createModelPilotClient({
      baseUrl: "https://modelpilot.example", apiKey: KEY, fetchImpl,
      identity: { installId: "hth_0123456789abcdef0123456789abcdef", runtimeVersion: "0.1.0", mode: "shadow" },
    }).executeVerifiedTask(request);

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
      return new Response(JSON.stringify({ taskId: "t", status: "verified", output: { action: "no_op" } }));
    }) as unknown as typeof fetch;

    await client(fetchImpl).executeVerifiedTask(request);
    const headers = calls[0]?.headers as Record<string, string>;
    expect(headers["x-hearth-install"]).toBeUndefined();
  });

  it("marks a decision call as a decision, without a second guessed endpoint", async () => {
    const bodies: string[] = [];
    const fetchImpl = (async (_u: string, init: RequestInit) => {
      bodies.push(String(init.body));
      return new Response(JSON.stringify({ taskId: "t", status: "verified", output: { action: "no_op" } }));
    }) as unknown as typeof fetch;

    await client(fetchImpl).decideExecution(request);
    expect(JSON.parse(bodies[0]!).strategy).toBe("decide");
  });
});

describe("the API key never reaches a log", () => {
  it("is absent from every error message and thrown value", async () => {
    const failures = [
      ok({ error: "bad" }, 401),
      ok({ error: "bad" }, 500),
      (async () => { throw new TypeError(`Failed to fetch https://modelpilot.example?token=${KEY}`); }) as unknown as typeof fetch,
    ];
    for (const fetchImpl of failures) {
      const err = await client(fetchImpl).executeVerifiedTask(request).catch((e) => e);
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

    await client(ok({ taskId: "t", status: "verified", output: { action: "no_op" } })).executeVerifiedTask(request);
    await client(ok({}, 500)).executeVerifiedTask(request).catch(() => {});

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
