import { describe, it, expect } from "vitest";
import { parseArgs } from "./args.js";

describe("parseArgs", () => {
  it("treats bare words as commands, in order", () => {
    expect(parseArgs(["mute", "set volume to 30"]).commands)
      .toEqual(["mute", "set volume to 30"]);
  });

  it("defaults to the mock TV, so a stray run can't touch real hardware", () => {
    expect(parseArgs([]).platform).toBe("mock");
  });

  it("accepts --flag value and --flag=value alike", () => {
    expect(parseArgs(["--llm", "http://a/v1"]).baseUrl).toBe("http://a/v1");
    expect(parseArgs(["--llm=http://b/v1"]).baseUrl).toBe("http://b/v1");
  });

  it("lets a flag beat the environment", () => {
    const opts = parseArgs(["--platform", "linux"], { TV_PLATFORM: "mock" });
    expect(opts.platform).toBe("linux");
  });

  it("reads the environment when no flag says otherwise", () => {
    const opts = parseArgs([], { TV_PLATFORM: "linux", TV_AGENT_LLM: "http://x/v1", TV_AGENT_MODEL: "m" });
    expect(opts).toMatchObject({ platform: "linux", baseUrl: "http://x/v1", model: "m" });
  });

  it("rejects a platform it doesn't have, rather than silently using the mock", () => {
    expect(parseArgs(["--platform", "tizen"]).errors[0]).toMatch(/--platform must be one of/);
    expect(parseArgs([], { TV_PLATFORM: "nonsense" }).errors[0]).toMatch(/TV_PLATFORM must be one of/);
  });

  describe("the API key", () => {
    it("comes from the environment", () => {
      expect(parseArgs([], { TV_AGENT_API_KEY: "sk-1" }).apiKey).toBe("sk-1");
    });

    it("is refused on the command line, because ps shows everyone your argv", () => {
      // Not silently ignored: a key that looks accepted and isn't would send the
      // request unauthenticated and the failure would look like a server fault.
      const opts = parseArgs(["--key", "sk-secret"]);
      expect(opts.apiKey).toBeUndefined();
      expect(opts.errors[0]).toMatch(/not accepted/);
      expect(opts.errors[0]).toMatch(/TV_AGENT_API_KEY/);
    });

    it("doesn't leave the refused key behind as a command to run", () => {
      expect(parseArgs(["--key", "sk-secret"]).commands).toEqual([]);
    });

    it("never echoes the key's value in the error", () => {
      expect(parseArgs(["--key", "sk-secret"]).errors.join(" ")).not.toContain("sk-secret");
    });
  });

  it("flags an unknown option instead of running it as a command", () => {
    const opts = parseArgs(["--wat", "mute"]);
    expect(opts.errors[0]).toMatch(/unknown option: --wat/);
    expect(opts.commands).toEqual(["mute"]);
  });

  it("complains when a value-taking flag is last", () => {
    expect(parseArgs(["--llm"]).errors[0]).toMatch(/--llm needs a value/);
  });

  it("warns that --json alone can still stop on a prompt", () => {
    expect(parseArgs(["--json"]).warnings[0]).toMatch(/--yes/);
    expect(parseArgs(["--json", "--yes"]).warnings).toEqual([]);
  });

  it("always has a model, since the client requires one", () => {
    expect(parseArgs([]).model).toBeTruthy();
  });

  it("handles the short forms", () => {
    expect(parseArgs(["-q", "-y", "-h", "-v"]))
      .toMatchObject({ quiet: true, yes: true, help: true, version: true });
  });
});

describe("hearth report", () => {
  it("is a subcommand only as the first word, so 'report the volume' stays a sentence", () => {
    expect(parseArgs(["report"])).toMatchObject({ report: true, commands: [] });
    expect(parseArgs(["report the volume"])).toMatchObject({ report: false, commands: ["report the volume"] });
  });

  it("refuses commands after it, rather than silently dropping them", () => {
    const opts = parseArgs(["report", "mute"]);
    expect(opts.report).toBe(true);
    expect(opts.errors[0]).toMatch(/report takes no commands/);
  });

  it("takes its own options and leaves the room alone by default", () => {
    const opts = parseArgs(["report", "--out", "x.md", "--writes", "--intents", "a; b ;", "--room", "demo", "--cec", "/dev/cec1"]);
    expect(opts).toMatchObject({
      report: true, out: "x.md", writes: true, intents: ["a", "b"], room: "demo", cec: "/dev/cec1",
    });
    expect(parseArgs([]).room).toBe("stored");
    expect(parseArgs(["--no-cec"]).cec).toBe(false);
  });

  it("rejects a room mode it doesn't have", () => {
    expect(parseArgs(["--room", "garage"]).errors[0]).toMatch(/--room must be/);
  });

  it("warns when report-only options are given to the agent", () => {
    expect(parseArgs(["--out", "x.md", "mute"]).warnings[0]).toMatch(/--out.*hearth report/);
  });

  it("does not nag about --json without --yes for a report, which never prompts", () => {
    expect(parseArgs(["report", "--json"]).warnings).toEqual([]);
  });
});

describe("hearth setup and the config it writes", () => {
  it("is a subcommand only as the first word", () => {
    expect(parseArgs(["setup"])).toMatchObject({ setup: true, commands: [] });
    expect(parseArgs(["setup", "mute"]).errors[0]).toMatch(/setup takes no commands/);
  });

  it("reads what setup wrote, expressed as environment, underneath the real environment", () => {
    const fromConfig = { TV_PLATFORM: "linux", HEARTH_CEC: "/dev/cec1", HEARTH_VOICE: "1", HEARTH_LEDS: "1", HEARTH_WAKE: "hearth", TV_AGENT_ASR: "http://a/v1" };
    expect(parseArgs([], fromConfig)).toMatchObject({
      platform: "linux", cec: "/dev/cec1", voice: true, leds: true, wakeWord: "hearth", asrBaseUrl: "http://a/v1",
    });
    expect(parseArgs([], { ...fromConfig, HEARTH_CEC: "off" }).cec).toBe(false);
    // Flags still win.
    const overridden = parseArgs(["--no-cec", "--no-wake", "--platform", "mock"], fromConfig);
    expect(overridden).toMatchObject({ cec: false, platform: "mock" });
    expect(overridden.wakeWord).toBeUndefined();
  });

  it("takes --wake and --no-wake", () => {
    expect(parseArgs(["--wake", "小爐"]).wakeWord).toBe("小爐");
    expect(parseArgs(["--wake", "  "]).wakeWord).toBeUndefined();
  });
});
