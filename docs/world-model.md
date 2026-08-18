# Living Room World Model

> The agent must first know *what the world is*, and only then decide *what to do
> next*. Everything else in this design depends on that ordering.

Implementation: [`packages/core/src/world/`](../packages/core/src/world/).

## Why

Today the agent has chat history and nothing else. "Turn it down a bit" forces a
`get_volume` before every `set_volume`, "is the PS5 on?" is unanswerable, and
nothing survives the 12-message context trim. A World Model replaces guessing
with a state store that knows what it knows, how sure it is, when it learned it
and from whom.

## The shape

```ts
interface LivingRoomState {
  users: Fact<UserPresence[]>;
  tv: TvState;                 // power, input, pictureMode, volume, muted
  inputs: Fact<InputPort[]>;   // hdmi1..4 and what is on them (see device-graph)
  devices: Fact<string[]>;     // device ids; the graph itself lives in devices/
  content: ContentState;       // what is playing, on which app/provider
  audio: AudioState;           // output route, profile
  room: RoomState;             // peopleCount, ambientLight, noise
  sensors: Fact<SensorReading[]>;
  currentActivity: Fact<Activity>;   // idle | watching_streaming | gaming | ...
  history: WorldEvent[];       // bounded ring of what changed and why
}
```

Every leaf is a `Fact<T>`, never a bare value:

```ts
interface Fact<T> {
  value: T | undefined;        // undefined === unknown, and that is a real answer
  confidence: number;          // 0..1
  source: FactSource;          // "tool" | "probe" | "perception" | "user" | "inferred" | "assumed"
  observedAt: number;          // epoch ms
  ttlMs?: number;              // after this, confidence decays toward unknown
}
```

### Five rules

1. **Partial by default.** A fresh `WorldModel` is entirely unknown. Nothing in
   the core may assume a field exists.
2. **Unknown is not a failure.** `unknown` means "go look" or "ask", not "0".
   The planner treats an unknown precondition as a step to *observe*, not a
   reason to abort.
3. **Confidence is mandatory.** A direct read is 1.0; an inference ("the PS5 is
   on because HDMI2 has signal") is lower; an assumption is lower still.
4. **Staleness is decay, not deletion.** Past `ttlMs`, confidence falls; the fact
   remains as a prior, marked stale. A stale fact is still better than nothing
   for planning — it is just not good enough for *verification*.
5. **Reconciliation is by precedence, then recency.** A direct read beats an
   inference regardless of age. Two observations of equal precedence: newest
   wins. A conflict is recorded in `history`, never silently dropped — repeated
   conflicts are the signal that an adapter is lying.

Precedence: `user > tool > probe > perception > inferred > assumed`.

## Example snapshot

```json
{
  "tv": {
    "power":       { "value": "on",       "confidence": 1.0,  "source": "tool",       "observedAt": 1755500000000 },
    "input":       { "value": "hdmi2",    "confidence": 1.0,  "source": "tool",       "observedAt": 1755500001000 },
    "pictureMode": { "value": "standard", "confidence": 0.6,  "source": "assumed",    "observedAt": 1755499000000 },
    "volume":      { "value": 35,         "confidence": 1.0,  "source": "tool",       "observedAt": 1755500002000 }
  },
  "currentActivity": { "value": "watching_streaming", "confidence": 0.8, "source": "inferred", "observedAt": 1755500002000 },
  "room": {
    "peopleCount":  { "value": 2,     "confidence": 0.88, "source": "perception", "observedAt": 1755500003000 },
    "ambientLight": { "value": "low", "confidence": 0.9,  "source": "perception", "observedAt": 1755500003000 }
  }
}
```

## How facts get in

| Source | Path |
|---|---|
| Tool results | The agent loop reads each result through its capability's `reads` map (`observeResult`). A `get_volume` result of `{volume:35,muted:false}` writes two facts. **Live.** |
| Boot probe | `runDiagnostics` / `probeCapabilities` → capability facts and initial reads. |
| Perception | `applyPerception(world, event)` — see [perception](#perception). |
| User statements | "the PS5 is on HDMI2" → highest precedence, no TTL. |
| Inference | Rules over other facts, always marked `inferred`, never above 0.9. |

A **write** also updates state optimistically at reduced confidence
(`source: "assumed"`), and the verification step then confirms or corrects it.
This is exactly why verification is not optional: without it, optimistic writes
rot into confident lies.

## What the model gives the rest of the system

```ts
world.get("tv.volume")            // Fact<number>
world.known("tv.input")           // boolean — confidence above the floor and not stale
world.observe({ path, value, confidence, source })
world.snapshot()                  // full LivingRoomState
world.summarize({ maxChars })     // compact text for the LLM system prompt
world.diff(before, after)         // what a plan step actually changed
```

`summarize()` is the bridge to the model: a short block of known, fresh facts
injected into the prompt, so the LLM stops re-reading the TV to answer "a bit
quieter".

## Perception

Perception events are the second write path, and the only one that is not a
consequence of our own action. See
[`packages/core/src/perception/`](../packages/core/src/perception/):

```json
{
  "type": "occupancy_changed",
  "value": { "peopleCount": 3 },
  "confidence": 0.88,
  "source": "vision",
  "timestamp": "2026-08-18T12:00:00.000Z"
}
```

P0 defines the interface and the reducer only — no CV model, no camera. Event
types reserved: `occupancy_changed`, `person_entered`, `person_left`,
`child_detected`, `low_light`, `speech_detected`, `high_noise`, `device_signal`.

Privacy is a *policy* concern, enforced before a perception source is ever
started: see [policy-and-safety](policy-and-safety.md). Raw frames and audio
never enter the World Model — only derived events do.

## Non-goals

- Not a database. It is in-memory with an optional `KeyValueStore` snapshot.
- Not a home-automation state machine. It records the room; it does not own it.
- Not per-user profiles (that is Memory, a separate module).
