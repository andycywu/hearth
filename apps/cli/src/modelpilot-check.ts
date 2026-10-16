/**
 * `hearth modelpilot check` — does this Hearth work against a real ModelPilot, end to end?
 *
 * `status` asks whether a service is there and takes the key. This asks the questions a Hearth actually depends on:
 * a plain completion, a streamed one, a tool call, the tool's result sent back, a streamed tool call — and then the
 * same loop through Hearth's *own* client, because a raw request proving the service can do it says nothing about
 * whether this code can read the answer. The service's own tests cover format conversion and validation; what only
 * a real network, a real provider and this client can show is here.
 *
 * Every row is `verified` (what was expected came back), `failed`, or `unverified` (the call worked but the thing
 * asked about was not shown). Nothing is printed that came from the key; response bodies are cut and redacted.
 */
import { createOpenAiCompatibleClient } from "@hearthkit/llm-connectors";
import type { ChatMessage, LlmClient, ToolSpec } from "@hearthkit/core";

export type CheckVerdict = "verified" | "failed" | "unverified";

export interface CheckRow {
  name: string;
  verdict: CheckVerdict;
  detail: string;
  ms?: number;
}

export interface CheckOptions {
  baseUrl: string;
  apiKey: string;
  /** The model asked for; `openai-mini` unless the caller is checking another provider. */
  model?: string;
  /** `reasoning_effort` sent on the raw requests. `low` is accepted by the hosted catalogue; `undefined` omits it. */
  reasoningEffort?: string;
  /** Repeat the plain and streamed completions this many times for success rate and latency. 0 = skip. */
  runs?: number;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  now?: () => number;
  /** Called as each row is finished, so a slow check shows progress. */
  onRow?: (row: CheckRow) => void;
}

const TOOL = {
  type: "function",
  function: {
    name: "get_device_status",
    description: "Read the current Hearth device status",
    parameters: {
      type: "object",
      properties: { device: { type: "string", enum: ["hearth"] } },
      required: ["device"],
      additionalProperties: false,
    },
    strict: true,
  },
};

/** The same tool as Hearth's own tool registry would describe it. */
const TOOL_SPEC: ToolSpec = {
  name: "get_device_status",
  description: "Read the current Hearth device status",
  parameters: { device: { type: "string", description: "which device", required: true, enum: ["hearth"] } },
} as unknown as ToolSpec;

/** Names of what a tool call carries besides the three fields every client reads — so a report can say it was there and sent back. */
function extrasNote(call: Record<string, any>): string {
  const extra = Object.keys(call).filter((k) => !["id", "type", "function", "index"].includes(k));
  const inFn = Object.keys(call.function ?? {}).filter((k) => !["name", "arguments"].includes(k));
  const all = [...extra, ...inFn.map((k) => `function.${k}`)];
  return all.length ? `; also carries ${all.join(", ")} (sent back on turn 2)` : "";
}

const STATUS_RESULT = { online: true, cpu_temperature_c: 48.2, memory_free_mb: 312 };
const ASK = "Check the current Hearth device status.";

