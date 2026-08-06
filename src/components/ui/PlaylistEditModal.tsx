import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { t } from "../../i18n";

type PlaylistEditModalProps = {
  isOpen: boolean;
  value: string;
  onChange: (value: string) => void;
  onClose: () => void;
  onSubmit: () => void;
  title?: string;
  subtitle?: string;
  placeholder?: string;
  submitLabel?: string;
};

export const PlaylistEditModal = ({
  isOpen,
  value,
  onChange,
  onClose,
  onSubmit,
  title,
  subtitle,
  placeholder,
  submitLabel,
}: PlaylistEditModalProps) => {
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (!isOpen) {
      return;
    }

    const focusId = window.setTimeout(() => {
      inputRef.current?.focus();
      inputRef.current?.select();
    }, 0);

    return () => window.clearTimeout(focusId);
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen) {
      return;
    }

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [isOpen, onClose]);

  if (!isOpen || typeof document === "undefined") {
    return null;
  }

  return createPortal(
    <div
      className="modal-overlay-animate fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-[var(--spacing-lg)] backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="modal-panel-animate w-full max-w-[360px] rounded-[var(--radius-lg)] border border-[var(--color-border)] bg-[var(--color-bg-primary)] p-[var(--spacing-lg)] shadow-[var(--shadow-lg)]"
        onClick={(event) => event.stopPropagation()}
      >
        <h2 className="text-[var(--font-size-md)] font-semibold text-[var(--color-text-primary)]">
          {title ?? t("playlist.edit.title")}
        </h2>
        <p className="mt-[var(--spacing-xs)] text-[var(--font-size-xs)] text-[var(--color-text-muted)]">
          {subtitle ?? t("playlist.edit.subtitle")}
        </p>
        <form
          className="mt-[var(--spacing-md)] space-y-[var(--spacing-md)]"
          onSubmit={(event) => {
            event.preventDefault();
            onSubmit();
          }}
        >
          <input
            ref={inputRef}
            className="w-full rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-bg-secondary)] px-[var(--spacing-md)] py-[var(--spacing-sm)] text-[var(--font-size-sm)] text-[var(--color-text-primary)] placeholder:text-[var(--color-text-muted)] focus:outline-none focus:ring-2 focus:ring-[var(--color-accent)]"
            placeholder={placeholder ?? t("playlist.edit.placeholder")}
            value={value}
            onChange={(event) => onChange(event.target.value)}
            type="text"
          />
          <div className="flex items-center justify-end gap-[var(--spacing-sm)]">
            <button
              className="rounded-[var(--radius-md)] px-[var(--spacing-md)] py-[var(--spacing-sm)] text-[var(--font-size-sm)] font-medium text-[var(--color-text-secondary)] transition-colors hover:text-[var(--color-text-primary)]"
              onClick={onClose}
              type="button"
            >
              {t("playlist.edit.cancel")}
            </button>
            <button
              className="rounded-[var(--radius-md)] bg-[var(--color-accent)] px-[var(--spacing-md)] py-[var(--spacing-sm)] text-[var(--font-size-sm)] font-semibold text-white transition-colors hover:bg-[var(--color-accent-hover)] disabled:cursor-not-allowed disabled:opacity-60"
              disabled={!value.trim()}
              type="submit"
            >
              {submitLabel ?? t("playlist.edit.submit")}
            </button>
          </div>
        </form>
      </div>
    </div>,
    document.body
  );
};
