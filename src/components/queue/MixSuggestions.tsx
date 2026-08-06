import { Blend, Gauge, ListPlus, Music2, Play, Sparkles, Star } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { convertFileSrc } from "@muro/desktop/runtime";
import {
  calculateMixScore,
  getCamelotSuggestions,
  getCompatibleCamelotCodes,
  getTracksForCamelotCode,
  toCamelotCode,
  type CamelotMatch,
} from "../../utils/camelot";
import type { Track } from "../../types";
import { CamelotWheel } from "./CamelotWheel";

type MixSuggestionsProps = {
  tracks: Track[];
  currentTrack: Track | null | undefined;
  queuedTrackIds: string[];
  currentPlaylistTrackIds?: string[];
  onPlayTrack: (trackId: string) => void;
  onPlayNext: (trackId: string) => void;
  onMixWithCurrent?: (trackId: string) => void;
};

type BpmWindow = "any" | "3" | "6" | "10";
type SortMode = "score" | "bpm" | "rating";

const MAX_SUGGESTIONS = 100;

const harmonicRankForCode = (currentCode: string, code: string) => {
  if (code === currentCode) return 0;
  const currentNumber = Number(currentCode.slice(0, -1));
  const currentLetter = currentCode.charAt(currentCode.length - 1);
  const number = Number(code.slice(0, -1));
  const letter = code.charAt(code.length - 1);
  if (number === currentNumber && letter !== currentLetter) return 1;
  return getCompatibleCamelotCodes(currentCode).includes(code) ? 2 : 3;
};

const formatBpmDifference = (difference: number) =>
  Number.isFinite(difference) ? `Δ ${difference.toFixed(1)}` : "BPM unknown";

