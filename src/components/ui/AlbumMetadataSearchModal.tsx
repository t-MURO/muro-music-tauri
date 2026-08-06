import { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { Disc3, LoaderCircle, SearchX } from "lucide-react";
import type { Track, TrackMetadataUpdates } from "../../types";
import type {
  AlbumMetadataCandidate,
  AlbumMetadataRelease,
  AlbumMetadataTrack,
} from "../../utils/database";
import {
  albumArtistDisplay,
  coerceArtistCredits,
} from "../../utils/artistCredits";

type AlbumFieldKey =
  | "album" | "artists" | "year" | "label" | "genre"
  | "title" | "artist" | "trackNumber" | "trackTotal"
  | "discNumber" | "discTotal" | "ids";

type AlbumMetadataSearchModalProps = {
  tracks: Track[];
  onClose: () => void;
  onSearch: (tracks: Track[]) => Promise<AlbumMetadataCandidate[]>;
  onLoadRelease: (releaseId: string) => Promise<AlbumMetadataRelease>;
  onApply: (updates: Array<{ trackId: string; updates: TrackMetadataUpdates }>) => Promise<void>;
};

const normalize = (value: unknown) => String(value ?? "").trim().toLocaleLowerCase();

const matchTracks = (localTracks: Track[], release: AlbumMetadataRelease | null) => {
  if (!release) return [];
  const used = new Set<string>();
  return localTracks.map((local) => {
    const discNumber = local.discNumber ?? 1;
    let remote = release.tracks.find((candidate) => (
      !used.has(candidate.id)
      && candidate.discNumber === discNumber
      && local.trackNumber != null
      && candidate.trackNumber === local.trackNumber
    ));
    if (!remote && release.discTotal === 1 && local.trackNumber != null) {
      remote = release.tracks.find((candidate) => !used.has(candidate.id) && candidate.trackNumber === local.trackNumber);
    }
    if (!remote) {
      remote = release.tracks.find((candidate) => !used.has(candidate.id) && normalize(candidate.title) === normalize(local.title));
    }
    if (remote) used.add(remote.id);
    return { local, remote: remote ?? null };
  });
};

const FIELD_LABELS: Array<{ key: AlbumFieldKey; label: string }> = [
  { key: "album", label: "Album" },
  { key: "artists", label: "Album Artist" },
  { key: "year", label: "Year" },
  { key: "label", label: "Label" },
  { key: "genre", label: "Genre" },
  { key: "title", label: "Track Title" },
  { key: "artist", label: "Track Artist" },
  { key: "trackNumber", label: "Track #" },
  { key: "trackTotal", label: "Track Total" },
  { key: "discNumber", label: "Disc #" },
  { key: "discTotal", label: "Disc Total" },
  { key: "ids", label: "MusicBrainz IDs" },
];

export const AlbumMetadataSearchModal = ({
  tracks,
  onClose,
  onSearch,
  onLoadRelease,
  onApply,
}: AlbumMetadataSearchModalProps) => {
  const [candidates, setCandidates] = useState<AlbumMetadataCandidate[]>([]);
  const [selectedReleaseId, setSelectedReleaseId] = useState<string | null>(null);
  const [release, setRelease] = useState<AlbumMetadataRelease | null>(null);
  const [selectedTrackIds, setSelectedTrackIds] = useState<Set<string>>(new Set());
  const [selectedFields, setSelectedFields] = useState<Set<AlbumFieldKey>>(new Set(FIELD_LABELS.map((field) => field.key)));
  const [isSearching, setIsSearching] = useState(false);
  const [isLoadingRelease, setIsLoadingRelease] = useState(false);
  const [isApplying, setIsApplying] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const trackKey = tracks.map((track) => track.id).join(",");

  useEffect(() => {
    if (tracks.length === 0) return;
    let cancelled = false;
    setCandidates([]);
    setSelectedReleaseId(null);
    setRelease(null);
    setError(null);
    setIsSearching(true);
    void onSearch(tracks).then((results) => {
      if (cancelled) return;
      setCandidates(results);
      setSelectedReleaseId(results[0]?.id ?? null);
    }).catch((reason) => {
      if (!cancelled) setError(reason instanceof Error ? reason.message : "Album metadata search failed");
    }).finally(() => {
      if (!cancelled) setIsSearching(false);
    });
    return () => { cancelled = true; };
    // tracks are intentionally represented by a stable ID key.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [onSearch, trackKey]);

  useEffect(() => {
    if (!selectedReleaseId) return;
    let cancelled = false;
    setRelease(null);
    setError(null);
    setIsLoadingRelease(true);
    void onLoadRelease(selectedReleaseId).then((result) => {
      if (!cancelled) setRelease(result);
    }).catch((reason) => {
      if (!cancelled) setError(reason instanceof Error ? reason.message : "Could not load release details");
    }).finally(() => {
      if (!cancelled) setIsLoadingRelease(false);
    });
    return () => { cancelled = true; };
  }, [onLoadRelease, selectedReleaseId]);

  const matches = useMemo(() => matchTracks(tracks, release), [release, tracks]);

  useEffect(() => {
    setSelectedTrackIds(new Set(matches.filter((match) => match.remote).map((match) => match.local.id)));
    setSelectedFields(new Set(FIELD_LABELS.map((field) => field.key)));
  }, [matches]);

  useEffect(() => {
    if (tracks.length === 0) return;
    const handleKeyDown = (event: KeyboardEvent) => { if (event.key === "Escape") onClose(); };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [onClose, tracks.length]);

  if (tracks.length === 0 || typeof document === "undefined") return null;

  const applyRelease = async () => {
    if (!release || selectedTrackIds.size === 0 || selectedFields.size === 0 || isApplying) return;
    const updates = matches.flatMap(({ local, remote }) => {
      if (!remote || !selectedTrackIds.has(local.id)) return [];
      const values: TrackMetadataUpdates = {};
      if (selectedFields.has("album")) values.album = release.title;
      if (selectedFields.has("artists")) {
        values.albumArtist = release.artist;
        values.artists = release.artist;
        values.albumArtistCredits = coerceArtistCredits(
          release.albumArtistCredits ?? release.artistCredits,
          release.artist,
        );
      }
      if (selectedFields.has("year") && release.year) values.year = release.year;
      if (selectedFields.has("label") && release.label) values.label = release.label;
      if (selectedFields.has("genre") && release.genre) values.genre = release.genre;
      if (selectedFields.has("title")) values.title = remote.title;
      if (selectedFields.has("artist")) {
        values.artist = remote.artist;
        values.artistCredits = coerceArtistCredits(
          remote.artistCredits,
          remote.artist,
        );
      }
      if (selectedFields.has("trackNumber")) values.trackNumber = remote.trackNumber;
      if (selectedFields.has("trackTotal")) values.trackTotal = remote.trackTotal;
      if (selectedFields.has("discNumber")) values.discNumber = remote.discNumber;
      if (selectedFields.has("discTotal")) values.discTotal = remote.discTotal;
      if (selectedFields.has("ids")) {
        if (remote.recordingId) values.musicBrainzTrackId = remote.recordingId;
        values.musicBrainzAlbumId = release.id;
        if (release.releaseGroupId) values.musicBrainzReleaseGroupId = release.releaseGroupId;
      }
      return [{ trackId: local.id, updates: values }];
    });
    setIsApplying(true);
    try {
      await onApply(updates);
      onClose();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not apply album metadata");
    } finally {
      setIsApplying(false);
    }
  };

  const first = tracks[0];
  return createPortal(
    <div className="modal-overlay-animate fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-5 backdrop-blur-sm" onClick={onClose} data-album-metadata-modal>
      <div className="modal-panel-animate flex max-h-[88vh] w-full max-w-[920px] flex-col overflow-hidden rounded-[var(--radius-lg)] border border-[var(--color-border)] bg-[var(--color-bg-primary)] shadow-[var(--shadow-lg)]" onClick={(event) => event.stopPropagation()}>
        <div className="flex items-start gap-3 border-b border-[var(--color-border)] p-5">
          <Disc3 className="mt-0.5 h-5 w-5 text-[var(--color-accent)]" />
          <div><h2 className="text-[15px] font-semibold text-[var(--color-text-primary)]">Search for album metadata</h2><p className="mt-1 text-[11px] text-[var(--color-text-muted)]">{albumArtistDisplay(first)} — {first.album} · {tracks.length} tracks</p></div>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto p-4">
          {isSearching ? <Loading label="Searching MusicBrainz releases..." /> : error && !release ? <Message text={error} /> : candidates.length === 0 ? <Empty /> : (
            <>
              <div className="mb-4 flex gap-2 overflow-x-auto pb-1" data-album-metadata-candidates>
                {candidates.map((candidate) => (
                  <button key={candidate.id} type="button" onClick={() => setSelectedReleaseId(candidate.id)} className={`min-w-52 rounded-[var(--radius-md)] border p-3 text-left ${candidate.id === selectedReleaseId ? "border-[var(--color-accent)] bg-[var(--color-accent-light)]" : "border-[var(--color-border)] hover:bg-[var(--color-bg-hover)]"}`} data-album-metadata-candidate>
                    <span className="block truncate text-[12px] font-semibold text-[var(--color-text-primary)]">{candidate.title}</span>
                    <span className="mt-1 block truncate text-[10px] text-[var(--color-text-secondary)]">{candidate.artist}</span>
                    <span className="mt-1 block text-[9px] text-[var(--color-text-muted)]">{candidate.year ?? "—"} · {candidate.country ?? "—"} · {candidate.trackCount || "?"} tracks · {candidate.score}%</span>
                    {candidate.disambiguation && <span className="mt-1 block truncate text-[9px] text-[var(--color-text-muted)]">{candidate.disambiguation}</span>}
                  </button>
                ))}
              </div>

              {isLoadingRelease ? <Loading label="Loading release tracklist..." /> : release && (
                <div className="space-y-4">
                  <section className="rounded-[var(--radius-md)] border border-[var(--color-border)]" data-album-metadata-fields>
                    <div className="flex items-center border-b border-[var(--color-border)] bg-[var(--color-bg-secondary)] px-3 py-2"><h3 className="text-[11px] font-semibold">Fields to update</h3><button type="button" className="ml-auto text-[10px] text-[var(--color-accent)]" onClick={() => setSelectedFields(new Set(FIELD_LABELS.map((field) => field.key)))}>Select all</button><button type="button" className="ml-3 text-[10px] text-[var(--color-text-muted)]" onClick={() => setSelectedFields(new Set())}>Clear</button></div>
                    <div className="flex flex-wrap gap-x-4 gap-y-2 p-3">
                      {FIELD_LABELS.map((field) => <label key={field.key} className="flex cursor-pointer items-center gap-1.5 text-[10px] text-[var(--color-text-secondary)]"><input type="checkbox" checked={selectedFields.has(field.key)} onChange={(event) => setSelectedFields((current) => { const next = new Set(current); if (event.target.checked) next.add(field.key); else next.delete(field.key); return next; })} data-album-metadata-field={field.key} />{field.label}</label>)}
                    </div>
                    <div className="grid grid-cols-2 gap-x-6 gap-y-1 border-t border-[var(--color-border-light)] px-3 py-2 text-[9px] text-[var(--color-text-muted)] md:grid-cols-4">
                      <span>Album: <strong className="text-[var(--color-text-secondary)]">{first.album} → {release.title}</strong></span><span>Artist: <strong className="text-[var(--color-text-secondary)]">{albumArtistDisplay(first)} → {release.artist}</strong></span><span>Year: <strong className="text-[var(--color-text-secondary)]">{first.year ?? "—"} → {release.year ?? "—"}</strong></span><span>Label: <strong className="text-[var(--color-text-secondary)]">{first.label ?? "—"} → {release.label ?? "—"}</strong></span>
                    </div>
                  </section>

                  <section className="overflow-hidden rounded-[var(--radius-md)] border border-[var(--color-border)]" data-album-track-matches>
                    <div className="grid grid-cols-[28px_1fr_32px_1fr] gap-2 border-b border-[var(--color-border)] bg-[var(--color-bg-secondary)] px-3 py-2 text-[9px] font-semibold uppercase text-[var(--color-text-muted)]"><span></span><span>Local track</span><span></span><span>MusicBrainz track</span></div>
                    <div className="max-h-64 overflow-y-auto divide-y divide-[var(--color-border-light)]">
                      {matches.map(({ local, remote }) => (
                        <label key={local.id} className={`grid grid-cols-[28px_1fr_32px_1fr] items-center gap-2 px-3 py-2 text-[10px] ${remote ? "hover:bg-[var(--color-bg-hover)]" : "opacity-55"}`} data-album-track-match={remote ? "matched" : "unmatched"}>
                          <input type="checkbox" disabled={!remote} checked={selectedTrackIds.has(local.id)} onChange={(event) => setSelectedTrackIds((current) => { const next = new Set(current); if (event.target.checked) next.add(local.id); else next.delete(local.id); return next; })} />
                          <span className="min-w-0 truncate"><span className="mr-2 tabular-nums text-[var(--color-text-muted)]">{local.discNumber ?? 1}.{local.trackNumber ?? "?"}</span>{local.title}</span><span className="text-center text-[var(--color-text-muted)]">→</span>
                          <span className="min-w-0 truncate">{remote ? <><span className="mr-2 tabular-nums text-[var(--color-text-muted)]">{remote.discNumber}.{remote.trackNumber}</span>{remote.title}</> : <span className="text-red-500">No match</span>}</span>
                        </label>
                      ))}
                    </div>
                  </section>
                </div>
              )}
            </>
          )}
        </div>

        <div className="flex items-center border-t border-[var(--color-border)] p-4"><span className="text-[10px] text-[var(--color-text-muted)]">Cover art is not fetched</span><button type="button" className="ml-auto px-3 py-2 text-[12px] text-[var(--color-text-secondary)]" onClick={onClose}>Cancel</button><button type="button" className="rounded-[var(--radius-md)] bg-[var(--color-accent)] px-4 py-2 text-[12px] font-semibold text-white disabled:opacity-50" disabled={!release || selectedTrackIds.size === 0 || selectedFields.size === 0 || isApplying} onClick={() => { void applyRelease(); }} data-apply-album-metadata>{isApplying ? "Applying..." : `Apply to ${selectedTrackIds.size} tracks`}</button></div>
      </div>
    </div>, document.body,
  );
};

const Loading = ({ label }: { label: string }) => <div className="flex min-h-32 flex-col items-center justify-center gap-2 text-[11px] text-[var(--color-text-muted)]"><LoaderCircle className="h-5 w-5 animate-spin" />{label}</div>;
const Message = ({ text }: { text: string }) => <div className="flex min-h-32 items-center justify-center text-[11px] text-red-500">{text}</div>;
const Empty = () => <div className="flex min-h-32 flex-col items-center justify-center gap-2 text-[11px] text-[var(--color-text-muted)]"><SearchX className="h-5 w-5" />No matching releases found</div>;
