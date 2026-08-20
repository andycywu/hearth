import { defineTool, type Tool } from "@hearthkit/core";

/**
 * A worked example of a **pure-logic / external-service skill**: it answers a
 * question the TV itself can't, using nothing but `fetch`. No HAL capability, no
 * `has()` gate, no vendor signature — so the identical code runs on AOSP, Tizen,
 * webOS and the browser harness. That portability is the point; see
 * `docs/skills.md` for the contrast with capability-gated skills.
 *
 * Uses Open-Meteo, which needs no API key.
 */

export interface WeatherToolOptions {
  /** Injected for tests; defaults to the global fetch. */
  fetchImpl?: typeof fetch;
  /**
   * Give up after this long. A TV must not sit silent waiting on a network that
   * a hotel firewall is quietly dropping. Default 8000ms.
   */
  timeoutMs?: number;
  /** Language for place names in the geocoding lookup. Default "en". */
  language?: string;
}

export interface WeatherResult {
  /** Resolved place name, which may differ from the query ("Taipei City"). */
  city: string;
  country?: string;
  tempC: number;
  /** Human-readable condition, e.g. "Light rain". */
  summary: string;
}

const GEOCODE_URL = "https://geocoding-api.open-meteo.com/v1/search";
const FORECAST_URL = "https://api.open-meteo.com/v1/forecast";

export function createWeatherTool(opts: WeatherToolOptions = {}): Tool<{ city: string }, WeatherResult> {
  const doFetch = opts.fetchImpl ?? ((...a: Parameters<typeof fetch>) => fetch(...a));
  const timeoutMs = opts.timeoutMs ?? 8000;
  const language = opts.language ?? "en";

  return defineTool<{ city: string }, WeatherResult>(
    {
      name: "get_weather",
      description:
        "Current weather for a city or town. Use for questions like \"what's the weather in Taipei?\".",
      parameters: {
        city: { type: "string", description: "City or town name, e.g. 'Taipei'", required: true },
      },
    },
    async ({ city }) => {
      const query = city.trim();
      if (!query) throw new Error("No city given.");

      const place = await getJson(
        `${GEOCODE_URL}?name=${encodeURIComponent(query)}&count=1&language=${language}&format=json`,
      );
      const hit = (place as { results?: Array<Record<string, unknown>> }).results?.[0];
      if (!hit) throw new Error(`I couldn't find a place called "${query}".`);

      const forecast = await getJson(
        `${FORECAST_URL}?latitude=${Number(hit.latitude)}&longitude=${Number(hit.longitude)}` +
          "&current=temperature_2m,weather_code",
      );
      const current = (forecast as { current?: Record<string, unknown> }).current;
      const tempC = Number(current?.temperature_2m);
      if (!Number.isFinite(tempC)) throw new Error("The weather service returned no temperature.");

      return {
        city: String(hit.name ?? query),
        ...(hit.country ? { country: String(hit.country) } : {}),
        tempC: Math.round(tempC * 10) / 10,
        summary: describeCode(Number(current?.weather_code)),
      };
    },
  );

  async function getJson(url: string): Promise<unknown> {
    // AbortController is present in every target engine (and Node 18+); the
    // fallback keeps a stubbed test fetch from having to care about signals.
    const controller = typeof AbortController === "function" ? new AbortController() : undefined;
    const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : undefined;
    try {
      const res = await doFetch(url, controller ? { signal: controller.signal } : {});
      if (!res.ok) throw new Error(`weather service HTTP ${res.status}`);
      return await res.json();
    } catch (err) {
      if ((err as Error)?.name === "AbortError") {
        throw new Error(`The weather service didn't answer within ${timeoutMs}ms.`);
      }
      throw err;
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }
}

/**
 * WMO weather codes → short phrases. Grouped rather than exhaustive: a 10-foot
 * UI wants "Light rain", not "Drizzle: light intensity".
 */
export function describeCode(code: number): string {
  if (!Number.isFinite(code)) return "Unknown";
  if (code === 0) return "Clear";
  if (code === 1) return "Mainly clear";
  if (code === 2) return "Partly cloudy";
  if (code === 3) return "Overcast";
  if (code === 45 || code === 48) return "Fog";
  if (code >= 51 && code <= 57) return "Drizzle";
  if (code >= 61 && code <= 65) return code === 61 ? "Light rain" : "Rain";
  if (code === 66 || code === 67) return "Freezing rain";
  if (code >= 71 && code <= 77) return "Snow";
  if (code >= 80 && code <= 82) return "Rain showers";
  if (code === 85 || code === 86) return "Snow showers";
  if (code >= 95) return "Thunderstorm";
  return "Unknown";
}
