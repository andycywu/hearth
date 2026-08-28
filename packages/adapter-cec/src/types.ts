/**
 * HDMI-CEC as this runtime needs it: a transport, not a protocol stack.
 *
 * CEC is the first thing here that reaches *past* the television. Everything
 * before it — volume, mute, apps, input — was the TV acting on itself through
 * the HAL. A console on HDMI2 is a different kind of object: it has its own
 * power state, its own name, and its own opinion about whether it received
 * anything.
 *
 * The interface is deliberately message-shaped rather than intent-shaped. Every
 * method below names the CEC message it sends, because the gap between "wake the
 * console" and "broadcast `<Set Stream Path>` and hope" is exactly where an agent
 * starts claiming things it did not do. A host implements six methods over
 * whatever CEC API it has; nothing above this file knows which one.
 *
 * ## What implements it
 *
 * | Host | API | Reachable? |
 * |---|---|---|
 * | Android TV | `HdmiControlManager` — `getConnectedDevices`, `deviceSelect`, `sendKeyEvent` | **Only with the `HDMI_CEC` permission**, which is `@SystemApi`. A third-party app gets nothing |
 * | Linux | `/dev/cec0` via `cec-ctl`, or libcec | Yes — this is the one anybody can actually buy their way into, with a Raspberry Pi and an HDMI cable |
 * | Tizen / webOS | no public CEC surface | No |
 *
 * That table is the finding, not a footnote: on every platform whose image we do
 * not own, CEC is behind the same privilege wall as input switching. So
 * `available()` is not a formality — it is the normal answer, and the capability
 * graph is expected to withdraw the whole transport on most devices.
 */

/**
 * A CEC logical address, 0–15, which is also a coarse device class.
 *
 * The spec assigns addresses by *function*: a playback device gets 4, 8 or 11
 * because those are the playback slots, not because anyone knows what it is. So
 * this tells us "something that plays" and never "a PlayStation".
 */
export type CecLogicalAddress = number;

export const CEC_ADDRESS_TV = 0;
export const CEC_ADDRESS_BROADCAST = 15;

/**
 * `<Report Power Status>` — the reply to `<Give Device Power Status>` (0x8F).
 *
 * `unknown` is not a CEC value. It is what this layer says when the device did
 * not answer, which is common enough to be the interesting case: plenty of
 * hardware acknowledges the poll, ignores the question, and is otherwise
 * perfectly functional. An agent that reads silence as "off" will helpfully
 * wake a console that was already on.
 */
export type CecPowerStatus = "on" | "standby" | "to_on" | "to_standby" | "unknown";

/** The raw operand of `<Report Power Status>`, for an implementer decoding a frame. */
export const CEC_POWER_STATUS: Record<number, CecPowerStatus> = {
  0x00: "on",
  0x01: "standby",
  0x02: "to_on",
  0x03: "to_standby",
};

/**
 * One device that answered a poll.
 *
 * Every field except `logical` is optional because every field except `logical`
 * comes from a *further* message the device may decline to answer. A device that
 * polls and then says nothing else is still a device, and reporting it with an
 * invented name would be worse than reporting it as unnamed.
 */
export interface CecDevice {
  logical: CecLogicalAddress;
  /** `<Report Physical Address>` — `"2.0.0.0"`. Absent if it never told us. */
  physical?: string;
  /** `<Set OSD Name>` — the name the device calls itself. */
  osdName?: string;
  /** `<Device Vendor ID>`, as the 24-bit value or a decoded name. */
  vendorId?: string;
}

/**
 * The six things a host must be able to do for CEC to be worth anything here.
 *
 * Each method should throw `TvUnsupportedError` when the platform has no CEC
 * surface at all, and a plain `Error` when the bus exists and the attempt
 * failed. That is the same `unsupported` / `failed` distinction the tool layer
 * draws everywhere else, and it decides whether the planner withdraws the
 * capability or retries it.
 */
export interface CecTransport {
  /**
   * Is there a CEC bus reachable from this process?
   *
   * Cheap and side-effect free — it is called at boot, before anything is
   * offered to a model. `false` on most devices, for permission reasons rather
   * than hardware ones.
   */
  available(): Promise<boolean>;

  /**
   * Poll the bus and ask whatever answers for its physical address, OSD name and
   * vendor id. Sends `<Give Physical Address>`, `<Give OSD Name>` and
   * `<Give Device Vendor ID>` to each address that responded.
   */
  scan(signal?: AbortSignal): Promise<CecDevice[]>;

  /**
   * `<Give Device Power Status>` (0x8F), and wait for `<Report Power Status>`.
   *
   * Resolves to `"unknown"` on a timeout rather than rejecting: not answering is
   * something a working device does.
   */
  powerStatus(logical: CecLogicalAddress): Promise<CecPowerStatus>;

  /**
   * Wake a device: broadcast `<Set Stream Path>` (0x86) with its physical
   * address, which per spec makes it the active source and powers it on if it
   * was in standby.
   *
   * Resolving means **the bus accepted the message**. It does not mean the
   * device woke up, and nothing in this interface can make it mean that — which
   * is why the capability that uses it verifies with a power-status read
   * afterwards instead of trusting this call.
   */
  wake(device: CecDevice): Promise<void>;

  /** `<Standby>` (0x36), addressed to one device — never broadcast, which would put the whole room to sleep. */
  standby(logical: CecLogicalAddress): Promise<void>;

  /** `<Set Stream Path>` (0x86) without the power intent: route the TV to this device. */
  selectSource(device: CecDevice): Promise<void>;
}
