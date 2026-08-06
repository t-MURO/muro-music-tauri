import { useState } from "react";
import {
  shortcutDisplay,
  shortcutFromEvent,
  SHORTCUT_DEFINITIONS,
  type ShortcutAction,
} from "../../keyboard/shortcuts";
import { useSettingsStore } from "../../stores";

const buttonClass =
  "rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-bg-secondary)] px-3 py-2 text-[12px] font-semibold text-[var(--color-text-primary)] hover:bg-[var(--color-bg-hover)]";

export const KeyboardShortcutSettings = () => {
  const shortcuts = useSettingsStore((state) => state.keyboardShortcuts);
  const resetKeyboardShortcuts = useSettingsStore((state) => state.resetKeyboardShortcuts);
  const [recording, setRecording] = useState<ShortcutAction | null>(null);

  const assignShortcut = (action: ShortcutAction, shortcut: string) => {
    useSettingsStore.setState((state) => {
      const previous = state.keyboardShortcuts[action];
      const conflict = SHORTCUT_DEFINITIONS.find(
        (item) => item.action !== action && state.keyboardShortcuts[item.action] === shortcut,
      )?.action;
      return {
        keyboardShortcuts: {
          ...state.keyboardShortcuts,
          [action]: shortcut,
          ...(conflict ? { [conflict]: previous } : {}),
        },
      };
    });
  };

  return (
    <section className="rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-bg-primary)] p-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h4 className="text-[13px] font-semibold text-[var(--color-text-primary)]">
            Keyboard shortcuts
          </h4>
          <p className="mt-1 text-[12px] text-[var(--color-text-secondary)]">
            Select a shortcut, then press a new key combination. Conflicting shortcuts swap.
          </p>
        </div>
        <button className={buttonClass} onClick={resetKeyboardShortcuts} type="button">
          Reset defaults
        </button>
      </div>
      <div className="mt-4 grid gap-2 md:grid-cols-2">
        {SHORTCUT_DEFINITIONS.map((definition) => (
          <div key={definition.action} className="flex items-center justify-between gap-3 rounded border border-[var(--color-border-light)] px-3 py-2">
            <span className="min-w-0">
              <span className="block truncate text-[12px] text-[var(--color-text-primary)]">{definition.label}</span>
              <span className="text-[10px] uppercase tracking-wide text-[var(--color-text-muted)]">{definition.group}</span>
            </span>
            <button
              className={`${buttonClass} min-w-24 tabular-nums ${recording === definition.action ? "border-[var(--color-accent)] text-[var(--color-accent)]" : ""}`}
              onClick={() => setRecording(definition.action)}
              onBlur={() => setRecording(null)}
              onKeyDown={(event) => {
                if (recording !== definition.action) return;
                event.preventDefault();
                event.stopPropagation();
                const shortcut = shortcutFromEvent(event.nativeEvent);
                if (!shortcut) return;
                assignShortcut(definition.action, shortcut);
                setRecording(null);
              }}
              type="button"
            >
              {recording === definition.action ? "Press keys…" : shortcutDisplay(shortcuts[definition.action])}
            </button>
          </div>
        ))}
      </div>
    </section>
  );
};
