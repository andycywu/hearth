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

  function decide(req: CompletionRequest): CompletionResult {
    const messages = req.messages;
    // Which tools this agent actually registered. Custom skills (docs/skills.md)
    // are opt-in, so a pattern must never propose a tool that isn't there.
    const available = new Set((req.tools ?? []).map((s) => s.name));
    const last = messages[messages.length - 1];
    const lang = detectLang(lastUserText(messages) || (last?.role === "user" ? last.content : ""));
    if (!last) return finalText(t("greeting", lang));

    if (last.role === "tool") return followUp(last, messages, lang);
    if (last.role === "user") return fromUser(last.content, messages, lang, available);
    return finalText(t("ok", lang));
  }

  return {
    id,
    async complete(req: CompletionRequest): Promise<CompletionResult> {
      return decide(req);
    },
    async completeStream(req: CompletionRequest, handlers: StreamHandlers): Promise<CompletionResult> {
      const r = decide(req);
      if (!r.wantsToolCalls && r.message.content) {
        for (const chunk of chunkText(r.message.content)) handlers.onContentDelta?.(chunk);
      }
      return r;
    },
  };
}

// --- intent parsing from the user's message ---
/**
 * Match an intent, then refuse to propose a tool this device doesn't have.
 *
 * The check is here, once, rather than in each of the ten branches below: a
 * branch is easy to add and the guard is easy to forget, and forgetting it
 * produces a confusing answer rather than an obvious bug. On the Tizen emulator
 * "set volume to 30" came back "That didn't work: Unknown tool: set_volume" when
 * the truth was that the TV has no audio API — the agent had already withdrawn
 * the tool and only the brain hadn't noticed.
 */
function fromUser(
  raw: string,
  messages: ChatMessage[],
  lang: Lang,
  available: Set<string>,
): CompletionResult {
  const result = matchIntent(raw, messages, lang, available);
  const proposed = result.message.toolCalls?.[0]?.name;
  if (proposed && !available.has(proposed)) {
    return finalText(tf("unsupported", lang, `${proposed} isn't available on this device`));
  }
  return result;
}

function matchIntent(
  raw: string,
  messages: ChatMessage[],
  lang: Lang,
  available: Set<string>,
): CompletionResult {
  const text = raw.toLowerCase().trim();

  // Custom skill demo: only offered when the host registered the tool.
  if (available.has("get_weather")) {
    const city = matchWeatherCity(raw);
    if (city) return toolCall("get_weather", { city });
  }
  // Same question, answered by the *manifest* version of the skill. A manifest
  // makes one request, so it can't geocode first — it needs coordinates, and
  // offline that means a short table. A real model knows them; this is the
  // seam where the scripted brain shows its limits, not the manifest's.
  if (available.has("get_current_weather")) {
    const city = matchWeatherCity(raw);
    const at = city && DEMO_CITIES[city.toLowerCase()];
    if (at) return toolCall("get_current_weather", { latitude: at[0], longitude: at[1] });
    if (city) return finalText(t("noCoords", lang));
  }

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
    /現在.*音量/.test(text) ||
    /音量.*(いくつ|どのくらい|何|は\s*\?)/.test(text)
  ) {
    return toolCall("get_volume", {});
  }
  // Asking *about* mute, before either command — "靜音了嗎" contains the mute
  // word and was being obeyed as an order to mute, so a question about the state
  // changed it. English escapes that by accident (`\bmute\b` doesn't match
  // "muted"); Chinese and Japanese have no word boundary to save them.
  if (
    available.has("get_mute") && (
      /\b(is|are)\b.*\bmuted\b|\bmuted\b\s*\?/.test(text) ||
      /(靜音|静音).*(嗎|吗|沒有|没有|了没|\?|？)/.test(text) ||
      /有沒有(靜音|静音)/.test(text) ||
      /(ミュート|消音).*(ですか|してる|されて|\?|？)/.test(text)
    )
  ) {
    return toolCall("get_mute", {});
  }
  // Unmute first: "ミュート解除" and "取消靜音" both contain the mute word.
  if (/\bunmute\b|取消靜音|開聲音|(?:ミュート|消音).*解除|解除.*(?:ミュート|消音)/.test(text)) {
    return toolCall("set_mute", { mute: false });
  }
  if (/\bmute\b|靜音|關聲音|ミュート|消音/.test(text)) return toolCall("set_mute", { mute: true });

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
  // Japanese puts the verb last: "Netflix を開いて".
  const openJa = text.match(/(.+?)\s*を\s*(?:開いて|開く|起動|再生|見せて|つけて)/);
  if (openJa?.[1]) return toolCall("search_app_by_name", { query: openJa[1].trim() });

  return finalText(helpText(lang, available));
}

