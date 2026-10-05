/**
 * Command-line parsing, kept separate from anything that touches a terminal so
 * the rules can be tested without spawning a process.
 */

export interface CliOptions {
  /** Commands to run and exit. Empty means interactive. */
  commands: string[];
  platform: "mock" | "linux";
  baseUrl?: string;
  /** Always set: the OpenAI-compatible client requires one. */
  model: string;
  apiKey?: string;
  /** Don't print the tool trace to stderr. */
  quiet: boolean;
  /** Answer confirmation prompts without asking. Needed when stdin is a pipe. */
  yes: boolean;
  json: boolean;
  help: boolean;
  version: boolean;
  /**
   * Listen on a microphone as well as on stdin. Linux only: it is the adapter
   * that owns `arecord`, and the mock has no ears.
   */
  voice: boolean;
  /**
   * Where recorded audio is turned into text — an OpenAI-compatible
   * `/audio/transcriptions`, cloud or a whisper server on the LAN.
   *
   * Without it `--voice` can still speak but not listen, and says so at startup
   * rather than sitting silently in front of a microphone it cannot understand.
   */
  asrBaseUrl?: string;
  asrModel?: string;
  /** The APA102 status ring on a ReSpeaker array, if this box has one. */
  leds: boolean;
  /**
   * `--wake <word>`: act only on an utterance that contains this word.
   *
   * This is an attention word, not a wake-word detector: the microphone still
   * records in fixed windows and every window still goes to the transcriber.
   * What changes is that "pass the salt" in the same room is heard, transcribed,
   * and then dropped — only "hearth, turn it down" reaches the agent. The
   * adapter declines to imitate a real detector (see adapter-linux/voice.ts);
   * this is the honest thing that can be done with the transcript instead.
   */
  wakeWord?: string;
  /**
   * `hearth report`: probe this box and whatever it can reach, run the four
   * scenarios, and print a Hearth Report section instead of starting the agent.
   * The `commands` list is empty when this is set — the word is consumed.
   */
  report: boolean;
  /** `--out <file>`: write the report there as well as (or instead of) stdout. */
  out?: string;
  /** `--writes`: let the capability probe change things (a volume round-trip). */
  writes: boolean;
  /** `--intents "a;b"`: scenarios to put through goal mode instead of the default four. */
  intents?: string[];
  /** `--room demo|empty|stored`: how the room is seeded before discovery. */
  room: "demo" | "empty" | "stored";
  /** `--cec <device>`: the CEC adapter to try on linux. `--no-cec` leaves the bus alone. */
  cec: string | false;
  /**
   * `hearth setup`: look at this box, write `~/.config/hearth/config.json` so
   * the next `hearth` needs no flags, and say what the box can do.
   */
  setup: boolean;
  /** `--no-save`: setup prints what it would write and writes nothing. */
  save: boolean;
  /** Anything wrong with the invocation, in the order found. */
  errors: string[];
  /** Non-fatal things worth saying once. */
  warnings: string[];
}

const PLATFORMS = ["mock", "linux"] as const;
const DEFAULT_MODEL = "local-tv-agent";

/**
 * Parse argv (without `node` and the script path) and the environment.
 *
 * Flags beat environment variables, which beat defaults — the usual order, and
 * the one that makes `TV_AGENT_LLM=… hearth --llm other` do what it looks like.
 *
 * The API key is the exception: it is read **only** from the environment. On a
 * shared machine `ps` shows every process's arguments, so a key passed as a flag
 * is a key handed to anyone with a shell. This is the same reasoning that took
 * it out of the TV's launch URL; `--key` is accepted and rejected loudly rather
 * than silently ignored, because failing quietly here would be worse.
 */
