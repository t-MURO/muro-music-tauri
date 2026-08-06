import { useEffect, useRef } from "react";
import { matchesShortcut } from "../keyboard/shortcuts";
import { useSettingsStore } from "../stores";

const SEEK_STEP_SECONDS = 5;
const VOLUME_STEP = 0.05;

export type KeyboardShortcutHandlers = {
  onTogglePlay: () => void;
  onSkipPrevious: () => void;
  onSkipNext: () => void;
  onSeek: (position: number) => void;
  currentPosition: number;
  volume: number;
  onSetVolume: (volume: number) => void;
  onToggleMute: () => void;
  onToggleShuffle: () => void;
  onCycleRepeat: () => void;
  onRateSelection: (rating: number) => void;
  onQueueSelection: () => void;
  onPlaySelectionNext: () => void;
  onDeleteSelection: () => void;
  onToggleShortcutHelp: () => void;
  onUndo: () => void;
  onRedo: () => void;
  onOpenCommandPalette: () => void;
};

const isTextEntry = (target: EventTarget | null) => {
  const element = target as HTMLElement | null;
  return Boolean(element && (
    element.tagName === "INPUT"
    || element.tagName === "TEXTAREA"
    || element.tagName === "SELECT"
    || element.isContentEditable
  ));
};

const isTrackTableFocused = (target: EventTarget | null) => {
  const element = target as HTMLElement | null;
  return Boolean(element?.closest?.("[data-track-table-scroll]"));
};

const isBlockingModalOpen = () =>
  document.querySelector(".modal-overlay-animate") !== null;

export const useKeyboardShortcuts = (handlers: KeyboardShortcutHandlers) => {
  const shortcuts = useSettingsStore((state) => state.keyboardShortcuts);
  const handlersRef = useRef(handlers);
  useEffect(() => {
    handlersRef.current = handlers;
  });

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;
      const current = handlersRef.current;
      const typing = isTextEntry(event.target);

      if (!typing && matchesShortcut(event, shortcuts.commandPalette)) {
        event.preventDefault();
        current.onOpenCommandPalette();
        return;
      }
      if (!typing && matchesShortcut(event, shortcuts.undo)) {
        event.preventDefault();
        current.onUndo();
        return;
      }
      if (!typing && matchesShortcut(event, shortcuts.redo)) {
        event.preventDefault();
        current.onRedo();
        return;
      }
      if (typing || isBlockingModalOpen()) return;

      const tableFocused = isTrackTableFocused(event.target);
      const run = (
        action: keyof typeof shortcuts,
        callback: () => void,
        blockedInTable = false,
      ) => {
        if (!matchesShortcut(event, shortcuts[action]) || (blockedInTable && tableFocused)) {
          return false;
        }
        event.preventDefault();
        callback();
        return true;
      };

      if (run("togglePlay", current.onTogglePlay, true)) return;
      if (run("previous", current.onSkipPrevious)) return;
      if (run("next", current.onSkipNext)) return;
      if (run("seekBackward", () =>
        current.onSeek(Math.max(0, current.currentPosition - SEEK_STEP_SECONDS)))) return;
      if (run("seekForward", () =>
        current.onSeek(current.currentPosition + SEEK_STEP_SECONDS))) return;
      if (run("volumeUp", () =>
        current.onSetVolume(Math.min(1, current.volume + VOLUME_STEP)), true)) return;
      if (run("volumeDown", () =>
        current.onSetVolume(Math.max(0, current.volume - VOLUME_STEP)), true)) return;
      if (run("remove", current.onDeleteSelection)) return;
      if (run("mute", current.onToggleMute)) return;
      if (run("shuffle", current.onToggleShuffle)) return;
      if (run("repeat", current.onCycleRepeat)) return;
      if (run("queue", current.onQueueSelection)) return;
      if (run("playNext", current.onPlaySelectionNext)) return;
      if (run("help", current.onToggleShortcutHelp)) return;
      for (let rating = 0; rating <= 5; rating += 1) {
        if (
          run(
            `rate${rating}` as keyof typeof shortcuts,
            () => current.onRateSelection(rating),
          )
        ) return;
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [shortcuts]);
};
