export type ShortcutAction =
  | "togglePlay"
  | "previous"
  | "next"
  | "seekBackward"
  | "seekForward"
  | "volumeUp"
  | "volumeDown"
  | "mute"
  | "shuffle"
  | "repeat"
  | "rate0"
  | "rate1"
  | "rate2"
  | "rate3"
  | "rate4"
  | "rate5"
  | "queue"
  | "playNext"
  | "remove"
  | "undo"
  | "redo"
  | "help"
  | "commandPalette"
  | "focusSearch"
  | "selectAll"
  | "playSelected"
  | "clearSelection";

export type KeyboardShortcutMap = Record<ShortcutAction, string>;

export const DEFAULT_KEYBOARD_SHORTCUTS: KeyboardShortcutMap = {
  togglePlay: "Space",
  previous: "ArrowLeft",
  next: "ArrowRight",
  seekBackward: "Mod+ArrowLeft",
  seekForward: "Mod+ArrowRight",
  volumeUp: "ArrowUp",
  volumeDown: "ArrowDown",
  mute: "KeyM",
  shuffle: "KeyS",
  repeat: "KeyR",
  rate0: "Digit0",
  rate1: "Digit1",
  rate2: "Digit2",
  rate3: "Digit3",
  rate4: "Digit4",
  rate5: "Digit5",
  queue: "KeyQ",
  playNext: "KeyN",
  remove: "Delete",
  undo: "Mod+KeyZ",
  redo: "Mod+Shift+KeyZ",
  help: "Shift+Slash",
  commandPalette: "Mod+Shift+KeyP",
  focusSearch: "Mod+KeyF",
  selectAll: "Mod+KeyA",
  playSelected: "Enter",
  clearSelection: "Escape",
};

export const SHORTCUT_DEFINITIONS: Array<{
  action: ShortcutAction;
  label: string;
  group: "Playback" | "Selection" | "Library";
}> = [
  { action: "togglePlay", label: "Toggle play / pause", group: "Playback" },
  { action: "previous", label: "Previous track", group: "Playback" },
  { action: "next", label: "Next track", group: "Playback" },
  { action: "seekBackward", label: "Seek backward 5 seconds", group: "Playback" },
  { action: "seekForward", label: "Seek forward 5 seconds", group: "Playback" },
  { action: "volumeUp", label: "Volume up", group: "Playback" },
  { action: "volumeDown", label: "Volume down", group: "Playback" },
  { action: "mute", label: "Mute", group: "Playback" },
  { action: "shuffle", label: "Toggle shuffle", group: "Playback" },
  { action: "repeat", label: "Cycle repeat", group: "Playback" },
  { action: "rate0", label: "Clear rating", group: "Selection" },
  { action: "rate1", label: "Rate 1", group: "Selection" },
  { action: "rate2", label: "Rate 2", group: "Selection" },
  { action: "rate3", label: "Rate 3", group: "Selection" },
  { action: "rate4", label: "Rate 4", group: "Selection" },
  { action: "rate5", label: "Rate 5", group: "Selection" },
  { action: "queue", label: "Add selection to queue", group: "Selection" },
  { action: "playNext", label: "Play selection next", group: "Selection" },
  { action: "remove", label: "Remove selection", group: "Selection" },
  { action: "selectAll", label: "Select all tracks", group: "Selection" },
  { action: "playSelected", label: "Play selected track", group: "Selection" },
  { action: "clearSelection", label: "Clear selection", group: "Selection" },
  { action: "focusSearch", label: "Focus search", group: "Library" },
  { action: "commandPalette", label: "Open command palette", group: "Library" },
  { action: "undo", label: "Undo", group: "Library" },
  { action: "redo", label: "Redo", group: "Library" },
  { action: "help", label: "Show keyboard shortcuts", group: "Library" },
];

const modifierCodes = new Set([
  "ControlLeft", "ControlRight", "MetaLeft", "MetaRight",
  "AltLeft", "AltRight", "ShiftLeft", "ShiftRight",
]);

type KeyboardEventLike = Pick<
  KeyboardEvent,
  "code" | "metaKey" | "ctrlKey" | "altKey" | "shiftKey"
>;

export const shortcutFromEvent = (event: KeyboardEventLike): string | null => {
  if (modifierCodes.has(event.code)) return null;
  const parts: string[] = [];
  if (event.metaKey || event.ctrlKey) parts.push("Mod");
  if (event.altKey) parts.push("Alt");
  if (event.shiftKey) parts.push("Shift");
  parts.push(event.code);
  return parts.join("+");
};

export const matchesShortcut = (
  event: KeyboardEventLike,
  shortcut: string | undefined,
) => {
  if (!shortcut) return false;
  return shortcutFromEvent(event) === shortcut;
};

const friendlyCode = (code: string) => {
  if (code.startsWith("Key")) return code.slice(3);
  if (code.startsWith("Digit")) return code.slice(5);
  if (code.startsWith("Numpad")) return code.slice(6);
  const labels: Record<string, string> = {
    ArrowLeft: "←",
    ArrowRight: "→",
    ArrowUp: "↑",
    ArrowDown: "↓",
    Space: "Space",
    Escape: "Esc",
    Delete: "Delete",
    Backspace: "Backspace",
    Enter: "Enter",
    Slash: "/",
  };
  return labels[code] ?? code;
};

export const shortcutDisplayParts = (shortcut: string) =>
  shortcut.split("+").map((part) => {
    if (part === "Mod") return window.muro?.platform === "darwin" ? "⌘" : "Ctrl";
    if (part === "Shift") return "⇧";
    if (part === "Alt") return window.muro?.platform === "darwin" ? "⌥" : "Alt";
    return friendlyCode(part);
  });

export const shortcutDisplay = (shortcut: string) =>
  shortcutDisplayParts(shortcut).join("+");

export const normalizeShortcutMap = (
  candidate: Partial<KeyboardShortcutMap> | undefined,
): KeyboardShortcutMap => Object.fromEntries(
  Object.entries(DEFAULT_KEYBOARD_SHORTCUTS).map(([action, fallback]) => [
    action,
    typeof candidate?.[action as ShortcutAction] === "string"
      ? candidate[action as ShortcutAction]
      : fallback,
  ]),
) as KeyboardShortcutMap;