export function parseArgs(argv: string[], env: Record<string, string | undefined> = {}): CliOptions {
  const opts: CliOptions = {
    commands: [],
    platform: "mock",
    // Matches the device hosts' default, so the same server config works for
    // both. A local server usually ignores it; a cloud one requires it.
    model: DEFAULT_MODEL,
    quiet: false,
    yes: false,
    voice: false,
    leds: false,
    report: false,
    setup: false,
    save: true,
    writes: false,
    room: "stored",
    cec: "/dev/cec0",
    json: false,
    help: false,
    version: false,
    errors: [],
    warnings: [],
  };

  const envPlatform = env.TV_PLATFORM;
  if (envPlatform) {
    if ((PLATFORMS as readonly string[]).includes(envPlatform)) {
      opts.platform = envPlatform as CliOptions["platform"];
    } else {
      opts.errors.push(`TV_PLATFORM must be one of ${PLATFORMS.join(", ")} (got "${envPlatform}")`);
    }
  }
  if (env.TV_AGENT_LLM) opts.baseUrl = env.TV_AGENT_LLM;
  if (env.TV_AGENT_MODEL) opts.model = env.TV_AGENT_MODEL;
  if (env.TV_AGENT_API_KEY) opts.apiKey = env.TV_AGENT_API_KEY;
  if (env.TV_AGENT_ASR) opts.asrBaseUrl = expandAsr(env.TV_AGENT_ASR);
  if (env.TV_AGENT_ASR_MODEL) opts.asrModel = env.TV_AGENT_ASR_MODEL;
  // These three exist so `hearth setup` can write a config that stands in for
  // flags (see config.ts); they are read from the environment the same way.
  if (env.HEARTH_CEC) opts.cec = env.HEARTH_CEC === "off" ? false : env.HEARTH_CEC;
  if (env.HEARTH_VOICE === "1") opts.voice = true;
  if (env.HEARTH_LEDS === "1") opts.leds = true;
  if (env.HEARTH_WAKE) opts.wakeWord = env.HEARTH_WAKE;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    const takeValue = (name: string): string | undefined => {
      // `--llm=x` and `--llm x` both, because both are muscle memory.
      const inline = arg.indexOf("=");
      if (inline !== -1) return arg.slice(inline + 1);
      const next = argv[++i];
      if (next === undefined) opts.errors.push(`${name} needs a value`);
      return next;
    };
    const name = arg.split("=")[0]!;

    switch (name) {
      case "-h": case "--help": opts.help = true; break;
      case "-v": case "--version": opts.version = true; break;
      case "-q": case "--quiet": opts.quiet = true; break;
      case "-y": case "--yes": opts.yes = true; break;
      case "--json": opts.json = true; break;
      case "--platform": {
        const value = takeValue("--platform");
        if (value === undefined) break;
        if (!(PLATFORMS as readonly string[]).includes(value)) {
          opts.errors.push(`--platform must be one of ${PLATFORMS.join(", ")} (got "${value}")`);
          break;
        }
        opts.platform = value as CliOptions["platform"];
        break;
      }
      case "--voice": opts.voice = true; break;
      case "--leds": opts.leds = true; break;
      case "--wake": { const v = takeValue("--wake"); if (v !== undefined) opts.wakeWord = v.trim() || undefined; break; }
      case "--no-wake": delete opts.wakeWord; break;
      case "--out": { const v = takeValue("--out"); if (v !== undefined) opts.out = v; break; }
      case "--writes": opts.writes = true; break;
      case "--no-cec": opts.cec = false; break;
      case "--no-save": opts.save = false; break;
      case "--cec": { const v = takeValue("--cec"); if (v !== undefined) opts.cec = v; break; }
      case "--intents": {
        const v = takeValue("--intents");
        if (v !== undefined) opts.intents = v.split(";").map((x) => x.trim()).filter(Boolean);
        break;
      }
      case "--room": {
        const v = takeValue("--room");
        if (v === undefined) break;
        if (v !== "demo" && v !== "empty" && v !== "stored") {
          opts.errors.push(`--room must be demo, empty or stored (got "${v}")`);
          break;
        }
        opts.room = v;
        break;
      }
      case "--asr": { const v = takeValue("--asr"); if (v !== undefined) opts.asrBaseUrl = expandAsr(v); break; }
      case "--asr-model": { const v = takeValue("--asr-model"); if (v !== undefined) opts.asrModel = v; break; }
      case "--llm": { const v = takeValue("--llm"); if (v !== undefined) opts.baseUrl = v; break; }
      case "--model": { const v = takeValue("--model"); if (v !== undefined) opts.model = v; break; }
      case "--key": case "--api-key":
        takeValue(name);   // consume it so it can't be read as a command
        opts.errors.push(
          `${name} is not accepted: process arguments are visible to every user on ` +
          "the machine. Use the TV_AGENT_API_KEY environment variable.",
        );
        break;
      default:
        if (name.startsWith("-") && name !== "-") {
          opts.errors.push(`unknown option: ${name}`);
        } else {
          opts.commands.push(arg);
        }
    }
  }

  // `hearth report` is a subcommand, not an utterance. It is matched only as the
  // first word so that `hearth "report the volume"` is still a sentence for the
  // agent — and anything after it is a mistake worth saying, because a report
  // takes a minute and silently ignoring a command would be a surprise.
  if (opts.commands[0] === "report") {
    opts.report = true;
    const extra = opts.commands.slice(1);
    opts.commands = [];
    if (extra.length) opts.errors.push(`report takes no commands (got: ${extra.join(", ")})`);
  }
  if (opts.commands[0] === "setup") {
    opts.setup = true;
    const extra = opts.commands.slice(1);
    opts.commands = [];
    if (extra.length) opts.errors.push(`setup takes no commands (got: ${extra.join(", ")})`);
  }
  if (!opts.report) {
    const reportOnly = [
      opts.out !== undefined && "--out", opts.writes && "--writes", opts.intents && "--intents",
    ].filter(Boolean);
    if (reportOnly.length) opts.warnings.push(`${reportOnly.join(", ")}: only used by \`hearth report\``);
  }

  // `--json` exists so output can be piped somewhere; a tool trace interleaved
  // on stderr is fine, but a confirmation prompt nobody can answer is a hang.
  if (opts.json && !opts.yes && !opts.report && !opts.setup) {
    opts.warnings.push("--json without --yes: a tool that needs confirmation will still prompt");
  }
  // Said once, at startup, rather than discovered by standing in front of a
  // microphone waiting for something that was never going to happen.
  // Not during setup, which says the same thing in context, with the fix.
  if (opts.voice && !opts.asrBaseUrl && !opts.setup) {
    opts.warnings.push(
      "--voice without --asr: this build can speak but not listen. Point --asr at an " +
      "OpenAI-compatible /audio/transcriptions (a whisper server on the LAN will do).",
    );
  }
  if (opts.voice && opts.platform !== "linux") {
    opts.warnings.push(`--voice needs --platform linux; the ${opts.platform} adapter has no microphone`);
  }
  if (opts.leds && opts.platform !== "linux") {
    opts.warnings.push(`--leds needs --platform linux; the ${opts.platform} adapter has no ring`);
  }
  return opts;
}

