import { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { Check, ExternalLink, ImageIcon, LoaderCircle, SearchX } from "lucide-react";
import type { ArtistImageCandidate } from "../../types";

type ArtistImageModalProps = {
  artistName: string | null;
  onClose: () => void;
  onSearch: (artistName: string) => Promise<ArtistImageCandidate[]>;
  onApply: (artistName: string, candidate: ArtistImageCandidate) => Promise<void>;
  onOpenSource: (url: string) => void;
};

const providerLabel = (provider: ArtistImageCandidate["provider"]) => ({
  "wikimedia-commons": "Wikimedia Commons",
  wikipedia: "Wikipedia",
  "fanart.tv": "Fanart.tv",
  theaudiodb: "TheAudioDB",
  deezer: "Deezer",
  "brave-search": "Brave Image Search",
})[provider];

export const ArtistImageModal = ({
  artistName,
  onClose,
  onSearch,
  onApply,
  onOpenSource,
}: ArtistImageModalProps) => {
  const [candidates, setCandidates] = useState<ArtistImageCandidate[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [failedImages, setFailedImages] = useState<Set<string>>(() => new Set());
  const [isLoading, setIsLoading] = useState(false);
  const [isApplying, setIsApplying] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!artistName) return;
    let cancelled = false;
    setCandidates([]);
    setSelectedId(null);
    setFailedImages(new Set());
    setError(null);
    setIsLoading(true);
    void onSearch(artistName)
      .then((results) => {
        if (cancelled) return;
        setCandidates(results);
        setSelectedId(results.find((candidate) => candidate.current)?.id ?? results[0]?.id ?? null);
      })
      .catch((reason) => {
        if (!cancelled) {
          setError(reason instanceof Error ? reason.message : "Artist pictures could not be loaded");
        }
      })
      .finally(() => {
        if (!cancelled) setIsLoading(false);
      });
    return () => { cancelled = true; };
  }, [artistName, onSearch]);

  useEffect(() => {
    if (!artistName) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !isApplying) onClose();
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [artistName, isApplying, onClose]);

  const selected = useMemo(
    () => candidates.find((candidate) => candidate.id === selectedId) ?? null,
    [candidates, selectedId],
  );

  if (!artistName || typeof document === "undefined") return null;

  const applySelected = async () => {
    if (!selected || isApplying) return;
    setIsApplying(true);
    setError(null);
    try {
      await onApply(artistName, selected);
      onClose();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "The artist picture could not be saved");
    } finally {
      setIsApplying(false);
    }
  };

  return createPortal(
    <div
      className="modal-overlay-animate fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-[var(--spacing-lg)] backdrop-blur-sm"
      onClick={() => { if (!isApplying) onClose(); }}
      data-artist-image-modal
    >
      <div
        className="modal-panel-animate flex max-h-[84vh] w-full max-w-[820px] flex-col overflow-hidden rounded-[var(--radius-lg)] border border-[var(--color-border)] bg-[var(--color-bg-primary)] shadow-[var(--shadow-lg)]"
        onClick={(event) => event.stopPropagation()}
      >
        <header className="flex items-start gap-3 border-b border-[var(--color-border)] p-5">
          <ImageIcon className="mt-0.5 h-5 w-5 shrink-0 text-[var(--color-accent)]" />
          <div className="min-w-0">
            <h2 className="text-[15px] font-semibold text-[var(--color-text-primary)]">Choose artist picture</h2>
            <p className="mt-1 truncate text-[11px] text-[var(--color-text-muted)]">{artistName}</p>
          </div>
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto p-4">
          {isLoading ? (
            <div className="flex min-h-72 flex-col items-center justify-center gap-3 text-[var(--color-text-muted)]">
              <LoaderCircle className="h-7 w-7 animate-spin" />
              <span className="text-[12px]">Searching configured image providers…</span>
            </div>
          ) : candidates.length === 0 ? (
            <div className="flex min-h-72 flex-col items-center justify-center gap-3 px-8 text-center text-[var(--color-text-muted)]">
              <SearchX className="h-7 w-7" />
              <strong className="text-[13px] text-[var(--color-text-primary)]">No artist pictures found</strong>
              <p className="max-w-md text-[11px] leading-relaxed">Wikimedia Commons and Deezer are searched without a key. Add Brave Search, Fanart.tv, or TheAudioDB keys in Settings → Metadata &amp; Artwork for more results.</p>
            </div>
          ) : (
            <div>
              {candidates.some((candidate) => (
                candidate.provider === "brave-search" || candidate.provider === "deezer"
              )) && (
                <p className="mb-3 rounded-[var(--radius-md)] bg-amber-500/10 px-3 py-2 text-[10px] leading-relaxed text-amber-700 dark:text-amber-300">
                  Online image results may be copyrighted. Check the source and usage rights before using them.
                </p>
              )}
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-3" role="radiogroup" aria-label="Artist picture candidates">
                {candidates.map((candidate) => {
                  const isSelected = candidate.id === selectedId;
                  const dimensions = candidate.width && candidate.height
                    ? `${candidate.width} × ${candidate.height}`
                    : null;
                  return (
                    <article
                      key={candidate.id}
                      className={`relative overflow-hidden rounded-[var(--radius-md)] border transition-colors ${isSelected ? "border-[var(--color-accent)] bg-[var(--color-accent-light)]" : "border-[var(--color-border)] bg-[var(--color-bg-secondary)] hover:border-[var(--color-text-muted)]"}`}
                      data-artist-image-candidate={candidate.provider}
                    >
                      <button
                        className="block w-full text-left"
                        type="button"
                        role="radio"
                        aria-checked={isSelected}
                        onClick={() => setSelectedId(candidate.id)}
                      >
                        <span className="relative block aspect-square overflow-hidden bg-[var(--color-bg-tertiary)]">
                          {!failedImages.has(candidate.id) ? (
                            <img
                              alt={`${artistName} from ${providerLabel(candidate.provider)}`}
                              className="h-full w-full object-cover"
                              loading="lazy"
                              onError={() => setFailedImages((current) => new Set(current).add(candidate.id))}
                              src={candidate.imageUrl}
                            />
                          ) : (
                            <span className="flex h-full items-center justify-center text-[var(--color-text-muted)]"><ImageIcon className="h-8 w-8" /></span>
                          )}
                          {isSelected && (
                            <span className="absolute right-2 top-2 grid h-6 w-6 place-items-center rounded-full bg-[var(--color-accent)] text-white shadow-md"><Check className="h-4 w-4" /></span>
                          )}
                          {candidate.current && (
                            <span className="absolute bottom-2 left-2 rounded-full bg-black/70 px-2 py-0.5 text-[9px] font-semibold text-white">Current</span>
                          )}
                        </span>
                        <span className="block p-2.5">
                          <strong className="block truncate text-[11px] text-[var(--color-text-primary)]">{providerLabel(candidate.provider)}</strong>
                          <span className="mt-0.5 block truncate pr-4 text-[9px] text-[var(--color-text-muted)]" title={candidate.title ?? undefined}>
                            {[dimensions, candidate.sourceName, candidate.license, candidate.attribution]
                              .filter((value, index, values) => Boolean(value) && values.indexOf(value) === index)
                              .join(" · ") || "Online artwork"}
                          </span>
                        </span>
                      </button>
                      {candidate.sourceUrl && (
                        <button
                          className="absolute bottom-2.5 right-2.5 text-[var(--color-text-muted)] hover:text-[var(--color-accent)]"
                          onClick={() => onOpenSource(candidate.sourceUrl!)}
                          title={`Open ${providerLabel(candidate.provider)}`}
                          type="button"
                        >
                          <ExternalLink className="h-3 w-3" />
                        </button>
                      )}
                    </article>
                  );
                })}
              </div>
            </div>
          )}
          {error && <p className="mt-3 rounded-[var(--radius-md)] bg-red-500/10 px-3 py-2 text-[11px] text-red-500">{error}</p>}
        </div>

        <footer className="flex items-center justify-end gap-2 border-t border-[var(--color-border)] p-4">
          <button className="rounded-[var(--radius-md)] px-3 py-2 text-[11px] text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-hover)]" disabled={isApplying} onClick={onClose} type="button">Cancel</button>
          <button
            className="inline-flex min-w-28 items-center justify-center gap-2 rounded-[var(--radius-md)] bg-[var(--color-accent)] px-3 py-2 text-[11px] font-semibold text-white disabled:cursor-not-allowed disabled:opacity-50"
            disabled={!selected || isApplying}
            onClick={() => { void applySelected(); }}
            type="button"
            data-apply-artist-image
          >
            {isApplying && <LoaderCircle className="h-3.5 w-3.5 animate-spin" />}
            {isApplying ? "Saving" : "Use picture"}
          </button>
        </footer>
      </div>
    </div>,
    document.body,
  );
};
