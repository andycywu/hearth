import type {
  LlmClient, CompletionRequest, CompletionResult, ChatMessage, ToolCall, StreamHandlers,
} from "@tv-ai-agent/core";

/**
 * A deterministic, offline "brain" that maps a handful of natural-language
 * patterns to tool calls — no model or network required. It lets the whole
 * agent + tools + streaming + UI stack run end-to-end (in a browser dev harness
 * or in CI) with zero setup, and gives contributors a working demo before any
 * real LLM is wired up.
 *
 * It is NOT an LLM: it only understands the patterns below. Point the
 * OpenAI-compatible client at a real endpoint for open-ended language.
 */
export interface ScriptedClientOptions {
  id?: string;
}

export function createScriptedClient(opts: ScriptedClientOptions = {}): LlmClient {
  const id = opts.id ?? "scripted:offline";

  function decide(messages: ChatMessage[]): CompletionResult {
    const last = messages[messages.length - 1];
    if (!last) return finalText("Hi! Try: \"set volume to 30\" or \"open Netflix\".");

    if (last.role === "tool") return followUp(last, messages);
    if (last.role === "user") return fromUser(last.content);
    return finalText("Okay.");
  }

  return {
    id,
    async complete(req: CompletionRequest): Promise<CompletionResult> {
      return decide(req.messages);
    },
    async completeStream(req: CompletionRequest, handlers: StreamHandlers): Promise<CompletionResult> {
      const r = decide(req.messages);
      if (!r.wantsToolCalls && r.message.content) {
        for (const chunk of chunkText(r.message.content)) handlers.onContentDelta?.(chunk);
      }
      return r;
    },
  };
}

// --- intent parsing from the user's message ---
function fromUser(raw: string): CompletionResult {
  const text = raw.toLowerCase().trim();

  const vol = text.match(/(?:volume|音量).*?(\d{1,3})|(\d{1,3}).*?(?:volume|音量)/);
  if (vol) {
    const level = Number(vol[1] ?? vol[2]);
    return toolCall("set_volume", { level });
  }
  if (/\b(volume|音量)\b\s*\??$/.test(text) || /what.*volume/.test(text)) {
    return toolCall("get_volume", {});
  }
  if (/\bunmute\b|取消靜音|開聲音/.test(text)) return toolCall("set_mute", { mute: false });
  if (/\bmute\b|靜音|關聲音/.test(text)) return toolCall("set_mute", { mute: true });

  const hdmi = text.match(/hdmi\s*([1-4])/);
  if (hdmi) return toolCall("set_input_source", { source: `hdmi${hdmi[1]}` });
  if (/\b(tv|電視)\b.*(input|source|訊號源)|switch.*tv/.test(text)) {
    return toolCall("set_input_source", { source: "tv" });
  }

  if (/list.*apps|what apps|有哪些app|應用列表/.test(text)) return toolCall("list_apps", {});

  const open = text.match(/(?:open|launch|play|watch|開啟?|啟動|播放)\s+(.+)/);
  if (open) {
    const query = (open[1] ?? "").replace(/[。.!?！？]+$/, "").trim();
    return toolCall("search_app_by_name", { query });
  }

  return finalText("I can set volume, mute, switch input, or open an app. Try \"open Netflix\".");
}

// --- decide what to do after a tool result comes back ---
function followUp(toolMsg: ChatMessage, messages: ChatMessage[]): CompletionResult {
  const data = safeParse(toolMsg.content);

  // An app search returned candidates → launch the first match.
  if (Array.isArray(data)) {
    if (data.length === 0) return finalText("I couldn't find that app.");
    const first = data[0] as { id?: string; name?: string };
    if (first?.id) {
      // Only auto-launch if the user actually asked to open something.
      const askedToOpen = messages.some(
        (m) => m.role === "user" && /open|launch|play|watch|開|啟動|播放/i.test(m.content),
      );
      if (askedToOpen) return toolCall("launch_app", { appId: first.id });
      return finalText(`Found: ${data.map((a: any) => a.name).join(", ")}.`);
    }
  }

  if (data && typeof data === "object") {
    const o = data as Record<string, unknown>;
    // Order matters: mutating tools return { ok: true, ... }; read tools return
    // only the queried field. Check error/ok before the read-only fields so a
    // successful action reports "Done." rather than echoing its readback.
    if (o.error) return finalText(`That didn't work: ${String(o.error)}`);
    if (o.ok === true) return finalText("Done.");
    if (typeof o.volume === "number") return finalText(`The volume is ${o.volume}.`);
    if (typeof o.muted === "boolean") return finalText(o.muted ? "Muted." : "Unmuted.");
    if (typeof o.source === "string") return finalText(`Input is now ${o.source}.`);
  }

  return finalText("Done.");
}

// --- helpers ---
function toolCall(name: string, args: Record<string, unknown>): CompletionResult {
  const call: ToolCall = { id: `s_${name}_${Date.now()}`, name, args };
  return { message: { role: "assistant", content: "", toolCalls: [call] }, wantsToolCalls: true };
}
function finalText(content: string): CompletionResult {
  return { message: { role: "assistant", content }, wantsToolCalls: false };
}
function chunkText(s: string): string[] {
  // Emit word-sized chunks so the UI shows a streaming effect.
  return s.match(/\S+\s*/g) ?? [s];
}
function safeParse(s: string): unknown {
  try { return JSON.parse(s); } catch { return s; }
}
