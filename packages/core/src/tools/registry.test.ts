import { describe, it, expect } from "vitest";
import {
  ToolRegistry, validateArgs, ToolValidationError, UnknownToolError, type Tool,
} from "./registry.js";

const echoTool: Tool = {
  spec: {
    name: "echo",
    description: "echo",
    parameters: {
      level: { type: "number", description: "n", required: true },
      source: { type: "string", description: "s", enum: ["hdmi1", "tv"] },
    },
  },
  execute: async (args) => args,
};

describe("validateArgs", () => {
  it("coerces stringified numbers", () => {
    const out = validateArgs(echoTool.spec, { level: "42" });
    expect(out.level).toBe(42);
  });

  it("throws on missing required arg", () => {
    expect(() => validateArgs(echoTool.spec, {})).toThrow(ToolValidationError);
  });

  it("throws on invalid enum value", () => {
    expect(() => validateArgs(echoTool.spec, { level: 1, source: "usb" }))
      .toThrow(/must be one of/);
  });
});

describe("ToolRegistry", () => {
  it("validates before executing", async () => {
    const reg = new ToolRegistry();
    reg.register(echoTool);
    const res = (await reg.call("echo", { level: "10" })) as { level: number };
    expect(res.level).toBe(10);
  });

  it("rejects unknown tools", async () => {
    const reg = new ToolRegistry();
    await expect(reg.call("nope", {})).rejects.toBeInstanceOf(UnknownToolError);
  });
});
