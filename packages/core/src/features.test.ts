import { describe, it, expect } from "vitest";
import { featureFlags, describeFeatures } from "./features.js";

/**
 * These tests cover the *unbundled* half of the contract, which is the half a
 * test can see: nothing is defined here, so every optional feature has to read
 * as present. The other half — that a `false` actually removes the code — is not
 * a unit-test question at all; it is a bundler question, and
 * `bundle-features.test.ts` answers it by building and weighing the output.
 */

describe("feature flags with nothing defined", () => {
  it("reports every feature as present", () => {
    // A test run, the CLI and a plain `tsx` script all land here. Defaulting to
    // absent would make a passing test suite prove nothing about a real build.
    expect(featureFlags()).toEqual({
      diag: true, offline: true, modelpilot: true,
      avatar: true, keyboard: true, demo: true,
    });
  });

  it("describes the build in one line", () => {
    expect(describeFeatures()).toBe("diag offline modelpilot avatar keyboard demo");
  });
});