export async function runChecks(o: CheckOptions): Promise<CheckRow[]> {
  const doFetch = o.fetchImpl ?? ((...a: Parameters<typeof fetch>) => fetch(...a));
  const now = o.now ?? Date.now;
  const base = o.baseUrl.replace(/\/+$/, "");
  const model = o.model ?? "openai-mini";
  const timeout = o.timeoutMs ?? 60_000;
  const rows: CheckRow[] = [];
  const add = (row: CheckRow): CheckRow => { rows.push(row); o.onRow?.(row); return row; };
  const redact = (text: string): string => text.split(o.apiKey).join("***").slice(0, 240);
  const effort = o.reasoningEffort ? { reasoning_effort: o.reasoningEffort } : {};
  const headers = { authorization: `Bearer ${o.apiKey}`, "content-type": "application/json" };

  async function post(body: unknown): Promise<{ status: number; ms: number; text: string; json?: any }> {
    const started = now();
    const res = await doFetch(`${base}/v1/chat/completions`, {
      method: "POST", headers, body: JSON.stringify(body), signal: AbortSignal.timeout(timeout),
    });
    const text = await res.text();
    let json: any;
    try { json = JSON.parse(text); } catch { /* the caller reports a body that is not JSON */ }
    return { status: res.status, ms: now() - started, text, json };
  }

  /** A streamed completion, read the way an SSE client must: partial lines, blank lines, `[DONE]`. */
  async function stream(body: Record<string, unknown>): Promise<{
    status: number; ms: number; firstMs?: number; chunks: any[]; done: boolean; text: string; error?: string;
  }> {
    const started = now();
    const res = await doFetch(`${base}/v1/chat/completions`, {
      method: "POST", headers, body: JSON.stringify({ ...body, stream: true, stream_options: { include_usage: true } }),
      signal: AbortSignal.timeout(timeout),
    });
    if (!res.ok || !res.body) return { status: res.status, ms: now() - started, chunks: [], done: false, text: await res.text() };
    const chunks: any[] = [];
    let done = false, firstMs: number | undefined, pending = "", text = "";
    const decoder = new TextDecoder();
    for await (const part of res.body as unknown as AsyncIterable<Uint8Array>) {
      pending += decoder.decode(part, { stream: true });
      let nl: number;
      while ((nl = pending.indexOf("\n")) >= 0) {
        const line = pending.slice(0, nl).replace(/\r$/, "");
        pending = pending.slice(nl + 1);
        if (!line.startsWith("data:")) continue;          // blank separators, comments, event names
        const data = line.slice(5).trim();
        if (data === "[DONE]") { done = true; continue; }
        try {
          const chunk = JSON.parse(data);
          chunks.push(chunk);
          const delta = chunk.choices?.[0]?.delta;
          if (firstMs === undefined && (delta?.content || delta?.tool_calls)) firstMs = now() - started;
          if (typeof delta?.content === "string") text += delta.content;
        } catch { return { status: res.status, ms: now() - started, chunks, done, text, error: "a data line was not JSON" }; }
      }
    }
    return { status: res.status, ms: now() - started, ...(firstMs !== undefined ? { firstMs } : {}), chunks, done, text };
  }

  const guard = async (name: string, fn: () => Promise<Omit<CheckRow, "name">>): Promise<CheckRow> => {
    try { return add({ name, ...(await fn()) }); }
    catch (err) {
      const e = err as { name?: string; cause?: { code?: string } };
      return add({ name, verdict: "failed", detail: e.name === "TimeoutError" ? "timed out" : redact(e.cause?.code ?? (err instanceof Error ? err.message : String(err))) });
    }
  };
  const bad = (status: number, text: string): Omit<CheckRow, "name"> => ({ verdict: "failed", detail: `HTTP ${status}: ${redact(text)}` });

  // 1 ---- the catalogue
  let catalogue: string[] = [];
  await guard("1 /v1/models", async () => {
    const started = now();
    const res = await doFetch(`${base}/v1/models`, { headers: { authorization: `Bearer ${o.apiKey}` }, signal: AbortSignal.timeout(timeout) });
    const text = await res.text();
    if (!res.ok) return bad(res.status, text);
    let list: any[] = [];
    try { const j = JSON.parse(text); list = j.data ?? j; } catch { return { verdict: "failed", detail: "body is not JSON" }; }
    const ids = list.map((m) => m.id);
    catalogue = ids;
    const auto = model === "auto";
    const target = auto ? list.find((m) => m.availability?.routable !== false) : list.find((m) => m.id === model);
    const routable = target?.availability?.routable;
    return {
      verdict: target ? (routable === false ? "unverified" : "verified") : "failed",
      detail: `${ids.join(", ")}${target ? (auto ? `; auto can route to ${target.id}` : `; ${model} routable=${routable === undefined ? "not reported" : routable}`) : auto ? "; nothing is routable" : `; ${model} is not in the catalogue`}`,
      ms: now() - started,
    };
  });

  // 2 ---- a plain completion
  await guard("2 chat, not streamed", async () => {
    const r = await post({ model, ...effort, messages: [{ role: "user", content: "Reply with exactly: Hearth connected" }] });
    if (r.status !== 200) return bad(r.status, r.text);
    const content = String(r.json?.choices?.[0]?.message?.content ?? "");
    const mp = r.json?.modelpilot ?? {};
    const problems = [
      !/Hearth connected/i.test(content) && `reply was "${redact(content)}"`,
      (model === "auto" ? !catalogue.includes(mp.selected_model) : mp.selected_model !== model) && `selected_model=${mp.selected_model}`,
      !r.json?.usage && "no usage",
      mp.actual_cost === undefined && "no actual_cost",
      !mp.request_id && "no request_id",
    ].filter(Boolean);
    return problems.length
      ? { verdict: "failed", detail: problems.join("; "), ms: r.ms }
      : { verdict: "verified", detail: `"${content.trim()}" via ${mp.selected_model}, ${r.json.usage.total_tokens} tokens, cost ${mp.actual_cost}`, ms: r.ms };
  });

  // 3 ---- SSE. The prompt asks for a long-ish answer on purpose: a one-sentence reply reaches the client in a burst
  // whether the service streams or buffers, so it cannot show which.
  await guard("3 chat, streamed (SSE)", async () => {
    const s = await stream({ model, ...effort, messages: [{ role: "user", content: "Count from 1 to 40 separated by commas, and write nothing else." }] });
    if (s.status !== 200) return bad(s.status, s.text);
    if (s.error) return { verdict: "failed", detail: s.error, ms: s.ms };
    const finish = s.chunks.map((c) => c.choices?.[0]?.finish_reason).find(Boolean);
    const usage = s.chunks.some((c) => c.usage);
    const textChunks = s.chunks.filter((c) => c.choices?.[0]?.delta?.content).length;
    const problems = [
      textChunks < 2 && `text arrived in ${textChunks} piece(s), not incrementally`,
      finish !== "stop" && `finish_reason=${finish}`,
      !usage && "no usage chunk",
      !s.done && "no [DONE]",
    ].filter(Boolean);
    const arrival = s.firstMs !== undefined && s.firstMs < s.ms * 0.8 ? "" : "; first text arrived with the end — not shown to be incremental";
    return problems.length
      ? { verdict: "failed", detail: problems.join("; "), ms: s.ms }
      : { verdict: arrival ? "unverified" : "verified", detail: `${textChunks} text chunks, first at ${s.firstMs} ms of ${s.ms} ms, finish=stop, usage, [DONE]${arrival}`, ms: s.ms };
  });

  // 4 ---- tool call, first turn
  let toolCall: { id: string; name: string; arguments: string } | undefined;
  /** The call exactly as the service sent it — including anything provider-specific it attached (Gemini's `provider_metadata`). */
  let rawCall: Record<string, unknown> | undefined;
  await guard("4 tool call, first turn", async () => {
    const r = await post({ model, ...effort, tool_choice: "required", tools: [TOOL], messages: [{ role: "user", content: ASK }] });
    if (r.status !== 200) return bad(r.status, r.text);
    const choice = r.json?.choices?.[0];
    const call = choice?.message?.tool_calls?.[0];
    if (!call) return { verdict: "failed", detail: `no tool_calls (finish_reason=${choice?.finish_reason})`, ms: r.ms };
    toolCall = { id: call.id, name: call.function?.name, arguments: call.function?.arguments };
    rawCall = call;
    let args: any; try { args = JSON.parse(toolCall.arguments); } catch { /* reported below */ }
    const problems = [
      choice.finish_reason !== "tool_calls" && `finish_reason=${choice.finish_reason}`,
      !toolCall.id && "no tool_call id",
      toolCall.name !== "get_device_status" && `name=${toolCall.name}`,
      args?.device !== "hearth" && `arguments=${redact(String(toolCall.arguments))}`,
      choice.message.content !== null && choice.message.content !== undefined && choice.message.content !== "" && "content is not null",
    ].filter(Boolean);
    return problems.length ? { verdict: "failed", detail: problems.join("; "), ms: r.ms } : { verdict: "verified", detail: `${toolCall.name}(${toolCall.arguments}) id=${toolCall.id}${extrasNote(call)}`, ms: r.ms };
  });

  // 5 ---- the tool's result, second turn
  await guard("5 tool result, second turn", async () => {
    if (!toolCall) return { verdict: "unverified", detail: "skipped: the first turn gave no tool call to answer" };
    const r = await post({
      model, ...effort, tools: [TOOL],
      messages: [
        { role: "user", content: ASK },
        // The call goes back as received, not rebuilt from id/name/arguments: a provider's own metadata rides on it.
        { role: "assistant", content: null, tool_calls: [rawCall ?? { id: toolCall.id, type: "function", function: { name: toolCall.name, arguments: toolCall.arguments } }] },
        { role: "tool", tool_call_id: toolCall.id, content: JSON.stringify(STATUS_RESULT) },
      ],
    });
    if (r.status !== 200) return bad(r.status, r.text);
    const choice = r.json?.choices?.[0];
    const content = String(choice?.message?.content ?? "");
    const again = choice?.message?.tool_calls?.length;
    const problems = [
      again && "called the tool again instead of answering",
      !/48/.test(content) && `the answer does not use the temperature: "${redact(content)}"`,
      !/online|on-line|up|running/i.test(content) && "the answer does not say it is online",
    ].filter(Boolean);
    return problems.length ? { verdict: "failed", detail: problems.join("; "), ms: r.ms } : { verdict: "verified", detail: `"${redact(content.trim())}"`, ms: r.ms };
  });

  // 6 ---- streamed tool call, merged by index
  await guard("6 tool call, streamed", async () => {
    const s = await stream({ model, ...effort, tool_choice: "required", tools: [TOOL], messages: [{ role: "user", content: ASK }] });
    if (s.status !== 200) return bad(s.status, s.text);
    if (s.error) return { verdict: "failed", detail: s.error, ms: s.ms };
    const calls = new Map<number, { id?: string; name?: string; args: string }>();
    let pieces = 0;
    for (const c of s.chunks) for (const t of c.choices?.[0]?.delta?.tool_calls ?? []) {
      const cur = calls.get(t.index ?? 0) ?? { args: "" };
      if (t.id) cur.id = t.id;
      if (t.function?.name) cur.name = t.function.name;
      if (typeof t.function?.arguments === "string") { cur.args += t.function.arguments; pieces++; }
      calls.set(t.index ?? 0, cur);
    }
    const first = calls.get(0);
    const finish = s.chunks.map((c) => c.choices?.[0]?.finish_reason).find(Boolean);
    let args: any; try { args = JSON.parse(first?.args ?? ""); } catch { /* reported */ }
    const problems = [
      !first && "no tool_calls deltas",
      first && !first.id && "no id",
      first && first.name !== "get_device_status" && `name=${first.name}`,
      first && args?.device !== "hearth" && `merged arguments are not the expected JSON: ${redact(first.args)}`,
      finish !== "tool_calls" && `finish_reason=${finish}`,
    ].filter(Boolean);
    return problems.length ? { verdict: "failed", detail: problems.join("; "), ms: s.ms } : { verdict: "verified", detail: `${pieces} argument piece(s) merged by index into ${first!.args}, finish=tool_calls`, ms: s.ms };
  });

  // 7, 8 ---- the loop through Hearth's own client: call → run it here → send the result back
  const hearthClient = (): LlmClient => createOpenAiCompatibleClient({ baseUrl: `${base}/v1`, model, apiKey: o.apiKey, retries: 0, ...(o.fetchImpl ? { fetchImpl: o.fetchImpl } : {}) });
  for (const streamed of [false, true]) {
    await guard(`${streamed ? 8 : 7} Hearth's client: tool loop, ${streamed ? "streamed" : "not streamed"}`, async () => {
      const client = hearthClient();
      const ask = (req: { messages: ChatMessage[]; tools: ToolSpec[] }) =>
        streamed && client.completeStream ? client.completeStream(req, {}) : client.complete(req);
      const started = now();
      const user: ChatMessage = { role: "user", content: ASK };
      const first = await ask({ messages: [user], tools: [TOOL_SPEC] });
      const call = first.message.toolCalls?.[0];
      if (!first.wantsToolCalls || !call) return { verdict: "failed", detail: `the model did not call the tool (said: "${redact(first.message.content)}")`, ms: now() - started };
      if (call.name !== "get_device_status" || (call.args as { device?: string }).device !== "hearth") {
        return { verdict: "failed", detail: `the call was not understood: ${call.name}(${redact(JSON.stringify(call.args))})`, ms: now() - started };
      }
      // "Executed locally": the device's answer, as this box would read it back.
      const second = await ask({
        messages: [user, first.message, { role: "tool", toolCallId: call.id, content: JSON.stringify(STATUS_RESULT) }],
        tools: [TOOL_SPEC],
      });
      const problems = [
        second.wantsToolCalls && "called the tool again instead of answering",
        !/48/.test(second.message.content) && `the answer does not use the result: "${redact(second.message.content)}"`,
      ].filter(Boolean);
      return problems.length
        ? { verdict: "failed", detail: problems.join("; "), ms: now() - started }
        : { verdict: "verified", detail: `call ${call.id}${call.providerData ? ` (kept ${Object.keys(call.providerData).join(", ")} and sent it back)` : ""} → run here → "${redact(second.message.content.trim())}"`, ms: now() - started };
    });
  }

  // 9 ---- Hearth gives up on a stream (a person talks over the answer); the next request must still work
  const cancelRow = await guard("9 cancel a stream half way, then ask again", async () => {
    const controller = new AbortController();
    const started = now();
    const res = await doFetch(`${base}/v1/chat/completions`, {
      method: "POST", headers,
      body: JSON.stringify({ model, ...effort, stream: true, messages: [{ role: "user", content: "Count from 1 to 40 separated by commas, and write nothing else." }] }),
      signal: AbortSignal.any([controller.signal, AbortSignal.timeout(timeout)]),
    });
    if (!res.ok || !res.body) {
      const text = await res.text();
      return res.status === 422 ? { verdict: "unverified", detail: `${model} does not stream (${res.status}); nothing to cancel` } : bad(res.status, text);
    }
    // Read the first bytes, then walk away — as a person talking over the answer would. Aborting rejects the pending
    // read, which is the point and not an error.
    const reader = res.body.getReader();
    const first = await reader.read();
    const received = first.value?.byteLength ?? 0;
    controller.abort();
    await reader.cancel().catch(() => {});
    const after = await post({ model, ...effort, messages: [{ role: "user", content: "Reply with the single word ok." }] });
    return after.status === 200
      ? { verdict: "verified", detail: `cancelled after ${received} bytes; the next request answered 200`, ms: now() - started }
      : { ...bad(after.status, after.text), ms: now() - started };
  });
  void cancelRow;

  // 10, 11 ---- repetition: success rate and latency, the numbers a household would feel
  const runs = o.runs ?? 0;
  if (runs > 0) {
    const stats = (name: string, samples: Array<{ ok: boolean; ms: number; firstMs?: number }>): CheckRow => {
      const ok = samples.filter((s) => s.ok);
      const sorted = ok.map((s) => s.ms).sort((a, b) => a - b);
      const median = sorted.length ? sorted[Math.floor(sorted.length / 2)]! : undefined;
      const firsts = ok.map((s) => s.firstMs).filter((x): x is number => x !== undefined).sort((a, b) => a - b);
      const detail = `${ok.length}/${samples.length} ok` + (median !== undefined
        ? `; median ${median} ms, slowest ${sorted[sorted.length - 1]} ms${firsts.length ? `; first text median ${firsts[Math.floor(firsts.length / 2)]} ms` : ""}`
        : "");
      return add({ name, verdict: ok.length === samples.length ? "verified" : ok.length ? "unverified" : "failed", detail });
    };
    const plain: Array<{ ok: boolean; ms: number }> = [];
    const streamedRuns: Array<{ ok: boolean; ms: number; firstMs?: number }> = [];
    for (let i = 0; i < runs; i++) {
      try { const r = await post({ model, ...effort, messages: [{ role: "user", content: "Reply with the single word ok." }] }); plain.push({ ok: r.status === 200, ms: r.ms }); }
      catch { plain.push({ ok: false, ms: 0 }); }
      try {
        const s = await stream({ model, ...effort, messages: [{ role: "user", content: "Reply with the single word ok." }] });
        streamedRuns.push({ ok: s.status === 200 && s.done && !s.error, ms: s.ms, ...(s.firstMs !== undefined ? { firstMs: s.firstMs } : {}) });
      } catch { streamedRuns.push({ ok: false, ms: 0 }); }
    }
    stats(`10 ${runs}× chat, not streamed`, plain);
    stats(`11 ${runs}× chat, streamed`, streamedRuns);
  }
  return rows;
}

export function formatChecks(rows: readonly CheckRow[], target: string, baseUrl: string): string {
  const failed = rows.filter((r) => r.verdict === "failed").length;
  const unverified = rows.filter((r) => r.verdict === "unverified").length;
  const lines = rows.map((r) => `  ${r.verdict.padEnd(10)} ${r.name}${r.ms !== undefined ? ` · ${r.ms} ms` : ""}\n  ${" ".repeat(10)} ${r.detail}`);
  return `ModelPilot check — ${target} (${baseUrl})\n${lines.join("\n")}\n\n${rows.length - failed - unverified} verified, ${unverified} unverified, ${failed} failed\n`;
}

export function checkExitCode(rows: readonly CheckRow[]): number {
  return rows.some((r) => r.verdict === "failed") ? 1 : 0;
}
