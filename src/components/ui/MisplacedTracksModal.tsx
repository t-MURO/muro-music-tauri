import { useEffect } from "react";
import { createPortal } from "react-dom";
import { ArrowRight, FolderTree, LoaderCircle } from "lucide-react";
import { t } from "../../i18n";
import type { LibraryStructureIssue } from "../../utils/database";

type MisplacedTracksModalProps = {
  isOpen: boolean;
  tracks: LibraryStructureIssue[];
  repairing: boolean;
  onClose: () => void;
  onRepair: () => void;
};

export const MisplacedTracksModal = ({
  isOpen,
  tracks,
  repairing,
  onClose,
  onRepair,
}: MisplacedTracksModalProps) => {
  useEffect(() => {
    if (!isOpen) return;

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !repairing) {
        event.preventDefault();
        onClose();
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [isOpen, onClose, repairing]);

  if (!isOpen || typeof document === "undefined") {
    return null;
  }

  return createPortal(
    <div
      className="modal-overlay-animate fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-[var(--spacing-lg)] backdrop-blur-sm"
      data-library-structure-modal
      onPointerDown={(event) => {
        if (
          !repairing &&
          event.target === event.currentTarget &&
          event.button === 0
        ) {
          onClose();
        }
      }}
    >
      <div
        aria-label={t("structure.modal.title")}
        aria-modal="true"
        className="modal-panel-animate flex max-h-[82vh] w-full max-w-[780px] flex-col rounded-[var(--radius-lg)] border border-[var(--color-border)] bg-[var(--color-bg-primary)] shadow-[var(--shadow-lg)]"
        role="dialog"
      >
        <div className="p-[var(--spacing-lg)]">
          <h2 className="text-[var(--font-size-md)] font-semibold text-[var(--color-text-primary)]">
            {t("structure.modal.title")}
          </h2>
          <p className="mt-[var(--spacing-xs)] text-[var(--font-size-xs)] leading-relaxed text-[var(--color-text-muted)]">
            {t("structure.modal.subtitle", { count: String(tracks.length) })}
          </p>
        </div>

        <div
          className="min-h-0 flex-1 overflow-y-auto border-y border-[var(--color-border)] px-[var(--spacing-lg)] py-[var(--spacing-md)]"
          data-library-structure-results
        >
          <ul className="space-y-[var(--spacing-sm)]">
            {tracks.map((track) => (
              <li
                className="rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-bg-secondary)] px-[var(--spacing-md)] py-[var(--spacing-sm)]"
                data-library-structure-track={track.trackId}
                key={track.trackId}
              >
                <span className="block truncate text-[var(--font-size-sm)] font-medium text-[var(--color-text-primary)]">
                  {track.title || track.filename}
                </span>
                <span className="block truncate text-[var(--font-size-xs)] text-[var(--color-text-muted)]">
                  {track.artist || t("structure.unknownArtist")}
                  {track.album ? " · " + track.album : ""}
                </span>
                <div className="mt-2 grid gap-1.5 text-[10px] text-[var(--color-text-muted)] sm:grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] sm:items-center">
                  <span className="min-w-0">
                    <span className="block font-semibold uppercase tracking-wide">
                      {t("structure.currentFolder")}
                    </span>
                    <span
                      className="block truncate"
                      data-library-structure-current-path
                      title={track.currentFolder}
                    >
                      {track.currentFolder}
                    </span>
                  </span>
                  <ArrowRight className="hidden h-3.5 w-3.5 sm:block" />
                  <span className="min-w-0">
                    <span className="block font-semibold uppercase tracking-wide">
                      {t("structure.expectedFolder")}
                    </span>
                    <span
                      className="block truncate"
                      data-library-structure-expected-path
                      title={track.expectedFolder}
                    >
                      {track.expectedFolder}
                    </span>
                  </span>
                </div>
              </li>
            ))}
          </ul>
        </div>

        <div className="flex flex-wrap items-center justify-end gap-[var(--spacing-sm)] p-[var(--spacing-lg)]">
          <button
            className="rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-bg-tertiary)] px-[var(--spacing-md)] py-[var(--spacing-sm)] text-[var(--font-size-sm)] font-medium text-[var(--color-text-primary)] transition-colors hover:bg-[var(--color-bg-hover)] disabled:cursor-not-allowed disabled:opacity-60"
            data-library-structure-close
            disabled={repairing}
            onClick={onClose}
            type="button"
          >
            {t("structure.close")}
          </button>
          <button
            className="flex items-center gap-1.5 rounded-[var(--radius-md)] bg-[var(--color-accent)] px-[var(--spacing-md)] py-[var(--spacing-sm)] text-[var(--font-size-sm)] font-semibold text-white transition-colors hover:bg-[var(--color-accent-hover)] disabled:cursor-not-allowed disabled:opacity-60"
            data-repair-library-structure
            disabled={repairing || tracks.length === 0}
            onClick={onRepair}
            type="button"
          >
            {repairing
              ? <LoaderCircle className="h-4 w-4 animate-spin" />
              : <FolderTree className="h-4 w-4" />}
            {repairing ? t("structure.repairing") : t("structure.repair")}
          </button>
        </div>
      </div>
    </div>,
    document.body
  );
};
