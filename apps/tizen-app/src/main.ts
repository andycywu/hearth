import { bootRuntime } from "@hearthkit/host";
import { createTizenAdapter } from "@hearthkit/adapter-tizen";

/**
 * The Tizen entry. Everything that is not Tizen lives in `@hearthkit/host` —
 * see packages/host/src/boot.ts for why.
 */
void bootRuntime({
  name: "tizen",
  createAdapter: createTizenAdapter,
  // Opaque: this runtime gives a web app no way to make its window see-through,
  // so a translucent page just composites the scrim over the runtime's own pale
  // backing and the whole screen comes out washed-out grey. `?translucent` to
  // try it anyway on a build that does composite.
  translucent: false,
});