// --- decide what to do after a tool result comes back ---
function followUp(toolMsg: ChatMessage, messages: ChatMessage[], lang: Lang): CompletionResult {
  const raw = safeParse(toolMsg.content);

  // TV tools answer in an envelope. Which tool produced it decides what to say:
  // a reader's payload is the answer, a mutator's readback is just confirmation.
  //
  // This used to be inferred from the payload's shape — mutators happened to
  // include `ok: true` and readers didn't — which stopped working the moment
  // every result carried `ok`. The call id was always the honest way to tell,
  // and it is what a real client uses to pair a result with its request.
  if (raw && typeof raw === "object" && "ok" in (raw as object)) {
    const env = raw as { ok: boolean; data?: unknown; error?: string; message?: string };
    if (env.ok === false) {
      // `unsupported` is not a failure to apologise for and not worth retrying:
      // this TV genuinely cannot do it, and saying so is the useful answer.
      const reason = env.message ?? String(env.error);
      return finalText(env.error === "unsupported"
        ? tf("unsupported", lang, reason)
        : tf("failed", lang, reason));
    }
    const tool = toolNameFor(toolMsg, messages);
    if (env.data === undefined || !isReadTool(tool)) return finalText(t("done", lang));
    return interpret(env.data, messages, lang, tool);
  }
  // A skill's own tool, which is outside the TV envelope.
  return interpret(raw, messages, lang);
}

/** The tool that produced this result, paired back through the call id. */
function toolNameFor(toolMsg: ChatMessage, messages: ChatMessage[]): string | undefined {
  if (!toolMsg.toolCallId) return undefined;
  for (let i = messages.length - 1; i >= 0; i--) {
    const call = messages[i]?.toolCalls?.find((tc) => tc.id === toolMsg.toolCallId);
    if (call) return call.name;
  }
  return undefined;
}

/** Readers answer a question; everything else just confirms it happened. */
function isReadTool(name: string | undefined): boolean {
  if (!name) return true;      // unknown: fall through to the shape checks
  return name.startsWith("get_") || name === "list_apps" || name === "search_app_by_name";
}

/** Turn a tool's payload into the next move. */
function interpret(data: unknown, messages: ChatMessage[], lang: Lang, tool?: string): CompletionResult {

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
      return finalText(tf("found", lang, names));
    }
  }

  if (data && typeof data === "object") {
    const o = data as Record<string, unknown>;
    // A skill's own tool, which is not in the TV envelope.
    if (o.error) return finalText(tf("failed", lang, String(o.error)));
    // Custom skill result (docs/skills.md example): { city, tempC, summary }.
    if (typeof o.tempC === "number" && typeof o.summary === "string") {
      const condition = lang === "en" ? o.summary.toLowerCase() : o.summary;
      return finalText(tf("weather", lang, String(o.city), o.tempC, condition));
    }
    if (typeof o.volume === "number") {
      // Relative-volume flow: the get_volume readback came back — apply ±step.
      const lastUser = lastUserText(messages);
      if (isLouder(lastUser)) return toolCall("set_volume", { level: Math.min(100, o.volume + 10) });
      if (isQuieter(lastUser)) return toolCall("set_volume", { level: Math.max(0, o.volume - 10) });
      return finalText(tf("volumeIs", lang, o.volume));
    }
    if (typeof o.muted === "boolean") {
      // Answering a question, not reporting an action — see the strings above.
      if (tool === "get_mute") return finalText(t(o.muted ? "isMuted" : "isNotMuted", lang));
      return finalText(o.muted ? t("muted", lang) : t("unmuted", lang));
    }
    if (typeof o.source === "string") return finalText(tf("inputNow", lang, o.source));
  }

  return finalText(t("done", lang));
}

// --- tiny i18n for the offline brain's canned replies ---
export type Lang = "zh" | "ja" | "en";

/**
 * Which language to answer in. Japanese is checked before Chinese: ja text mixes
 * kana with Han characters, so a kana hit is decisive, whereas Han alone is not.
 * Han-only Japanese (e.g. 音量) is indistinguishable from Chinese by script and
 * falls through to zh — acceptable for canned replies; a real model reads the
 * whole sentence.
 */
