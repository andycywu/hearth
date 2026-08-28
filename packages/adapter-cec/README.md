# @hearthkit/adapter-cec

HDMI-CEC as a transport: device discovery and power control for the things
plugged **into** the television, rather than the television itself.

Design, and the three defects building it found in code that was already green:
[**docs/cec.md**](../../docs/cec.md).

```ts
import { createCecSource, createCecTools, createMockCecBus, MOCK_LIVING_ROOM } from "@hearthkit/adapter-cec";
import { discoverRoom } from "@hearthkit/core";

const bus = createMockCecBus(MOCK_LIVING_ROOM);        // or your platform's transport
const room = await discoverRoom(platform, { sources: [createCecSource(bus)] });

for (const tool of await createCecTools(bus, [{ deviceId: "ps5", device }])) {
  tools.register(tool);
}
```

`createCecTools` returns an empty list when there is no CEC bus, which is the
normal case: on Android the API is `@SystemApi`, and Tizen and webOS expose none
at all. The capabilities stay in the graph either way, so the agent can say "I
know what that would be and I have no way to do it" instead of pretending the
console is not there.

**No real CEC bus has ever run this.** Everything here is verified against
`createMockCecBus`, which is written to misbehave the way real hardware does —
a device that never answers `<Give Device Power Status>`, a device that accepts
`<Set Stream Path>` and stays in standby, and a platform with no bus at all. The
cheapest way to change that is a Raspberry Pi and `cec-ctl`, not a television.
