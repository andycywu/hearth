import { describe, it, expect } from "vitest";
import { createWeatherTool, describeCode } from "./weather.js";

/** Fake Open-Meteo: records the URLs asked for, replies from a script. */
function fakeFetch(replies: Array<{ ok?: boolean; status?: number; body?: unknown }>) {
  const urls: string[] = [];
  const impl = (async (url: string) => {
    urls.push(String(url));
    const next = replies.shift() ?? { ok: false, status: 500 };
    return {
      ok: next.ok ?? true,
      status: next.status ?? 200,
      json: async () => next.body,
    };
  }) as unknown as typeof fetch;
  return { impl, urls };
}

const geocode = (over: Record<string, unknown> = {}) => ({
  results: [{ name: "Taipei", country: "Taiwan", latitude: 25.05, longitude: 121.53, ...over }],
});
const forecast = (temp: unknown, code = 61) => ({ current: { temperature_2m: temp, weather_code: code } });

describe("get_weather tool", () => {
  it("declares a schema the model can fill in", () => {
    const tool = createWeatherTool();
    expect(tool.spec.name).toBe("get_weather");
    expect(tool.spec.parameters.city?.required).toBe(true);
    // Pure logic: nothing here is destructive, so it must not nag the user.
    expect(tool.spec.confirm).toBeUndefined();
  });

  it("geocodes the city, then reads the current conditions", async () => {
    const { impl, urls } = fakeFetch([{ body: geocode() }, { body: forecast(21.34, 61) }]);
    const result = await createWeatherTool({ fetchImpl: impl }).execute({ city: "Taipei" });
    expect(result).toEqual({ city: "Taipei", country: "Taiwan", tempC: 21.3, summary: "Light rain" });
    expect(urls[0]).toContain("geocoding-api.open-meteo.com");
    expect(urls[0]).toContain("name=Taipei");
    expect(urls[1]).toContain("latitude=25.05");
    expect(urls[1]).toContain("longitude=121.53");
  });

  it("url-encodes a multi-word or non-Latin place name", async () => {
    const { impl, urls } = fakeFetch([{ body: geocode({ name: "新竹市" }) }, { body: forecast(30) }]);
    await createWeatherTool({ fetchImpl: impl }).execute({ city: "新竹 市" });
    expect(urls[0]).toContain(`name=${encodeURIComponent("新竹 市")}`);
  });

  it("reports the resolved place name, which may differ from the query", async () => {
    const { impl } = fakeFetch([{ body: geocode({ name: "Taipei City" }) }, { body: forecast(19) }]);
    const r = await createWeatherTool({ fetchImpl: impl }).execute({ city: "taipei" });
    expect(r.city).toBe("Taipei City");
  });

  it("omits the country when the service doesn't give one", async () => {
    const { impl } = fakeFetch([{ body: geocode({ country: undefined }) }, { body: forecast(5) }]);
    const r = await createWeatherTool({ fetchImpl: impl }).execute({ city: "Nowhere" });
    expect(r).not.toHaveProperty("country");
  });

  it("explains an unknown city instead of throwing something cryptic", async () => {
    // The agent feeds a thrown message back to the model, so it must read well.
    const { impl } = fakeFetch([{ body: { results: [] } }]);
    await expect(createWeatherTool({ fetchImpl: impl }).execute({ city: "Atlantis" }))
      .rejects.toThrow(/couldn't find a place called "Atlantis"/);
  });

  it("rejects an empty city before touching the network", async () => {
    let calls = 0;
    const impl = (async () => { calls++; return { ok: true, json: async () => ({}) }; }) as unknown as typeof fetch;
    await expect(createWeatherTool({ fetchImpl: impl }).execute({ city: "   " })).rejects.toThrow(/No city/);
    expect(calls).toBe(0);
  });

  it("surfaces an HTTP failure from either call", async () => {
    const geoDown = fakeFetch([{ ok: false, status: 503 }]);
    await expect(createWeatherTool({ fetchImpl: geoDown.impl }).execute({ city: "Taipei" }))
      .rejects.toThrow(/HTTP 503/);

    const forecastDown = fakeFetch([{ body: geocode() }, { ok: false, status: 500 }]);
    await expect(createWeatherTool({ fetchImpl: forecastDown.impl }).execute({ city: "Taipei" }))
      .rejects.toThrow(/HTTP 500/);
  });

  it("reports a missing temperature rather than returning NaN", async () => {
    const { impl } = fakeFetch([{ body: geocode() }, { body: { current: {} } }]);
    await expect(createWeatherTool({ fetchImpl: impl }).execute({ city: "Taipei" }))
      .rejects.toThrow(/no temperature/i);
  });

  it("turns an aborted request into a readable timeout message", async () => {
    const impl = (async () => {
      const err = new Error("aborted");
      err.name = "AbortError";
      throw err;
    }) as unknown as typeof fetch;
    await expect(createWeatherTool({ fetchImpl: impl, timeoutMs: 25 }).execute({ city: "Taipei" }))
      .rejects.toThrow(/didn't answer within 25ms/);
  });

  it("rounds the temperature to one decimal for the 10-foot UI", async () => {
    const { impl } = fakeFetch([{ body: geocode() }, { body: forecast(21.3456) }]);
    expect((await createWeatherTool({ fetchImpl: impl }).execute({ city: "Taipei" })).tempC).toBe(21.3);
  });
});

describe("describeCode", () => {
  it("groups WMO codes into short phrases", () => {
    expect(describeCode(0)).toBe("Clear");
    expect(describeCode(3)).toBe("Overcast");
    expect(describeCode(48)).toBe("Fog");
    expect(describeCode(53)).toBe("Drizzle");
    expect(describeCode(61)).toBe("Light rain");
    expect(describeCode(65)).toBe("Rain");
    expect(describeCode(75)).toBe("Snow");
    expect(describeCode(81)).toBe("Rain showers");
    expect(describeCode(99)).toBe("Thunderstorm");
  });

  it("never guesses for an unmapped or absent code", () => {
    expect(describeCode(7)).toBe("Unknown");
    expect(describeCode(NaN)).toBe("Unknown");
  });
});