function detectLang(s: string): Lang {
  if (/[぀-ゟ゠-ヿ]/.test(s)) return "ja";   // hiragana / katakana
  return /[一-鿿]/.test(s) ? "zh" : "en";
}
const STRINGS = {
  greeting: {
    en: 'Hi! Try: "set volume to 30" or "open Netflix".',
    zh: '嗨!試試:「音量調到 30」或「開啟 Netflix」。',
    ja: 'こんにちは!「音量を 30 にして」や「Netflix を開いて」と言ってみてください。',
  },
  ok: { en: "Okay.", zh: "好的。", ja: "はい。" },
  done: { en: "Done.", zh: "完成。", ja: "完了しました。" },
  notFound: { en: "I couldn't find that app.", zh: "找不到那個應用程式。", ja: "そのアプリが見つかりません。" },
  whatOpen: { en: "What should I open?", zh: "你想開啟什麼?", ja: "何を開きますか?" },
  noCoords: {
    en: "The offline brain only knows coordinates for a few demo cities. Point at a real model to ask about anywhere.",
    zh: "離線模式只認得幾個示範城市的座標。接上真實模型就能問任何地方。",
    ja: "オフラインでは数都市の座標しか持っていません。実際のモデルに接続すればどこでも尋ねられます。",
  },
  // Two pairs, because these answer two different things. After `set_mute` the
  // reply reports an action; after `get_mute` it answers a question, and
  // "Unmuted." there reads as "I have just unmuted it" — the agent claiming to
  // have done something it was only asked about.
  muted: { en: "Muted.", zh: "已靜音。", ja: "ミュートしました。" },
  unmuted: { en: "Unmuted.", zh: "已取消靜音。", ja: "ミュートを解除しました。" },
  isMuted: { en: "Yes, the TV is muted.", zh: "是的，目前是靜音。", ja: "はい、ミュート中です。" },
  isNotMuted: { en: "No, the TV isn't muted.", zh: "沒有，目前不是靜音。", ja: "いいえ、ミュートされていません。" },
  help: {
    en: 'I can set volume, mute, switch input, or open an app. Try "open Netflix".',
    zh: '我可以調整音量、靜音、切換輸入源或開啟應用程式。試試「開啟 Netflix」。',
    ja: '音量調整、ミュート、入力切替、アプリの起動ができます。「Netflix を開いて」とどうぞ。',
  },
  nothing: {
    en: "This device hasn't given me anything I can control.",
    zh: "這台裝置沒有提供我可以控制的功能。",
    ja: "この機器から操作できる機能が提供されていません。",
  },
};

/**
 * The abilities to name, from the tools that are actually registered.
 *
 * The fixed sentence above listed volume and mute unconditionally, so on the
 * Tizen emulator — which has no audio API, and where the agent had already
 * withdrawn those tools — "what can you do?" still answered "I can set volume,
 * mute, …" and then declined. The agent's tool list was honest and its own
 * description of itself was not.
 *
 * Composed rather than looked up per combination: there are four groups here and
 * a table of every subset is sixteen strings per language to keep in step.
 */
const ABILITIES: Array<{ tool: string; label: Record<Lang, string> }> = [
  { tool: "set_volume", label: { en: "set volume", zh: "調整音量", ja: "音量調整" } },
  { tool: "set_mute", label: { en: "mute", zh: "靜音", ja: "ミュート" } },
  { tool: "set_input_source", label: { en: "switch input", zh: "切換輸入源", ja: "入力切替" } },
  { tool: "launch_app", label: { en: "open an app", zh: "開啟應用程式", ja: "アプリの起動" } },
];

function helpText(lang: Lang, available: Set<string>): string {
  const labels = ABILITIES.filter((a) => available.has(a.tool)).map((a) => a.label[lang]);
  if (!labels.length) return t("nothing", lang);
  // Unchanged wording when everything is present, so the full-capability case
  // reads exactly as it always did.
  if (labels.length === ABILITIES.length) return t("help", lang);
  const canOpen = available.has("launch_app");
  if (lang === "en") {
    const list = labels.length === 1 ? labels[0]
      : `${labels.slice(0, -1).join(", ")} or ${labels[labels.length - 1]}`;
    return `I can ${list}.${canOpen ? ' Try "open Netflix".' : ""}`;
  }
  if (lang === "ja") {
    return `${labels.join("、")}ができます。${canOpen ? "「Netflix を開いて」とどうぞ。" : ""}`;
  }
  return `我可以${labels.join("、")}。${canOpen ? "試試「開啟 Netflix」。" : ""}`;
}
function t(key: keyof typeof STRINGS, lang: Lang): string {
  return STRINGS[key][lang];
}

