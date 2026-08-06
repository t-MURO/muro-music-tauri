import { useEffect } from "react";
import { createPortal } from "react-dom";
import { t } from "../../i18n";
import {
  matchesShortcut,
  shortcutDisplayParts,
  SHORTCUT_DEFINITIONS,
} from "../../keyboard/shortcuts";
import { useSettingsStore } from "../../stores";

type ShortcutHelpModalProps = {
  isOpen: boolean;
  onClose: () => void;
};

export const ShortcutHelpModal = ({ isOpen, onClose }: ShortcutHelpModalProps) => {
  const shortcuts = useSettingsStore((state) => state.keyboardShortcuts);

  useEffect(() => {
    if (!isOpen) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" || matchesShortcut(event, shortcuts.help)) {
        event.preventDefault();
        onClose();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [isOpen, onClose, shortcuts]);

  if (!isOpen || typeof document === "undefined") return null;
  const groups = ["Playback", "Selection", "Library"] as const;

  return createPortal(
    <div
      className="modal-overlay-animate fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-[var(--spacing-lg)] backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="modal-panel-animate flex max-h-[80vh] w-full max-w-[720px] flex-col rounded-[var(--radius-lg)] border border-[var(--color-border)] bg-[var(--color-bg-primary)] shadow-[var(--shadow-lg)]"
        onClick={(event) => event.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label={t("shortcuts.title")}
      >
        <div className="p-[var(--spacing-lg)]">
          <h2 className="text-[var(--font-size-md)] font-semibold text-[var(--color-text-primary)]">
            {t("shortcuts.title")}
          </h2>
          <p className="mt-[var(--spacing-xs)] text-[var(--font-size-xs)] text-[var(--color-text-muted)]">
            {t("shortcuts.subtitle")}
          </p>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto border-y border-[var(--color-border)] px-[var(--spacing-lg)] py-[var(--spacing-md)]">
          <div className="grid gap-[var(--spacing-lg)] sm:grid-cols-3">
            {groups.map((group) => (
              <section key={group}>
                <h3 className="mb-[var(--spacing-sm)] text-[10px] font-semibold uppercase tracking-[0.08em] text-[var(--color-text-muted)]">
                  {group}
                </h3>
                <ul className="space-y-[var(--spacing-xs)]">
                  {SHORTCUT_DEFINITIONS.filter((item) => item.group === group).map((item) => (
                    <li
                      key={item.action}
                      className="flex items-center justify-between gap-[var(--spacing-md)]"
                    >
                      <span className="text-[var(--font-size-sm)] text-[var(--color-text-secondary)]">
                        {item.label}
                      </span>
                      <span className="flex shrink-0 items-center gap-1">
                        {shortcutDisplayParts(shortcuts[item.action]).map((key, index) => (
                          <kbd
                            key={`${key}-${index}`}
                            className="rounded border border-[var(--color-border)] bg-[var(--color-bg-tertiary)] px-1.5 py-0.5 text-[10px] tabular-nums text-[var(--color-text-muted)]"
                          >
                            {key}
                          </kbd>
                        ))}
                      </span>
                    </li>
                  ))}
                </ul>
              </section>
            ))}
          </div>
        </div>
        <div className="flex items-center justify-end p-[var(--spacing-lg)]">
          <button
            className="rounded-[var(--radius-md)] bg-[var(--color-accent)] px-[var(--spacing-md)] py-[var(--spacing-sm)] text-[var(--font-size-sm)] font-semibold text-white"
            onClick={onClose}
            type="button"
          >
            {t("shortcuts.close")}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
};
