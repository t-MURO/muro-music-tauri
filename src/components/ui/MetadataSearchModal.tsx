import { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { DatabaseZap, LoaderCircle, SearchX } from "lucide-react";
import { t } from "../../i18n";
import type { Track, TrackMetadataUpdates } from "../../types";
import type { MetadataSearchCandidate } from "../../utils/database";
import {
  albumArtistDisplay,
  coerceArtistCredits,
} from "../../utils/artistCredits";

type MetadataSearchModalProps = {
  track: Track | null;
  onClose: () => void;
  onSearch: (track: Track) => Promise<MetadataSearchCandidate[]>;
  onApply: (updates: TrackMetadataUpdates) => Promise<void>;
};

type MetadataFieldKey = "title" | "artist" | "artists" | "album" | "year" | "genre";

type MetadataFieldRow = {
  key: MetadataFieldKey;
  label: string;
  current: string;
  proposed: string;
  value: string | number | null;
  changed: boolean;
};

export const MetadataSearchModal = ({
  track,
  onClose,
  onSearch,
  onApply,
}: MetadataSearchModalProps) => {
  const [candidates, setCandidates] = useState<MetadataSearchCandidate[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [isApplying, setIsApplying] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedFields, setSelectedFields] = useState<Set<MetadataFieldKey>>(new Set());

  useEffect(() => {
    if (!track) return;
    let cancelled = false;
    setCandidates([]);
    setSelectedId(null);
    setError(null);
    setIsLoading(true);
    void onSearch(track)
      .then((results) => {
        if (cancelled) return;
        setCandidates(results);
        setSelectedId(results[0]?.id ?? null);
      })
      .catch((reason) => {
        if (!cancelled) setError(reason instanceof Error ? reason.message : t("metadataSearch.failed"));
      })
      .finally(() => {
        if (!cancelled) setIsLoading(false);
      });
    return () => { cancelled = true; };
  }, [onSearch, track]);

  useEffect(() => {
    if (!track) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [onClose, track]);

  const selected = useMemo(
    () => candidates.find((candidate) => candidate.id === selectedId) ?? null,
    [candidates, selectedId],
  );

  const fieldRows = useMemo((): MetadataFieldRow[] => {
    if (!track || !selected) return [];
    const values: Array<Omit<MetadataFieldRow, "current" | "proposed" | "changed"> & { currentValue: string | number | null }> = [
      { key: "title", label: t("edit.field.title"), currentValue: track.title, value: selected.title || null },
      { key: "artist", label: t("edit.field.artist"), currentValue: track.artist, value: selected.artist || null },
      { key: "artists", label: t("edit.field.albumArtist"), currentValue: albumArtistDisplay(track), value: selected.albumArtist || null },
      { key: "album", label: t("edit.field.album"), currentValue: track.album, value: selected.album || null },
      { key: "year", label: t("edit.field.year"), currentValue: track.year ?? null, value: selected.year },
      { key: "genre", label: t("edit.field.genre"), currentValue: track.genre ?? null, value: selected.genre },
    ];
    return values.map(({ currentValue, ...row }) => {
      const current = currentValue === null || currentValue === "" ? t("metadataSearch.empty") : String(currentValue);
      const proposed = row.value === null || row.value === "" ? t("metadataSearch.unavailable") : String(row.value);
      return {
        ...row,
        current,
        proposed,
        changed: row.value !== null && String(currentValue ?? "") !== String(row.value),
      };
    });
  }, [selected, track]);

  useEffect(() => {
    setSelectedFields(new Set(
      fieldRows.filter((row) => row.changed).map((row) => row.key),
    ));
  }, [fieldRows]);

  if (!track || typeof document === "undefined") return null;

  const applySelected = async () => {
    if (!selected || selectedFields.size === 0 || isApplying) return;
    const updates: TrackMetadataUpdates = {};
    for (const row of fieldRows) {
      if (!selectedFields.has(row.key) || row.value === null) continue;
      if (row.key === "year") updates.year = Number(row.value);
      else if (row.key === "artist") {
        updates.artist = String(row.value);
        updates.artistCredits = coerceArtistCredits(
          selected.artistCredits,
          String(row.value),
        );
      } else if (row.key === "artists") {
        updates.albumArtist = String(row.value);
        updates.artists = String(row.value);
        updates.albumArtistCredits = coerceArtistCredits(
          selected.albumArtistCredits,
          String(row.value),
        );
      } else {
        updates[row.key] = String(row.value);
      }
    }
    setIsApplying(true);
    try {
      await onApply(updates);
      onClose();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : t("metadataSearch.applyFailed"));
    } finally {
      setIsApplying(false);
    }
  };

  return createPortal(
    <div
      className="modal-overlay-animate fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-[var(--spacing-lg)] backdrop-blur-sm"
      onClick={onClose}
      data-metadata-search-modal
    >
      <div
        className="modal-panel-animate flex max-h-[82vh] w-full max-w-[720px] flex-col overflow-hidden rounded-[var(--radius-lg)] border border-[var(--color-border)] bg-[var(--color-bg-primary)] shadow-[var(--shadow-lg)]"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex items-start gap-3 border-b border-[var(--color-border)] p-5">
          <DatabaseZap className="mt-0.5 h-5 w-5 shrink-0 text-[var(--color-accent)]" />
          <div className="min-w-0">
            <h2 className="text-[15px] font-semibold text-[var(--color-text-primary)]">{t("metadataSearch.title")}</h2>
            <p className="mt-1 truncate text-[11px] text-[var(--color-text-muted)]">{track.artist} — {track.title}</p>
          </div>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto p-3">
          {isLoading ? (
            <div className="flex min-h-56 flex-col items-center justify-center gap-3 text-[var(--color-text-muted)]">
              <LoaderCircle className="h-6 w-6 animate-spin" />
              <span className="text-[12px]">{t("metadataSearch.searching")}</span>
            </div>
          ) : error ? (
            <div className="flex min-h-56 items-center justify-center px-8 text-center text-[12px] text-red-500">{error}</div>
          ) : candidates.length === 0 ? (
            <div className="flex min-h-56 flex-col items-center justify-center gap-3 text-[var(--color-text-muted)]">
              <SearchX className="h-6 w-6" />
              <span className="text-[12px]">{t("metadataSearch.none")}</span>
            </div>
          ) : (
            <div className="space-y-3">
              <div className="max-h-56 space-y-1 overflow-y-auto" role="radiogroup" aria-label={t("metadataSearch.results")}>
                {candidates.map((candidate) => (
                  <button
                    key={candidate.id}
                    type="button"
                    role="radio"
                    aria-checked={candidate.id === selectedId}
                    className={`grid w-full grid-cols-[1fr_auto] gap-3 rounded-[var(--radius-md)] border px-3 py-2.5 text-left transition-colors ${candidate.id === selectedId ? "border-[var(--color-accent)] bg-[var(--color-accent-light)]" : "border-transparent hover:bg-[var(--color-bg-hover)]"}`}
                    onClick={() => setSelectedId(candidate.id)}
                    data-metadata-candidate
                  >
                    <span className="min-w-0">
                      <span className="block truncate text-[12px] font-semibold text-[var(--color-text-primary)]">{candidate.title}</span>
                      <span className="mt-0.5 block truncate text-[11px] text-[var(--color-text-secondary)]">{candidate.artist}</span>
                      <span className="mt-1 block truncate text-[10px] text-[var(--color-text-muted)]">
                        {candidate.album || t("metadataSearch.recordingOnly")}
                        {candidate.year ? ` · ${candidate.year}` : ""}
                        {candidate.country ? ` · ${candidate.country}` : ""}
                      </span>
                    </span>
                    <span className="rounded-full border border-[var(--color-border)] px-2 py-0.5 text-[9px] tabular-nums text-[var(--color-text-muted)]">{candidate.score}%</span>
                  </button>
                ))}
              </div>

              {selected && (
                <section className="overflow-hidden rounded-[var(--radius-md)] border border-[var(--color-border)]" data-metadata-fields>
                  <div className="flex items-center border-b border-[var(--color-border)] bg-[var(--color-bg-secondary)] px-3 py-2">
                    <h3 className="text-[11px] font-semibold text-[var(--color-text-primary)]">{t("metadataSearch.fieldsTitle")}</h3>
                    <span className="ml-2 text-[9px] text-[var(--color-text-muted)]">{t("metadataSearch.fieldsHint")}</span>
                    <button
                      type="button"
                      className="ml-auto text-[10px] text-[var(--color-accent)] hover:underline"
                      onClick={() => setSelectedFields(new Set(fieldRows.filter((row) => row.changed).map((row) => row.key)))}
                      data-metadata-select-all
                    >
                      {t("metadataSearch.selectAll")}
                    </button>
                    <button
                      type="button"
                      className="ml-3 text-[10px] text-[var(--color-text-muted)] hover:text-[var(--color-text-primary)] hover:underline"
                      onClick={() => setSelectedFields(new Set())}
                      data-metadata-clear
                    >
                      {t("metadataSearch.clear")}
                    </button>
                  </div>
                  <div className="divide-y divide-[var(--color-border-light)]">
                    {fieldRows.map((row) => (
                      <label
                        key={row.key}
                        className={`grid grid-cols-[20px_100px_minmax(0,1fr)_18px_minmax(0,1fr)] items-center gap-2 px-3 py-2 text-[10px] ${row.changed ? "cursor-pointer hover:bg-[var(--color-bg-hover)]" : "opacity-55"}`}
                        data-metadata-field={row.key}
                      >
                        <input
                          type="checkbox"
                          checked={selectedFields.has(row.key)}
                          disabled={!row.changed}
                          onChange={(event) => setSelectedFields((current) => {
                            const next = new Set(current);
                            if (event.target.checked) next.add(row.key);
                            else next.delete(row.key);
                            return next;
                          })}
                        />
                        <span className="font-semibold text-[var(--color-text-secondary)]">{row.label}</span>
                        <span className="truncate text-[var(--color-text-muted)]" title={row.current}>{row.current}</span>
                        <span className="text-center text-[var(--color-text-muted)]">→</span>
                        <span className={`truncate ${row.changed ? "font-medium text-[var(--color-text-primary)]" : "text-[var(--color-text-muted)]"}`} title={row.proposed}>{row.proposed}</span>
                      </label>
                    ))}
                  </div>
                </section>
              )}
            </div>
          )}
        </div>

        <div className="flex items-center border-t border-[var(--color-border)] p-4">
          <p className="mr-4 text-[10px] text-[var(--color-text-muted)]">{t("metadataSearch.sourceNote")}</p>
          <button type="button" className="ml-auto px-3 py-2 text-[12px] text-[var(--color-text-secondary)]" onClick={onClose}>{t("edit.cancel")}</button>
          <button
            type="button"
            className="rounded-[var(--radius-md)] bg-[var(--color-accent)] px-4 py-2 text-[12px] font-semibold text-white disabled:opacity-50"
            disabled={!selected || selectedFields.size === 0 || isApplying}
            onClick={() => { void applySelected(); }}
            data-apply-metadata
          >
            {isApplying ? t("metadataSearch.applying") : t("metadataSearch.apply")}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
};
