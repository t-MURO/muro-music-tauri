import { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { Check, ExternalLink, ImageIcon, LoaderCircle } from "lucide-react";
import { openExternal } from "../../desktop/shell";
import type { AlbumCoverCandidate } from "../../types";

type AlbumCoverPickerModalProps = {
  album: string;
  artist: string;
  candidates: AlbumCoverCandidate[];
  onApply: (candidate: AlbumCoverCandidate) => Promise<void>;
  onClose: () => void;
};

export const AlbumCoverPickerModal = ({
  album,
  artist,
  candidates,
  onApply,
  onClose,
}: AlbumCoverPickerModalProps) => {
  const [selectedId, setSelectedId] = useState<string | null>(candidates[0]?.id ?? null);
  const [failedImages, setFailedImages] = useState<Set<string>>(() => new Set());
  const [isApplying, setIsApplying] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setSelectedId(candidates[0]?.id ?? null);
    setFailedImages(new Set());
    setError(null);
  }, [candidates]);

  const selected = useMemo(
    () => candidates.find((candidate) => candidate.id === selectedId) ?? null,
    [candidates, selectedId],
  );

  if (typeof document === "undefined") return null;

  const applySelected = async () => {
    if (!selected || isApplying) return;
    setIsApplying(true);
    setError(null);
    try {
      await onApply(selected);
      onClose();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "The album cover could not be loaded");
    } finally {
      setIsApplying(false);
    }
  };

  return createPortal(
    <div
      className="modal-overlay-animate fixed inset-0 z-[70] flex items-center justify-center bg-black/55 p-[var(--spacing-lg)] backdrop-blur-sm"
      data-album-cover-picker
      onClick={(event) => {
        event.stopPropagation();
        if (!isApplying) onClose();
      }}
    >
      <div
        className="modal-panel-animate flex max-h-[84vh] w-full max-w-[820px] flex-col overflow-hidden rounded-[var(--radius-lg)] border border-[var(--color-border)] bg-[var(--color-bg-primary)] shadow-[var(--shadow-lg)]"
        onClick={(event) => event.stopPropagation()}
      >
        <header className="flex items-start gap-3 border-b border-[var(--color-border)] p-5">
          <ImageIcon className="mt-0.5 h-5 w-5 shrink-0 text-[var(--color-accent)]" />
          <div className="min-w-0">
            <h2 className="text-[15px] font-semibold text-[var(--color-text-primary)]">Choose album cover</h2>
            <p className="mt-1 truncate text-[11px] text-[var(--color-text-muted)]">
              {[artist, album].filter(Boolean).join(" — ")}
            </p>
          </div>
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto p-4">
          <p className="mb-3 rounded-[var(--radius-md)] bg-amber-500/10 px-3 py-2 text-[10px] leading-relaxed text-amber-700 dark:text-amber-300">
            Brave web-image results may be copyrighted. Check the source and usage rights before selecting artwork.
          </p>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3" role="radiogroup" aria-label="Album cover candidates">
            {candidates.map((candidate) => {
              const isSelected = candidate.id === selectedId;
              const dimensions = candidate.width && candidate.height
                ? `${candidate.width} × ${candidate.height}`
                : null;
              return (
                <article
                  className={`relative overflow-hidden rounded-[var(--radius-md)] border transition-colors ${
                    isSelected
                      ? "border-[var(--color-accent)] bg-[var(--color-accent-light)]"
                      : "border-[var(--color-border)] bg-[var(--color-bg-secondary)] hover:border-[var(--color-text-muted)]"
                  }`}
                  data-album-cover-candidate
                  key={candidate.id}
                >
                  <button
                    aria-checked={isSelected}
                    className="block w-full text-left"
                    onClick={() => setSelectedId(candidate.id)}
                    role="radio"
                    type="button"
                  >
                    <span className="relative block aspect-square overflow-hidden bg-[var(--color-bg-tertiary)]">
                      {!failedImages.has(candidate.id) ? (
                        <img
                          alt={`${album} cover result from Brave Image Search`}
                          className="h-full w-full object-cover"
                          loading="lazy"
                          onError={() => setFailedImages((current) => new Set(current).add(candidate.id))}
                          src={candidate.imageUrl}
                        />
                      ) : (
                        <span className="flex h-full items-center justify-center text-[var(--color-text-muted)]">
                          <ImageIcon className="h-8 w-8" />
                        </span>
                      )}
                      {isSelected && (
                        <span className="absolute right-2 top-2 grid h-6 w-6 place-items-center rounded-full bg-[var(--color-accent)] text-white shadow-md">
                          <Check className="h-4 w-4" />
                        </span>
                      )}
                    </span>
                    <span className="block p-2.5">
                      <strong className="block truncate text-[11px] text-[var(--color-text-primary)]">
                        {candidate.title || "Brave Image Search"}
                      </strong>
                      <span className="mt-0.5 block truncate pr-4 text-[9px] text-[var(--color-text-muted)]">
                        {[dimensions, candidate.sourceName].filter(Boolean).join(" · ") || "Online artwork"}
                      </span>
                    </span>
                  </button>
                  <button
                    aria-label="Open Brave image search"
                    className="absolute bottom-2.5 right-2.5 text-[var(--color-text-muted)] hover:text-[var(--color-accent)]"
                    onClick={() => { void openExternal(candidate.sourceUrl); }}
                    title="Open Brave image search"
                    type="button"
                  >
                    <ExternalLink className="h-3 w-3" />
                  </button>
                </article>
              );
            })}
          </div>
          {error && (
            <p className="mt-3 rounded-[var(--radius-md)] bg-red-500/10 px-3 py-2 text-[11px] text-red-500">
              {error}
            </p>
          )}
        </div>

        <footer className="flex items-center justify-end gap-2 border-t border-[var(--color-border)] p-4">
          <button
            className="rounded-[var(--radius-md)] px-3 py-2 text-[11px] text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-hover)]"
            disabled={isApplying}
            onClick={onClose}
            type="button"
          >
            Cancel
          </button>
          <button
            className="inline-flex min-w-28 items-center justify-center gap-2 rounded-[var(--radius-md)] bg-[var(--color-accent)] px-3 py-2 text-[11px] font-semibold text-white disabled:cursor-not-allowed disabled:opacity-50"
            data-apply-album-cover
            disabled={!selected || isApplying}
            onClick={() => { void applySelected(); }}
            type="button"
          >
            {isApplying && <LoaderCircle className="h-3.5 w-3.5 animate-spin" />}
            {isApplying ? "Loading" : "Use cover"}
          </button>
        </footer>
      </div>
    </div>,
    document.body,
  );
};
