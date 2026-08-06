import { useEffect } from "react";
import { createPortal } from "react-dom";
import { FolderSearch, Link2 } from "lucide-react";
import { t } from "../../i18n";
import type { MissingTrack } from "../../hooks/useLibraryVerification";

type MissingTracksModalProps = {
  isOpen: boolean;
  tracks: MissingTrack[];
  relinking: boolean;
  onClose: () => void;
  onRelinkTrack: (trackId: string) => void;
  onAutoRelink: () => void;
};

export const MissingTracksModal = ({
  isOpen,
  tracks,
  relinking,
  onClose,
  onRelinkTrack,
  onAutoRelink,
}: MissingTracksModalProps) => {
  useEffect(() => {
    if (!isOpen) return;

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
        className="modal-panel-animate flex max-h-[80vh] w-full max-w-[720px] flex-col rounded-[var(--radius-lg)] border border-[var(--color-border)] bg-[var(--color-bg-primary)] shadow-[var(--shadow-lg)]"
        onClick={(event) => event.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label={t("verify.missing.title")}
      >
        <div className="p-[var(--spacing-lg)]">
          <h2 className="text-[var(--font-size-md)] font-semibold text-[var(--color-text-primary)]">
            {t("verify.missing.title")}
          </h2>
          <p className="mt-[var(--spacing-xs)] text-[var(--font-size-xs)] leading-relaxed text-[var(--color-text-muted)]">
            {t("verify.missing.subtitle", { count: String(tracks.length) })}
          </p>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto border-y border-[var(--color-border)] px-[var(--spacing-lg)] py-[var(--spacing-md)]">
          {tracks.length === 0 ? (
            <p className="py-6 text-center text-[var(--font-size-sm)] text-[var(--color-text-muted)]">
              {t("verify.missing.empty")}
            </p>
          ) : (
            <ul className="space-y-[var(--spacing-sm)]">
              {tracks.map((track) => (
                <li
                  key={track.id}
                  className="flex items-center gap-[var(--spacing-md)] rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-bg-secondary)] px-[var(--spacing-md)] py-[var(--spacing-sm)]"
                >
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[var(--font-size-sm)] font-medium text-[var(--color-text-primary)]">
                      {track.title || track.filename}
                    </span>
                    <span className="block truncate text-[var(--font-size-xs)] text-[var(--color-text-muted)]">
                      {track.artist}
                      {track.album ? ` · ${track.album}` : ""}
                    </span>
                    <span
                      className="mt-0.5 block truncate text-[10px] text-[var(--color-text-muted)]"
                      title={track.source_path}
                    >
                      {track.source_path}
                    </span>
                  </span>
                  <button
                    className="flex shrink-0 items-center gap-1.5 rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-bg-tertiary)] px-[var(--spacing-md)] py-[var(--spacing-xs)] text-[var(--font-size-xs)] font-medium text-[var(--color-text-primary)] transition-colors hover:bg-[var(--color-bg-hover)]"
                    onClick={() => onRelinkTrack(track.id)}
                    type="button"
                  >
                    <Link2 className="h-3.5 w-3.5" />
                    {t("verify.missing.locate")}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="flex items-center justify-between gap-[var(--spacing-sm)] p-[var(--spacing-lg)]">
          <button
            className="flex items-center gap-1.5 rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-bg-tertiary)] px-[var(--spacing-md)] py-[var(--spacing-sm)] text-[var(--font-size-sm)] font-medium text-[var(--color-text-primary)] transition-colors hover:bg-[var(--color-bg-hover)] disabled:cursor-not-allowed disabled:opacity-60"
            disabled={relinking || tracks.length === 0}
            onClick={onAutoRelink}
            type="button"
          >
            <FolderSearch className="h-4 w-4" />
            {relinking ? t("verify.autoRelink.running") : t("verify.autoRelink")}
          </button>
          <button
            className="rounded-[var(--radius-md)] bg-[var(--color-accent)] px-[var(--spacing-md)] py-[var(--spacing-sm)] text-[var(--font-size-sm)] font-semibold text-white transition-colors hover:bg-[var(--color-accent-hover)]"
            onClick={onClose}
            type="button"
          >
            {t("verify.missing.close")}
          </button>
        </div>
      </div>
    </div>,
    document.body
  );
};