/**
 * Replies that interpolate a value. Kept as `{0}`-style templates so every
 * locale for a phrase sits on one line and adding a language stays a data edit.
 */
const PHRASES = {
  found: { en: "Found: {0}.", zh: "找到:{0}。", ja: "見つかりました:{0}。" },
  failed: { en: "That didn't work: {0}", zh: "執行失敗:{0}", ja: "実行できませんでした:{0}" },
  // Distinct from `failed`: nothing went wrong, this TV just can't do it — so
  // the phrasing shouldn't suggest retrying.
  unsupported: {
    en: "This TV can't do that: {0}",
    zh: "這台電視不支援:{0}",
    ja: "このテレビでは対応していません:{0}",
  },
  volumeIs: { en: "The volume is {0}.", zh: "目前音量是 {0}。", ja: "現在の音量は {0} です。" },
  inputNow: { en: "Input is now {0}.", zh: "輸入源已切換為 {0}。", ja: "入力を {0} に切り替えました。" },
  // {0} place, {1} temperature, {2} condition — from the example skill.
  weather: { en: "{0}: {1}°C, {2}.", zh: "{0}目前 {1}°C,{2}。", ja: "{0}は {1}°C、{2}。" },
};
function tf(key: keyof typeof PHRASES, lang: Lang, ...args: Array<string | number>): string {
  return PHRASES[key][lang].replace(/\{(\d)\}/g, (_, i: string) => String(args[Number(i)] ?? ""));
}

/**
 * Pull a place name out of a weather question, or undefined if this isn't one.
 * Deliberately narrow: the offline brain is a pattern matcher, so it would
 * rather fall through to the help text than send a garbage city to a skill.
 */
function matchWeatherCity(raw: string): string | undefined {
  const s = raw.trim();
  if (!/weather|forecast|天氣|氣溫|天気|気温/i.test(s)) return undefined;

  const en = s.match(/(?:weather|forecast|temperature)\s*(?:like\s*)?(?:in|for|at)\s+([^?.!,]+)/i);
  if (en?.[1]) return acceptCity(en[1]);

  // "台北天氣如何?" / "台北の天気" — the place sits before the keyword in both
  // Chinese and Japanese; drop a trailing 的/の particle.
  const cjk = s.match(/([^\s,，、。！？?的の]{2,12})(?:的|の)?\s*(?:天氣|氣溫|天気|気温)/);
  if (cjk?.[1]) return acceptCity(cjk[1]);

  return undefined;
}
/**
 * Coordinates for the cities the offline demo talks about, so the manifest
 * weather skill has something to be called with. Not a geocoder — deliberately
 * small, because the offline brain is a demo prop, not a product.
 */
const DEMO_CITIES: Record<string, [number, number]> = {
  taipei: [25.03, 121.57], 台北: [25.03, 121.57], 台北市: [25.03, 121.57],
  hsinchu: [24.81, 120.97], 新竹: [24.81, 120.97],
  kaohsiung: [22.62, 120.31], 高雄: [22.62, 120.31],
  tokyo: [35.68, 139.69], 東京: [35.68, 139.69],
  london: [51.51, -0.13], "new york": [40.71, -74.01],
  singapore: [1.35, 103.82], seoul: [37.57, 126.98], 首爾: [37.57, 126.98],
};

/** Reject time words and other non-places the loose patterns can capture. */
const NOT_A_CITY = new Set([
  "today", "tomorrow", "tonight", "now", "outside", "here", "there",
  "現在", "今天", "明天", "今晚", "外面", "這裡", "那裡",
  "今日", "明日", "今夜", "ここ", "そこ", "外",
]);
function acceptCity(captured: string): string | undefined {
  const city = captured.replace(/[。.!?！？,，]+$/, "").trim();
  return city && !NOT_A_CITY.has(city.toLowerCase()) ? city : undefined;
}

function isLouder(s: string): boolean {
  return /louder|turn it up|volume up|大聲|\bup\b.*volume|音量.*(調高|大き?|上げ)/.test(s);
}
function isQuieter(s: string): boolean {
  return /quieter|softer|turn it down|volume down|小聲|音量.*(調低|小さ?|下げ)/.test(s);
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
      const data = unwrapEnvelope(safeParse(m.content));
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

/** The payload inside a TV tool's envelope, or the value itself if it isn't one. */
function unwrapEnvelope(value: unknown): unknown {
  if (value && typeof value === "object" && (value as { ok?: unknown }).ok === true) {
    return (value as { data?: unknown }).data;
  }
  return value;
}
