import { bootRuntime } from "@hearthkit/host";
import { createWebosAdapter } from "@hearthkit/adapter-webos";

/**
 * The webOS entry. Everything that is not webOS lives in `@hearthkit/host` —
 * see packages/host/src/boot.ts for why.
 */
void bootRuntime({
  name: "webos",
  createAdapter: createWebosAdapter,
  translucent: false,
  preflight: () => {
    // The Luna bridge lives in LG's webOSTV.js, which this repo doesn't ship.
    // Say so plainly instead of failing later with "webOS is not defined".
    if ((window as unknown as Record<string, unknown>).__WEBOSTV_MISSING__) {
      throw new Error(
        "webOSTV.js is missing — drop LG's library in as webOSTVjs/webOSTV.js " +
        "before packaging (see apps/webos-app/README.md)",
      );
    }
  },
});
