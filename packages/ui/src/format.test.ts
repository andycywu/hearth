import { describe, it, expect } from "vitest";
import { formatToolCall, truncate } from "./format.js";

describe("formatToolCall", () => {
  it("renders a readable call signature", () => {
    expect(formatToolCall("set_volume", { level: 30 })).toBe("set_volume(level=30)");
  });
  it("handles multiple args and objects", () => {
    expect(formatToolCall("launch_app", { appId: "netflix" })).toBe("launch_app(appId=netflix)");
  });
  it("handles no args", () => {
    expect(formatToolCall("list_apps", {})).toBe("list_apps()");
  });
});

describe("truncate", () => {
  it("leaves short text unchanged", () => {
    expect(truncate("hi", 10)).toBe("hi");
  });
  it("truncates with an ellipsis", () => {
    expect(truncate("abcdefghij", 5)).toBe("abcd…");
  });
});