/**
 * `--asr openai` for the one hosted endpoint most people already have a key
 * for. Anything else is a URL and is passed through — a whisper server on the
 * LAN, a different vendor's OpenAI-compatible route, whatever it is.
 */
export function expandAsr(value: string): string {
  return value.trim().toLowerCase() === "openai" ? "https://api.openai.com/v1" : value;
}

export const HELP = `hearth — the TV agent, in a terminal

USAGE
  hearth [options] [command ...]     run each command, then exit
  hearth [options]                   interactive; one command per line
  hearth report [options]            probe this box, run the scenarios, print a
                                     Hearth Report section (markdown)
  hearth setup [options]             look at this box, write ~/.config/hearth/
                                     config.json, say what it can do (linux)

OPTIONS
  --platform mock|linux   which TV to drive (default: mock, or $TV_PLATFORM)
  --llm <url>             OpenAI-compatible base URL (or $TV_AGENT_LLM)
  --model <name>          model name (or $TV_AGENT_MODEL)
      --voice             listen on the microphone too (linux)
      --asr <url>         OpenAI-compatible transcription base URL (or $TV_AGENT_ASR);
                          \`openai\` means https://api.openai.com/v1 (key in $TV_AGENT_API_KEY)
      --asr-model <name>  transcription model (or $TV_AGENT_ASR_MODEL)
      --leds              show each outcome on the APA102 status ring (linux)
      --wake <word>       act only on what is said after this word is heard;
                          everything else is transcribed and dropped
      --no-wake           act on everything heard
      --cec <device>      CEC adapter to discover with (default /dev/cec0, linux)
      --no-cec            do not touch the CEC bus
      --room <mode>       demo|empty|stored — how the room is seeded (default: stored)

SETUP OPTIONS
      --asr <url>         remember this transcription endpoint
      --llm <url>         remember this model endpoint (and --model)
      --no-save           show what would be written, write nothing

REPORT OPTIONS
      --out <file>        also write the report to this file
      --writes            let the probe change things (one volume round-trip)
      --intents "a;b"     scenarios for goal mode (default: the four P0 scenarios)
  -y, --yes               approve confirmation prompts without asking
  -q, --quiet             don't print the tool trace to stderr
      --json              print one JSON object per turn on stdout
  -h, --help              this
  -v, --version           print the version

ENVIRONMENT
  TV_AGENT_API_KEY        API key. Environment only — process arguments are
                          visible to every user on the machine.

NOTES
  Flags beat the environment, which beats ~/.config/hearth/config.json, which
  \`hearth setup\` writes — so after setup, plain \`hearth "mute"\` drives this box.
  Replies go to stdout, the tool trace to stderr, so \`hearth "…" | …\` pipes
  the answer alone. With no --llm the built-in offline brain answers, which
  understands a handful of commands and needs no network.

EXAMPLES
  TV_AGENT_API_KEY=sk-… hearth --platform linux setup --asr openai
  hearth --platform linux setup --asr http://192.168.1.104:9000/v1   # a whisper server on the LAN
  hearth "turn it down"              # after setup: no flags needed
  hearth --platform linux report --out docs/platform/reports/my-pi.md
  hearth "set volume to 30"
  hearth --platform linux --voice --leds --wake hearth --asr http://192.168.1.104:9000/v1
  hearth --platform linux "mute"
  TV_AGENT_LLM=http://127.0.0.1:11434/v1 TV_AGENT_MODEL=llama3.2 hearth
  echo "what's the volume?" | hearth --json --yes
`;
