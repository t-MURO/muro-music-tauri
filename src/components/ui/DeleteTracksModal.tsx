import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { HardDrive, Library, Trash2 } from "lucide-react";
import { t } from "../../i18n";
import type { DeleteMode } from "../../stores";
import type { Track } from "../../types";

type DeleteTracksModalProps = {
  tracks: Track[];
  isDeleting: boolean;
  preferredMode: DeleteMode;
  onClose: () => void;
  onRemoveFromLibrary: () => void;
  onDeleteFromDisk: () => void;
};

export const DeleteTracksModal = ({
  tracks,
  isDeleting,
  preferredMode,
  onClose,
  onRemoveFromLibrary,
  onDeleteFromDisk,
}: DeleteTracksModalProps) => {
  const libraryButtonRef = useRef<HTMLButtonElement | null>(null);
  const diskButtonRef = useRef<HTMLButtonElement | null>(null);
  const isOpen = tracks.length > 0;

  useEffect(() => {
    if (!isOpen) return;
    const focusId = window.setTimeout(() => {
      if (preferredMode === "disk") diskButtonRef.current?.focus();
      else libraryButtonRef.current?.focus();
    }, 0);
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !isDeleting) {
        event.preventDefault();
        onClose();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.clearTimeout(focusId);
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [isDeleting, isOpen, onClose, preferredMode]);

  if (!isOpen || typeof document === "undefined") return null;

  return createPortal(
    <div
      className="modal-overlay-animate fixed inset-0 z-50 flex items-center justify-center bg-black/45 p-[var(--spacing-lg)] backdrop-blur-sm"
      data-delete-tracks-modal
      onClick={() => {
        if (!isDeleting) onClose();
      }}
    >
      <div
        className="modal-panel-animate w-full max-w-[520px] rounded-[var(--radius-lg)] border border-[var(--color-border)] bg-[var(--color-bg-primary)] shadow-[var(--shadow-lg)]"
        onClick={(event) => event.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-labelledby="delete-tracks-title"
      >
        <div className="border-b border-[var(--color-border)] p-[var(--spacing-lg)]">
          <div className="flex items-center gap-3">
            <span className="flex h-9 w-9 items-center justify-center rounded-full bg-red-500/10 text-red-500">
              <Trash2 className="h-4 w-4" />
            </span>
            <div>
              <h2 id="delete-tracks-title" className="text-[var(--font-size-md)] font-semibold text-[var(--color-text-primary)]">
                {t("delete.title")}
              </h2>
              <p className="mt-0.5 text-[var(--font-size-xs)] text-[var(--color-text-muted)]">
                {t("delete.subtitle", { count: String(tracks.length) })}
              </p>
            </div>
          </div>
          <div className="mt-4 max-h-24 overflow-y-auto rounded-[var(--radius-md)] bg-[var(--color-bg-secondary)] px-3 py-2 text-[var(--font-size-xs)] text-[var(--color-text-secondary)]">
            {tracks.slice(0, 5).map((track) => (
              <div key={track.id} className="truncate">
                {track.title} — {track.artist}
              </div>
            ))}
            {tracks.length > 5 && (
              <div className="mt-1 text-[var(--color-text-muted)]">+{tracks.length - 5} more</div>
            )}
          </div>
        </div>

        <div className="grid gap-3 p-[var(--spacing-lg)] sm:grid-cols-2">
          <button
            ref={libraryButtonRef}
            className={`group rounded-[var(--radius-lg)] border bg-[var(--color-bg-secondary)] p-4 text-left transition-colors hover:border-[var(--color-accent)] hover:bg-[var(--color-bg-hover)] focus:outline-none disabled:cursor-not-allowed disabled:opacity-50 ${
              preferredMode === "library"
                ? "border-[var(--color-accent)] ring-2 ring-[var(--color-accent-light)]"
                : "border-[var(--color-border)]"
            }`}
            data-delete-library-only
            data-delete-preferred={preferredMode === "library" ? "true" : undefined}
            disabled={isDeleting}
            onClick={onRemoveFromLibrary}
            type="button"
          >
            <Library className="mb-3 h-5 w-5 text-[var(--color-accent)]" />
            <div className="text-[var(--font-size-sm)] font-semibold text-[var(--color-text-primary)]">
              {isDeleting ? t("delete.working") : t("delete.libraryOnly")}
            </div>
            <div className="mt-1 text-[var(--font-size-xs)] leading-relaxed text-[var(--color-text-muted)]">
              {t("delete.libraryOnly.help")}
            </div>
          </button>
          <button
            ref={diskButtonRef}
            className={`group rounded-[var(--radius-lg)] border bg-red-500/5 p-4 text-left transition-colors hover:border-red-500/60 hover:bg-red-500/10 focus:outline-none disabled:cursor-not-allowed disabled:opacity-50 ${
              preferredMode === "disk"
                ? "border-red-500 ring-2 ring-red-500/20"
                : "border-red-500/30"
            }`}
            data-delete-from-disk
            data-delete-preferred={preferredMode === "disk" ? "true" : undefined}
            disabled={isDeleting}
            onClick={onDeleteFromDisk}
            type="button"
          >
            <HardDrive className="mb-3 h-5 w-5 text-red-500" />
            <div className="text-[var(--font-size-sm)] font-semibold text-red-500">
              {isDeleting ? t("delete.working") : t("delete.disk")}
            </div>
            <div className="mt-1 text-[var(--font-size-xs)] leading-relaxed text-[var(--color-text-muted)]">
              {t("delete.disk.help")}
            </div>
          </button>
        </div>

        <div className="flex justify-end border-t border-[var(--color-border)] px-[var(--spacing-lg)] py-[var(--spacing-md)]">
          <button
            className="rounded-[var(--radius-md)] px-[var(--spacing-md)] py-[var(--spacing-sm)] text-[var(--font-size-sm)] font-medium text-[var(--color-text-secondary)] transition-colors hover:text-[var(--color-text-primary)] disabled:opacity-50"
            disabled={isDeleting}
            onClick={onClose}
            type="button"
          >
            {t("delete.cancel")}
          </button>
        </div>
      </div>
    </div>,
    document.body
  );
};
