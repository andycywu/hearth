export { mountAgentOverlay, type OverlayOptions, type OverlayController } from "./overlay.js";
export { mountAgentCanvas, type CanvasOptions, type CanvasController } from "./canvas.js";
export {
  createConfirmHandler,
  confirmOverrideFromUrl,
  commandsFromUrl,
  runStartupCommands,
  mountDeviceShell,
  speakReplies,
  type ConfirmHandlerOptions,
  type DeviceShellOptions,
  type SpeakRepliesOptions,
} from "./device-ux.js";
export {
  runDemo,
  demoFromUrl,
  DEFAULT_DEMO_SCRIPT,
  type DemoOptions,
} from "./demo.js";
export {
  mountAgentAvatar,
  avatarFrame,
  type AvatarOptions,
  type AvatarController,
  type AvatarFrame,
  type AvatarFrameOptions,
} from "./avatar.js";
export {
  mountOnScreenKeyboard,
  createKeyboardModel,
  remoteIntent,
  DEFAULT_TV_KEYBOARD,
  type OnScreenKeyboardOptions,
  type OnScreenKeyboardController,
  type KeyboardModel,
  type KeyboardKey,
  type KeyDirection,
} from "./keyboard.js";
export {
  createAgentViewModel,
  type AgentViewModel,
  type AgentViewState,
  type AgentPhase,
} from "./view-model.js";
export { formatToolCall, truncate } from "./format.js";
export { wrapLines } from "./wrap.js";
