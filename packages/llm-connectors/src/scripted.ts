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
    const lang = detectLang(lastUserText(messages) || (last?.role === "user" ? last.content : ""));
    if (!last) return finalText(t("greeting", lang));

    if (last.role === "tool") return followUp(last, messages, lang);
    if (last.role === "user") return fromUser(last.content, messages, lang);
    return finalText(t("ok", lang));
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
function fromUser(raw: string, messages: ChatMessage[], lang: Lang): CompletionResult {
  const text = raw.toLowerCase().trim();

  // Coreference: "launch it again", "open that", "再開一次" → relaunch the last
  // app, resolved from conversation history. Only fires when no app name is
  // given, so "open YouTube again" still opens YouTube.
  const repeat =
    /^(?:again|do it again|再一?次|重(?:開|新開啟?))\s*$/.test(text) ||
    /^(?:open|launch|play|開啟?|啟動|播放)\s+(?:it|that|它|那個)(?:\s+again)?\s*$/.test(text);
  if (repeat) {
    const id = lastLaunchedAppId(messages);
    if (id) return toolCall("launch_app", { appId: id });
    return finalText(t("whatOpen", lang));
  }

  const vol = text.match(/(?:volume|音量).*?(\d{1,3})|(\d{1,3}).*?(?:volume|音量)/);
  if (vol) {
    const level = Number(vol[1] ?? vol[2]);
    return toolCall("set_volume", { level });
  }
  // Relative volume: read the current level first, then adjust in followUp.
  if (isLouder(text) || isQuieter(text)) return toolCall("get_volume", {});
  if (
    /\b(volume|音量)\b\s*\??$/.test(text) ||
    /what.*volume/.test(text) ||
    /音量.*(多少|幾|是多少)/.test(text) ||
    /現在.*音量/.test(text)
  ) {
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

  return finalText(t("help", lang));
}

// --- decide what to do after a tool result comes back ---
function followUp(toolMsg: ChatMessage, messages: ChatMessage[], lang: Lang): CompletionResult {
  const data = safeParse(toolMsg.content);

  // An app search returned candidates → launch the first match.
  if (Array.isArray(data)) {
    if (data.length === 0) return finalText(t("notFound", lang));
    const first = data[0] as { id?: string; name?: string };
    if (first?.id) {
      // Only auto-launch if the user actually asked to open something.
      const askedToOpen = messages.some(
        (m) => m.role === "user" && /open|launch|play|watch|開|啟動|播放/i.test(m.content),
      );
      if (askedToOpen) return toolCall("launch_app", { appId: first.id });
      const names = data.map((a: any) => a.name).join(", ");
      return finalText(lang === "zh" ? `找到:${names}。` : `Found: ${names}.`);
    }
  }

  if (data && typeof data === "object") {
    const o = data as Record<string, unknown>;
    // Order matters: mutating tools return { ok: true, ... }; read tools return
    // only the queried field. Check error/ok before the read-only fields so a
    // successful action reports "Done." rather than echoing its readback.
    if (o.error) return finalText(lang === "zh" ? `執行失敗:${String(o.error)}` : `That didn't work: ${String(o.error)}`);
    if (o.ok === true) return finalText(t("done", lang));
    if (typeof o.volume === "number") {
      // Relative-volume flow: the get_volume readback came back — apply ±step.
      const lastUser = lastUserText(messages);
      if (isLouder(lastUser)) return toolCall("set_volume", { level: Math.min(100, o.volume + 10) });
      if (isQuieter(lastUser)) return toolCall("set_volume", { level: Math.max(0, o.volume - 10) });
      return finalText(lang === "zh" ? `目前音量是 ${o.volume}。` : `The volume is ${o.volume}.`);
    }
    if (typeof o.muted === "boolean") return finalText(o.muted ? t("muted", lang) : t("unmuted", lang));
    if (typeof o.source === "string") return finalText(lang === "zh" ? `輸入源已切換為 ${o.source}。` : `Input is now ${o.source}.`);
  }

  return finalText(t("done", lang));
}

// --- tiny i18n for the offline brain's canned replies ---
type Lang = "zh" | "en";
function detectLang(s: string): Lang {
  return /[一-鿿]/.test(s) ? "zh" : "en";
}
const STRINGS = {
  greeting: { en: 'Hi! Try: "set volume to 30" or "open Netflix".', zh: '嗨!試試:「音量調到 30」或「開啟 Netflix」。' },
  ok: { en: "Okay.", zh: "好的。" },
  done: { en: "Done.", zh: "完成。" },
  notFound: { en: "I couldn't find that app.", zh: "找不到那個應用程式。" },
  whatOpen: { en: "What should I open?", zh: "你想開啟什麼?" },
  muted: { en: "Muted.", zh: "已靜音。" },
  unmuted: { en: "Unmuted.", zh: "已取消靜音。" },
  help: {
    en: 'I can set volume, mute, switch input, or open an app. Try "open Netflix".',
    zh: '我可以調整音量、靜音、切換輸入源或開啟應用程式。試試「開啟 Netflix」。',
  },
};
function t(key: keyof typeof STRINGS, lang: Lang): string {
  return STRINGS[key][lang];
}

function isLouder(s: string): boolean {
  return /louder|turn it up|volume up|大聲|\bup\b.*volume|音量.*(調高|大)/.test(s);
}
function isQuieter(s: string): boolean {
  return /quieter|softer|turn it down|volume down|小聲|音量.*(調低|小)/.test(s);
}
function lastUserText(messages: ChatMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m && m.role === "user") return m.content.toLowerCase();
  }
  return "";
}
/** Resolve the most recently launched app id from prior tool calls / search results. */
function lastLaunchedAppId(messages: ChatMessage[]): string | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (!m) continue;
    // A prior assistant turn that launched an app.
    const launch = m.toolCalls?.find((tc) => tc.name === "launch_app");
    if (launch && typeof (launch.args as any).appId === "string") return (launch.args as any).appId;
    // Or the most recent app-search result.
    if (m.role === "tool") {
      const data = safeParse(m.content);
      if (Array.isArray(data) && data[0] && typeof (data[0] as any).id === "string") {
        return (data[0] as any).id;
      }
    }
  }
  return undefined;
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