export const MixSuggestions = ({
  tracks,
  currentTrack,
  queuedTrackIds,
  currentPlaylistTrackIds,
  onPlayTrack,
  onPlayNext,
  onMixWithCurrent,
}: MixSuggestionsProps) => {
  const currentCode = toCamelotCode(currentTrack?.key);
  const [selectedCode, setSelectedCode] = useState<string | null>(null);
  const [bpmWindow, setBpmWindow] = useState<BpmWindow>("any");
  const [sameGenreOnly, setSameGenreOnly] = useState(false);
  const [minimumRating, setMinimumRating] = useState(0);
  const [sortMode, setSortMode] = useState<SortMode>("score");
  const [playlistOnly, setPlaylistOnly] = useState(false);
  const excludedTrackIds = useMemo(() => new Set(queuedTrackIds), [queuedTrackIds]);
  const playlistTrackIds = useMemo(
    () => new Set(currentPlaylistTrackIds ?? []),
    [currentPlaylistTrackIds],
  );

  const automaticSuggestions = useMemo(
    () => getCamelotSuggestions(currentTrack, tracks, excludedTrackIds),
    [currentTrack, excludedTrackIds, tracks],
  );

  const selectedSuggestions = useMemo((): CamelotMatch[] => {
    if (!selectedCode || !currentTrack || !currentCode) return [];
    const rank = harmonicRankForCode(currentCode, selectedCode);
    return getTracksForCamelotCode(selectedCode, currentTrack, tracks, excludedTrackIds).map((track) => {
      const bpmDifference = (currentTrack.bpm ?? 0) > 0 && (track.bpm ?? 0) > 0
        ? Math.abs((track.bpm ?? 0) - (currentTrack.bpm ?? 0))
        : Number.POSITIVE_INFINITY;
      const scoring = calculateMixScore(currentTrack, track, rank, bpmDifference);
      return {
        track,
        code: selectedCode,
        reason: selectedCode === currentCode ? "Same key" : "Selected key",
        rank,
        bpmDifference,
        ...scoring,
      };
    });
  }, [currentCode, currentTrack, excludedTrackIds, selectedCode, tracks]);

  const suggestions = useMemo(() => {
    const bpmLimit = bpmWindow === "any" ? Number.POSITIVE_INFINITY : Number(bpmWindow);
    const currentTrackHasBpm = (currentTrack?.bpm ?? 0) > 0;
    const filtered = (selectedCode ? selectedSuggestions : automaticSuggestions).filter((suggestion) =>
      (!currentTrackHasBpm || suggestion.bpmDifference <= bpmLimit) &&
      (!sameGenreOnly || suggestion.genreMatch) &&
      (suggestion.track.rating ?? 0) >= minimumRating &&
      (!playlistOnly || playlistTrackIds.has(suggestion.track.id))
    );
    filtered.sort((left, right) => {
      if (sortMode === "bpm") {
        return left.bpmDifference - right.bpmDifference || right.score - left.score;
      }
      if (sortMode === "rating") {
        return right.track.rating - left.track.rating || right.score - left.score;
      }
      return right.score - left.score || left.rank - right.rank || left.bpmDifference - right.bpmDifference;
    });
    return filtered.slice(0, MAX_SUGGESTIONS);
  }, [automaticSuggestions, bpmWindow, currentTrack?.bpm, minimumRating, playlistOnly, playlistTrackIds, sameGenreOnly, selectedCode, selectedSuggestions, sortMode]);

  const resetFilters = () => {
    setBpmWindow("any");
    setMinimumRating(0);
    setSameGenreOnly(false);
    setSelectedCode(null);
    setPlaylistOnly(false);
  };

  useEffect(() => {
    setSelectedCode(null);
  }, [currentTrack?.id]);

  useEffect(() => {
    if (!currentPlaylistTrackIds?.length) {
      setPlaylistOnly(false);
    }
  }, [currentPlaylistTrackIds]);

  if (!currentTrack) {
    return (
      <div className="flex min-h-0 flex-1 flex-col items-center justify-center px-7 text-center text-[var(--color-text-muted)]">
        <Sparkles className="mb-3 h-7 w-7" />
        <p className="text-[13px] font-medium text-[var(--color-text-secondary)]">Play a track to find a compatible mix</p>
        <p className="mt-1 max-w-64 text-[11px] leading-relaxed">Suggestions update automatically when the playing track changes.</p>
      </div>
    );
  }

  if (!currentCode) {
    return (
      <div className="flex min-h-0 flex-1 flex-col items-center justify-center px-7 text-center text-[var(--color-text-muted)]">
        <Sparkles className="mb-3 h-7 w-7" />
        <p className="text-[13px] font-medium text-[var(--color-text-secondary)]">No Camelot key for this track</p>
        <p className="mt-1 max-w-64 text-[11px] leading-relaxed">Analyze its key first, then Mix Next can find compatible songs.</p>
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col" data-mix-suggestions>
      <div className="shrink-0 border-b border-[var(--color-border)] px-4 py-4">
        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0">
            <div className="text-[10px] font-semibold uppercase tracking-[0.1em] text-[var(--color-text-muted)]">Mixing from</div>
            <div className="mt-1 truncate text-[13px] font-semibold text-[var(--color-text-primary)]">{currentTrack.title}</div>
            <div className="mt-0.5 truncate text-[11px] text-[var(--color-text-muted)]">{currentTrack.artist} · {currentTrack.bpm?.toFixed(1) ?? "—"} BPM</div>
          </div>
          <span className="shrink-0 rounded-[var(--radius-md)] bg-[var(--color-accent-light)] px-3 py-1.5 text-[13px] font-bold text-[var(--color-accent)]">
            {currentCode}
          </span>
        </div>
      </div>

      <div className="grid shrink-0 grid-cols-2 gap-2 border-b border-[var(--color-border)] px-3 py-3 min-[420px]:grid-cols-4" data-mix-filters>
        <label className="min-w-0">
          <span className="mb-1 block text-[9px] font-semibold uppercase tracking-[0.08em] text-[var(--color-text-muted)]">BPM delta</span>
          <select className="h-8 w-full rounded-[var(--radius-sm)] border border-[var(--color-border)] bg-[var(--color-bg-primary)] px-2 text-[11px] text-[var(--color-text-primary)]" value={bpmWindow} onChange={(event) => setBpmWindow(event.target.value as BpmWindow)} data-mix-filter-bpm>
            <option value="3">±3 BPM</option>
            <option value="6">±6 BPM</option>
            <option value="10">±10 BPM</option>
            <option value="any">Any BPM</option>
          </select>
        </label>
        <label className="min-w-0">
          <span className="mb-1 block text-[9px] font-semibold uppercase tracking-[0.08em] text-[var(--color-text-muted)]">Rating</span>
          <select className="h-8 w-full rounded-[var(--radius-sm)] border border-[var(--color-border)] bg-[var(--color-bg-primary)] px-2 text-[11px] text-[var(--color-text-primary)]" value={minimumRating} onChange={(event) => setMinimumRating(Number(event.target.value))} data-mix-filter-rating>
            <option value="0">Any rating</option>
            <option value="3">3+ stars</option>
            <option value="4">4+ stars</option>
            <option value="5">5 stars</option>
          </select>
        </label>
        <label className="min-w-0">
          <span className="mb-1 block text-[9px] font-semibold uppercase tracking-[0.08em] text-[var(--color-text-muted)]">Sort</span>
          <select className="h-8 w-full rounded-[var(--radius-sm)] border border-[var(--color-border)] bg-[var(--color-bg-primary)] px-2 text-[11px] text-[var(--color-text-primary)]" value={sortMode} onChange={(event) => setSortMode(event.target.value as SortMode)} data-mix-sort>
            <option value="score">Best match</option>
            <option value="bpm">Closest BPM</option>
            <option value="rating">Highest rated</option>
          </select>
        </label>
        <button
          className={`mt-4 h-8 rounded-[var(--radius-sm)] border px-2 text-[10px] font-medium transition-colors ${sameGenreOnly ? "border-[var(--color-accent)] bg-[var(--color-accent-light)] text-[var(--color-accent)]" : "border-[var(--color-border)] bg-[var(--color-bg-primary)] text-[var(--color-text-muted)] hover:text-[var(--color-text-primary)]"}`}
          onClick={() => setSameGenreOnly((value) => !value)}
          aria-pressed={sameGenreOnly}
          data-mix-filter-genre
          type="button"
        >
          Same genre
        </button>
        <button
          className={`mt-4 h-8 rounded-[var(--radius-sm)] border px-2 text-[10px] font-medium transition-colors ${playlistOnly ? "border-[var(--color-accent)] bg-[var(--color-accent-light)] text-[var(--color-accent)]" : "border-[var(--color-border)] bg-[var(--color-bg-primary)] text-[var(--color-text-muted)] hover:text-[var(--color-text-primary)]"} ${currentPlaylistTrackIds?.length ? "" : "cursor-not-allowed opacity-50"}`}
          onClick={() => {
            if (!currentPlaylistTrackIds?.length) return;
            setPlaylistOnly((value) => !value);
          }}
          aria-pressed={playlistOnly}
          aria-disabled={!currentPlaylistTrackIds?.length}
          data-mix-filter-playlist
          disabled={!currentPlaylistTrackIds?.length}
          type="button"
        >
          Current playlist
        </button>
      </div>

      <div className="shrink-0 border-b border-[var(--color-border)] px-3 py-3">
        <CamelotWheel currentCode={currentCode} selectedCode={selectedCode} onSelectCode={setSelectedCode} />
      </div>

      <div className="flex h-9 shrink-0 items-center border-b border-[var(--color-border-light)] px-3">
        <span className="text-[10px] font-semibold uppercase tracking-[0.08em] text-[var(--color-text-secondary)]">
          {selectedCode ? `${selectedCode} tracks` : "Ranked matches"}
        </span>
        {selectedCode && <button className="ml-2 text-[10px] text-[var(--color-accent)] hover:underline" onClick={() => setSelectedCode(null)} type="button">Reset wheel</button>}
        <span className="ml-auto text-[11px] tabular-nums text-[var(--color-text-muted)]">{suggestions.length}</span>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {suggestions.length === 0 ? (
          <div className="flex h-full min-h-32 flex-col items-center justify-center px-7 text-center text-[var(--color-text-muted)]">
            <Music2 className="mb-3 h-5 w-5" />
            <p className="text-[12px]">No tracks match these filters</p>
            <p className="mt-1 text-[10px]">Widen the BPM window, lower the rating, or choose another key.</p>
            <button
              className="mt-3 rounded-[var(--radius-sm)] border border-[var(--color-border)] px-3 py-1.5 text-[10px] font-medium text-[var(--color-text-secondary)] transition-colors hover:bg-[var(--color-bg-hover)] hover:text-[var(--color-text-primary)]"
              onClick={resetFilters}
              data-mix-reset-filters
              type="button"
            >
              Reset filters
            </button>
          </div>
        ) : suggestions.map(({ track, code, reason, bpmDifference, genreMatch, score }) => {
          const coverPath = track.coverArtThumbPath || track.coverArtPath;
          return (
            <div
              key={track.id}
              className="group border-b border-[var(--color-border-light)] px-3 py-1.5 hover:bg-[var(--color-bg-hover)]"
              data-mix-suggestion
              data-mix-reason={reason}
              data-mix-code={code}
              data-mix-score={score}
              data-mix-bpm-difference={Number.isFinite(bpmDifference) ? bpmDifference : undefined}
            >
              <div className="flex items-center gap-1.5">
                <div className="flex h-8 w-8 shrink-0 items-center justify-center overflow-hidden rounded-[var(--radius-sm)] bg-[var(--color-bg-tertiary)] text-[var(--color-text-muted)]" data-mix-suggestion-cover>
                  {coverPath ? <img src={convertFileSrc(coverPath)} alt="" className="h-full w-full object-cover" /> : <Music2 className="h-3.5 w-3.5" />}
                </div>
                <div className="min-w-0 flex-1">
                  <div className="truncate text-[12px] font-semibold text-[var(--color-text-primary)]">{track.title}</div>
                  <div className="mt-0.5 truncate text-[10px] text-[var(--color-text-muted)]">{track.artist}</div>
                </div>
                <div className="shrink-0 text-right">
                  <div className="inline-flex items-center gap-1 rounded-[var(--radius-sm)] bg-[var(--color-accent-light)] px-1.5 py-0.5 text-[10px] font-bold text-[var(--color-accent)]" title="Mix match score"><Gauge className="h-3 w-3" />{score}</div>
                  <div className="mt-0.5 text-[9px] font-semibold text-[var(--color-accent)]">{code}</div>
                </div>
              </div>
              <div className="mt-1 flex flex-wrap items-center gap-1 pl-10 text-[9px] leading-tight">
                <span className="rounded-full border border-[var(--color-border)] px-1.5 py-0.5 text-[var(--color-text-secondary)]">{reason}</span>
                <span className="rounded-full border border-[var(--color-border)] px-1.5 py-0.5 tabular-nums text-[var(--color-text-muted)]">{track.bpm ? `${track.bpm.toFixed(1)} BPM · ${formatBpmDifference(bpmDifference)}` : "BPM unknown"}</span>
                {genreMatch && <span className="rounded-full border border-[var(--color-border)] px-1.5 py-0.5 text-[var(--color-text-muted)]">Same genre</span>}
                {track.rating > 0 && <span className="inline-flex items-center gap-0.5 rounded-full border border-[var(--color-border)] px-1.5 py-0.5 text-[var(--color-text-muted)]"><Star className="h-2.5 w-2.5 text-[var(--color-rating-star)]" fill="currentColor" />{track.rating}</span>}
              </div>
              <div className="mt-1 flex items-center justify-end gap-1 pl-10" data-mix-suggestion-actions>
                {onMixWithCurrent && (
                  <button
                    className="mix-suggestion-action inline-flex items-center gap-1 rounded-[var(--radius-sm)] border border-[var(--color-accent)] bg-[var(--color-accent-light)] px-2 text-[10px] font-semibold text-[var(--color-accent)] transition-colors hover:bg-[var(--color-accent)] hover:text-white"
                    onClick={() => onMixWithCurrent(track.id)}
                    title={`Mix the running song into ${track.title}`}
                    aria-label={`Mix the running song into ${track.title}`}
                    data-mix-with-current
                    type="button"
                  >
                    <Blend className="h-3 w-3" />
                    Mix
                  </button>
                )}
                <button className="mix-suggestion-action toolbar-icon-button" onClick={() => onPlayTrack(track.id)} title={`Play ${track.title}`} aria-label={`Play ${track.title}`} type="button"><Play className="h-3 w-3" fill="currentColor" /></button>
                <button className="mix-suggestion-action toolbar-icon-button" onClick={() => onPlayNext(track.id)} title={`Play ${track.title} next`} aria-label={`Play ${track.title} next`} data-mix-play-next type="button"><ListPlus className="h-3.5 w-3.5" /></button>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
};
