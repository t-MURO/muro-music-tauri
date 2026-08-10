import { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { Combine, LoaderCircle, Search, UserRound } from "lucide-react";
import { t } from "../../i18n";
import { artistIdentityKey, normalizeArtistName } from "../../utils/artistCredits";
import type { ArtistIndexItem } from "../library/ArtistIndexView";

type ArtistMergeModalProps = {
  source: ArtistIndexItem | null;
  artists: ArtistIndexItem[];
  onClose: () => void;
  onMerge: (source: ArtistIndexItem, target: ArtistIndexItem) => Promise<void>;
};

const hasConflictingMusicBrainzIds = (
  source: ArtistIndexItem,
  target: ArtistIndexItem,
) => Boolean(
  source.musicBrainzId
  && target.musicBrainzId
  && source.musicBrainzId.toLocaleLowerCase() !== target.musicBrainzId.toLocaleLowerCase(),
);

export const ArtistMergeModal = ({
  source,
  artists,
  onClose,
  onMerge,
}: ArtistMergeModalProps) => {
  const [query, setQuery] = useState("");
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [isMerging, setIsMerging] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const candidates = useMemo(() => {
    if (!source) return [];
    const sourceKey = artistIdentityKey(source);
    return artists.filter((artist) => artistIdentityKey(artist) !== sourceKey);
  }, [artists, source]);

  useEffect(() => {
    if (!source) return;
    setQuery("");
    setError(null);
    setIsMerging(false);
    const sourceName = normalizeArtistName(source.name);
    const exactMatch = candidates
      .filter((candidate) => !hasConflictingMusicBrainzIds(source, candidate))
      .sort((left, right) => Number(Boolean(right.musicBrainzId)) - Number(Boolean(left.musicBrainzId)))
      .find((candidate) => normalizeArtistName(candidate.name) === sourceName);
    setSelectedKey(exactMatch ? artistIdentityKey(exactMatch) : null);
  }, [candidates, source]);

  useEffect(() => {
    if (!source) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !isMerging) onClose();
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [isMerging, onClose, source]);

  const visibleCandidates = useMemo(() => {
    const normalizedQuery = normalizeArtistName(query);
    if (!normalizedQuery) return candidates;
    return candidates.filter((candidate) => (
      normalizeArtistName(candidate.name).includes(normalizedQuery)
    ));
  }, [candidates, query]);
  const selected = candidates.find(
    (candidate) => artistIdentityKey(candidate) === selectedKey,
  ) ?? null;

  if (!source || typeof document === "undefined") return null;

  const mergeSelected = async () => {
    if (!selected || isMerging || hasConflictingMusicBrainzIds(source, selected)) return;
    setIsMerging(true);
    setError(null);
    try {
      await onMerge(source, selected);
      onClose();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : t("artist.merge.failed"));
    } finally {
      setIsMerging(false);
    }
  };

  return createPortal(
    <div
      className="modal-overlay-animate fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-[var(--spacing-lg)] backdrop-blur-sm"
      data-artist-merge-modal
      onClick={() => { if (!isMerging) onClose(); }}
    >
      <div
        className="modal-panel-animate flex max-h-[82vh] w-full max-w-[620px] flex-col overflow-hidden rounded-[var(--radius-lg)] border border-[var(--color-border)] bg-[var(--color-bg-primary)] shadow-[var(--shadow-lg)]"
        onClick={(event) => event.stopPropagation()}
      >
        <header className="flex items-start gap-3 border-b border-[var(--color-border)] p-5">
          <Combine className="mt-0.5 h-5 w-5 shrink-0 text-[var(--color-accent)]" />
          <div className="min-w-0">
            <h2 className="text-[15px] font-semibold text-[var(--color-text-primary)]">
              {t("artist.merge.title")}
            </h2>
            <p className="mt-1 text-[11px] leading-relaxed text-[var(--color-text-muted)]">
              {t("artist.merge.subtitle", { artist: source.name })}
            </p>
          </div>
        </header>

        <div className="border-b border-[var(--color-border)] p-4">
          <label className="flex items-center gap-2 rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-bg-secondary)] px-3 py-2 focus-within:border-[var(--color-accent)]">
            <Search className="h-4 w-4 shrink-0 text-[var(--color-text-muted)]" />
            <input
              autoFocus
              className="min-w-0 flex-1 bg-transparent text-[12px] text-[var(--color-text-primary)] outline-none placeholder:text-[var(--color-text-muted)]"
              disabled={isMerging}
              onChange={(event) => setQuery(event.target.value)}
              placeholder={t("artist.merge.search")}
              value={query}
            />
          </label>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto p-3" role="radiogroup" aria-label={t("artist.merge.destination")}>
          {visibleCandidates.length === 0 ? (
            <div className="flex min-h-40 flex-col items-center justify-center gap-2 text-center text-[var(--color-text-muted)]">
              <UserRound className="h-6 w-6" />
              <span className="text-[12px]">{t("artist.merge.empty")}</span>
            </div>
          ) : visibleCandidates.map((candidate) => {
            const identity = artistIdentityKey(candidate);
            const isSelected = identity === selectedKey;
            const isConflicting = hasConflictingMusicBrainzIds(source, candidate);
            return (
              <button
                aria-checked={isSelected}
                className={`mb-2 flex w-full items-center gap-3 rounded-[var(--radius-md)] border px-3 py-3 text-left transition-colors ${isSelected ? "border-[var(--color-accent)] bg-[var(--color-accent-light)]" : "border-[var(--color-border)] bg-[var(--color-bg-secondary)] hover:border-[var(--color-text-muted)]"} ${isConflicting ? "cursor-not-allowed opacity-50" : ""}`}
                data-artist-merge-candidate={candidate.name}
                disabled={isMerging || isConflicting}
                key={identity}
                onClick={() => {
                  setSelectedKey(identity);
                  setError(null);
                }}
                role="radio"
                type="button"
              >
                <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-[var(--color-bg-tertiary)] text-[11px] font-semibold text-[var(--color-text-secondary)]">
                  {candidate.name.split(/\s+/).slice(0, 2).map((part) => part[0]?.toLocaleUpperCase()).join("")}
                </span>
                <span className="min-w-0 flex-1">
                  <strong className="block truncate text-[12px] text-[var(--color-text-primary)]">{candidate.name}</strong>
                  <span className="mt-0.5 block truncate text-[10px] text-[var(--color-text-muted)]">
                    {candidate.trackCount.toLocaleString()} {candidate.trackCount === 1 ? t("artist.merge.track") : t("artist.merge.tracks")}
                    {" · "}
                    {candidate.albumCount.toLocaleString()} {candidate.albumCount === 1 ? t("artist.merge.album") : t("artist.merge.albums")}
                    {" · "}
                    {candidate.musicBrainzId ? t("artist.merge.identified") : t("artist.merge.local")}
                  </span>
                  {isConflicting && (
                    <span className="mt-1 block text-[10px] text-amber-600 dark:text-amber-300">
                      {t("artist.merge.conflictingIds")}
                    </span>
                  )}
                </span>
              </button>
            );
          })}
        </div>

        {error && (
          <p className="border-t border-[var(--color-border)] bg-red-500/10 px-5 py-2 text-[11px] text-red-600 dark:text-red-300" role="alert">
            {error}
          </p>
        )}
        <footer className="flex items-center justify-between gap-3 border-t border-[var(--color-border)] p-4">
          <p className="max-w-sm text-[10px] leading-relaxed text-[var(--color-text-muted)]">
            {t("artist.merge.metadataNote")}
          </p>
          <div className="flex shrink-0 items-center gap-2">
            <button
              className="rounded-[var(--radius-md)] px-3 py-2 text-[12px] font-medium text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)]"
              disabled={isMerging}
              onClick={onClose}
              type="button"
            >
              {t("artist.merge.cancel")}
            </button>
            <button
              className="flex items-center gap-2 rounded-[var(--radius-md)] bg-[var(--color-accent)] px-3 py-2 text-[12px] font-semibold text-white disabled:cursor-not-allowed disabled:opacity-50"
              data-merge-artists-confirm
              disabled={!selected || isMerging}
              onClick={() => { void mergeSelected(); }}
              type="button"
            >
              {isMerging && <LoaderCircle className="h-4 w-4 animate-spin" />}
              {isMerging ? t("artist.merge.merging") : t("artist.merge.confirm")}
            </button>
          </div>
        </footer>
      </div>
    </div>,
    document.body,
  );
};
