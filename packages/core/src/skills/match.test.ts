import { describe, expect, it } from "vitest";
import { matchSkill } from "./match.js";

describe("matching a sentence to a scenario", () => {
  it("hears the television being switched off, in English and Chinese", () => {
    for (const s of ["turn off the tv", "Turn the TV off please", "switch off the TV", "關電視", "幫我關掉電視", "把電視關掉"]) {
      expect(matchSkill(s)?.skill.id, s).toBe("tv_power_off");
    }
  });

  it("hears it being switched on, in English and Chinese", () => {
    for (const s of ["turn on the tv", "Turn the TV on", "switch on the tv", "開電視", "幫我打開電視", "開啟電視"]) {
      expect(matchSkill(s)?.skill.id, s).toBe("tv_power_on");
    }
  });

  it("does not take other sentences for them", () => {
    expect(matchSkill("turn it down")?.skill.id).toBe("quieter");
    expect(matchSkill("switch to hdmi 2")?.skill.id).toBe("switch_input");
    expect(matchSkill("打開 Netflix")).toBeUndefined();
    expect(matchSkill("what is on tv tonight")).toBeUndefined();
    expect(matchSkill("turn off the lights")).toBeUndefined();
  });
});
