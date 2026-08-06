import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { Replace } from "lucide-react";
import type { ArtistSeparatorCandidate } from "../../lib/metadata/artistSeparators";

type ArtistSeparatorReviewModalProps = {
  candidate: ArtistSeparatorCandidate | null;
  position: number;
  total: number;
  isApplying: boolean;
  onApply: (artist: string) => Promise<void>;
  onSaveException: () => void;
  onSkip: () => void;
  onClose: () => void;
};

export const ArtistSeparatorReviewModal = ({
  candidate,
  position,
  total,
  isApplying,
  onApply,
  onSaveException,
  onSkip,
  onClose,
}: ArtistSeparatorReviewModalProps) => {
  const [artist, setArtist] = useState("");

  useEffect(() => {
    setArtist(candidate?.proposedValue ?? "");
  }, [candidate]);

  useEffect(() => {
    if (!candidate) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !isApplying) onClose();
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [candidate, isApplying, onClose]);

  if (!candidate || typeof document === "undefined") return null;

  const normalizedArtist = artist.trim();
  const fieldLabel = candidate.field === "albumArtist" ? "Album artist" : "Artist";
  const canApply = (
    !isApplying &&
    normalizedArtist.length > 0 &&
    normalizedArtist !== candidate.originalValue.trim()
  );

  return createPortal(
    <div
      className="modal-overlay-animate fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-[var(--spacing-lg)] backdrop-blur-sm"
      onClick={() => { if (!isApplying) onClose(); }}
      data-artist-separator-modal
    >
      <div
        className="modal-panel-animate flex w-full max-w-[620px] flex-col overflow-hidden rounded-[var(--radius-lg)] border border-[var(--color-border)] bg-[var(--color-bg-primary)] shadow-[var(--shadow-lg)]"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex items-start gap-3 border-b border-[var(--color-border)] p-5">
          <Replace className="mt-0.5 h-5 w-5 shrink-0 text-[var(--color-accent)]" />
          <div className="min-w-0">
            <h2 className="text-[15px] font-semibold text-[var(--color-text-primary)]">
              Review artist separators
            </h2>
            <p className="mt-1 text-[11px] text-[var(--color-text-muted)]">
              Track {position} of {total}
            </p>
          </div>
        </div>

        <div className="space-y-5 p-5">
          <div className="min-w-0">
            <p className="truncate text-[13px] font-semibold text-[var(--color-text-primary)]">
              {candidate.title}
            </p>
            <p className="mt-1 truncate text-[11px] text-[var(--color-text-muted)]">
              {candidate.album || "Unknown album"}
            </p>
          </div>

          <div className="grid grid-cols-[112px_minmax(0,1fr)] items-center gap-3 rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-bg-secondary)] p-3 text-[11px]">
            <span
              className="font-semibold text-[var(--color-text-muted)]"
              data-artist-separator-field
            >
              {fieldLabel}
            </span>
            <span
              className="truncate text-[var(--color-text-secondary)]"
              title={candidate.originalValue}
              data-artist-separator-current
            >
              {candidate.originalValue}
            </span>
          </div>

          <label className="block">
            <span className="mb-2 block text-[11px] font-semibold text-[var(--color-text-secondary)]">
              Comma-separated {fieldLabel.toLocaleLowerCase()}
            </span>
            <input
              autoFocus
              className="h-[var(--input-height)] w-full rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-bg-tertiary)] px-[var(--spacing-md)] text-[var(--font-size-sm)] text-[var(--color-text-primary)] focus:border-[var(--color-accent)] focus:outline-none focus:ring-4 focus:ring-[var(--color-accent-light)]"
              value={artist}
              onChange={(event) => setArtist(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && canApply) void onApply(normalizedArtist);
              }}
              data-artist-separator-proposed
            />
          </label>

          <p className="text-[10px] leading-relaxed text-[var(--color-text-muted)]">
            Applying updates Muro’s database and attempts to update the artist tag in the source
            audio file. Skip ignores only this occurrence; Save exception ignores this exact name
            in future scans everywhere it appears.
          </p>
        </div>

        <div className="flex items-center gap-2 border-t border-[var(--color-border)] p-4">
          <button
            type="button"
            className="px-3 py-2 text-[12px] text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)]"
            disabled={isApplying}
            onClick={onClose}
          >
            Close
          </button>
          <button
            type="button"
            className="ml-auto rounded-[var(--radius-md)] border border-[var(--color-border)] px-4 py-2 text-[12px] font-medium text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-hover)] disabled:opacity-50"
            disabled={isApplying}
            onClick={onSaveException}
            data-artist-separator-exception
          >
            Save exception
          </button>
          <button
            type="button"
            className="rounded-[var(--radius-md)] border border-[var(--color-border)] px-4 py-2 text-[12px] font-medium text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-hover)] disabled:opacity-50"
            disabled={isApplying}
            onClick={onSkip}
            data-artist-separator-skip
          >
            Skip
          </button>
          <button
            type="button"
            className="rounded-[var(--radius-md)] bg-[var(--color-accent)] px-4 py-2 text-[12px] font-semibold text-white disabled:opacity-50"
            disabled={!canApply}
            onClick={() => { void onApply(normalizedArtist); }}
            data-artist-separator-apply
          >
            {isApplying ? "Applying…" : position === total ? "Apply" : "Apply & next"}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
};
