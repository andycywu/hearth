import { describe, expect, it } from "vitest";
import { ringStateForCec, ringStateForDiagnosis, type CecLabResult, type CecVerdict } from "./lab-cec.js";

const result = (verdict: CecVerdict, readBack?: CecLabResult["readBack"]): CecLabResult => ({
  id: "x", label: "x", target: 0, at: "", ms: 0, verdict, summary: "", facts: {}, steps: [], ...(readBack ? { readBack } : {}),
});

describe("what the ring says about a CEC result", () => {
  it("green only for what the TV itself confirmed", () => {
    expect(ringStateForCec(result("reply"))).toBe("verified");
    expect(ringStateForCec(result("sent", { wanted: "standby", reached: true, last: "standby", afterMs: 1_000 }))).toBe("verified");
  });

  it("red when the bus took the message and the TV did not do it — accepted is not done", () => {
    expect(ringStateForCec(result("sent", { wanted: "standby", reached: false, last: "on", afterMs: 12_000 }))).toBe("failed");
  });

  it("amber, never green, for a message nothing can read back", () => {
    expect(ringStateForCec(result("sent"))).toBe("unverified");
    expect(ringStateForCec(result("no-reply"))).toBe("unverified");
  });

  it("violet for a TV that says it cannot, red for a bus that did not hear", () => {
    expect(ringStateForCec(result("feature-abort"))).toBe("unsupported");
    for (const v of ["not-acknowledged", "unconfigured", "error"] as const) expect(ringStateForCec(result(v)), v).toBe("failed");
  });

  it("a diagnosis is green, amber or red by its first problem", () => {
    expect(ringStateForDiagnosis({ firstProblem: undefined })).toBe("verified");
    expect(ringStateForDiagnosis({ firstProblem: { layer: "Logical address", status: "warn", detail: "" } })).toBe("unverified");
    expect(ringStateForDiagnosis({ firstProblem: { layer: "HDMI cable", status: "fail", detail: "" } })).toBe("failed");
  });
});
