export { mountAgentOverlay, type OverlayOptions, type OverlayController } from "./overlay.js";
export { mountAgentCanvas, type CanvasOptions, type CanvasController } from "./canvas.js";
export {
  createConfirmHandler,
  confirmOverrideFromUrl,
  commandsFromUrl,
  runStartupCommands,
  mountDeviceShell,
  exposeDeviceReport,
  planRequested,
  speakReplies,
  keyboardOption,
  confirmQuestion,
  renderOption,
  inviteText,
  debugRequested,
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
  createListeningState,
  type ListeningState,
  type ListeningStateOptions,
} from "./listening.js";
export {
  mountMicButton,
  type MicButtonOptions,
  type MicButtonController,
} from "./mic-button.js";
export {
  createTvConfirmDialog,
  type TvConfirmDialog,
  type TvConfirmDialogOptions,
} from "./confirm-dialog.js";
export {
  mountOnScreenKeyboard,
  createKeyboardModel,
  DEFAULT_TV_KEYBOARD,
  type OnScreenKeyboardOptions,
  type OnScreenKeyboardController,
  type KeyboardModel,
  type KeyboardKey,
  type KeyDirection,
} from "./keyboard.js";
export { remoteIntent } from "./remote-keys.js";
export {
  createAgentViewModel,
  type AgentViewModel,
  type AgentViewState,
  type AgentPhase,
} from "./view-model.js";
export {
  applyTvTheme,
  tvThemeCss,
  tvThemeOptionsFromUrl,
  TV_PALETTE,
  TV_FONT,
  type TvThemeOptions,
} from "./theme.js";
export { formatToolCall, truncate } from "./format.js";
export { wrapLines } from "./wrap.js";
