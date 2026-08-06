import { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { AlertTriangle, CheckCircle2, Fingerprint, LoaderCircle, SearchX } from "lucide-react";
import type { Track, TrackMetadataUpdates } from "../../types";
import type { AcoustIdCandidate, AcoustIdIdentificationResult } from "../../utils/database";
import { coerceArtistCredits } from "../../utils/artistCredits";

type IdentificationStatus = "pending" | "fingerprinting" | "matched" | "no-match" | "failed";
type IdentificationRow = {
  track: Track;
  status: IdentificationStatus;
  candidates: AcoustIdCandidate[];
  selectedCandidateId: string | null;
  cached: boolean;
  error: string | null;
};
type IdentificationField = "title" | "artist" | "artists" | "album" | "year";

type AcoustIdModalProps = {
  tracks: Track[];
  onClose: () => void;
  onIdentify: (track: Track) => Promise<AcoustIdIdentificationResult>;
  onApply: (entries: Array<{ trackId: string; updates: TrackMetadataUpdates }>) => Promise<void>;
};

const fields: Array<{ key: IdentificationField; label: string }> = [
  { key: "title", label: "Title" },
  { key: "artist", label: "Artist" },
  { key: "artists", label: "Album artist" },
  { key: "album", label: "Album" },
  { key: "year", label: "Year" },
];

const candidateLabel = (candidate: AcoustIdCandidate) => [
  `${candidate.title || "Unknown title"} — ${candidate.artist || "Unknown artist"}`,
  candidate.album,
  candidate.year,
].filter(Boolean).join(" · ");

export const AcoustIdModal = ({ tracks, onClose, onIdentify, onApply }: AcoustIdModalProps) => {
  const [rows, setRows] = useState<IdentificationRow[]>([]);
  const [selectedTrackIds, setSelectedTrackIds] = useState<Set<string>>(new Set());
  const [selectedFields, setSelectedFields] = useState<Set<IdentificationField>>(
    () => new Set(fields.map((field) => field.key)),
  );
  const [isApplying, setIsApplying] = useState(false);
  const [applyError, setApplyError] = useState<string | null>(null);
  const trackKey = tracks.map((track) => track.id).join(",");

  useEffect(() => {
    if (tracks.length === 0) return;
    let cancelled = false;
    setApplyError(null);
    setSelectedTrackIds(new Set());
    setRows(tracks.map((track) => ({
      track,
      status: "pending",
      candidates: [],
      selectedCandidateId: null,
      cached: false,
      error: null,
    })));

    void (async () => {
      for (const track of tracks) {
        if (cancelled) return;
        setRows((current) => current.map((row) => row.track.id === track.id
          ? { ...row, status: "fingerprinting" }
          : row));
        try {
          const result = await onIdentify(track);
          if (cancelled) return;
          const firstCandidate = result.candidates[0] ?? null;
          setRows((current) => current.map((row) => row.track.id === track.id
            ? {
                ...row,
                status: firstCandidate ? "matched" : "no-match",
                candidates: result.candidates,
                selectedCandidateId: firstCandidate?.id ?? null,
                cached: result.cached,
              }
            : row));
          if (firstCandidate) {
            setSelectedTrackIds((current) => new Set(current).add(track.id));
          }
        } catch (error) {
          if (cancelled) return;
          setRows((current) => current.map((row) => row.track.id === track.id
            ? {
                ...row,
                status: "failed",
                error: error instanceof Error ? error.message : "Identification failed",
              }
            : row));
        }
      }
    })();
    return () => { cancelled = true; };
    // Track IDs provide the stable identity for this job.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [onIdentify, trackKey]);

  useEffect(() => {
    if (tracks.length === 0) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [onClose, tracks.length]);

  const completed = rows.filter((row) => !["pending", "fingerprinting"].includes(row.status)).length;
  const running = rows.some((row) => row.status === "pending" || row.status === "fingerprinting");
  const matched = rows.filter((row) => row.status === "matched").length;
  const selectedCount = selectedTrackIds.size;

  const selectedEntries = useMemo(() => rows.flatMap((row) => {
    if (!selectedTrackIds.has(row.track.id)) return [];
    const candidate = row.candidates.find((item) => item.id === row.selectedCandidateId);
    if (!candidate) return [];
    const updates: TrackMetadataUpdates = {
      acoustIdId: candidate.acoustidId || undefined,
      musicBrainzTrackId: candidate.recordingId || undefined,
      musicBrainzAlbumId: candidate.releaseId || undefined,
      musicBrainzReleaseGroupId: candidate.releaseGroupId || undefined,
    };
    if (selectedFields.has("title") && candidate.title) updates.title = candidate.title;
    if (selectedFields.has("artist") && candidate.artist) {
      updates.artist = candidate.artist;
      updates.artistCredits = coerceArtistCredits(
        candidate.artistCredits,
        candidate.artist,
      );
    }
    if (selectedFields.has("artists") && candidate.albumArtist) {
      updates.albumArtist = candidate.albumArtist;
      updates.artists = candidate.albumArtist;
      updates.albumArtistCredits = coerceArtistCredits(
        candidate.albumArtistCredits,
        candidate.albumArtist,
      );
    }
    if (selectedFields.has("album") && candidate.album) updates.album = candidate.album;
    if (selectedFields.has("year") && candidate.year) updates.year = candidate.year;
    return [{ trackId: row.track.id, updates }];
  }), [rows, selectedFields, selectedTrackIds]);

  if (tracks.length === 0 || typeof document === "undefined") return null;

  const applyMatches = async () => {
    if (selectedEntries.length === 0 || isApplying) return;
    setIsApplying(true);
    setApplyError(null);
    try {
      await onApply(selectedEntries);
      onClose();
    } catch (error) {
      setApplyError(error instanceof Error ? error.message : "Could not apply identified metadata");
    } finally {
      setIsApplying(false);
    }
  };

  return createPortal(
    <div className="modal-overlay-animate fixed inset-0 z-50 flex items-center justify-center bg-black/45 p-5 backdrop-blur-sm" onClick={onClose} data-acoustid-modal>
      <div className="modal-panel-animate flex max-h-[88vh] w-full max-w-[900px] flex-col overflow-hidden rounded-[var(--radius-lg)] border border-[var(--color-border)] bg-[var(--color-bg-primary)] shadow-[var(--shadow-lg)]" onClick={(event) => event.stopPropagation()}>
        <header className="flex items-start gap-3 border-b border-[var(--color-border)] p-5">
          <span className="grid h-9 w-9 shrink-0 place-items-center rounded-[var(--radius-md)] bg-[var(--color-accent-light)] text-[var(--color-accent)]"><Fingerprint className="h-5 w-5" /></span>
          <div className="min-w-0 flex-1">
            <h2 className="text-[15px] font-semibold text-[var(--color-text-primary)]">Identify with AcoustID</h2>
            <p className="mt-1 text-[11px] text-[var(--color-text-muted)]">
              {running ? `Fingerprinting ${completed + 1} of ${tracks.length} tracks…` : `${matched} of ${tracks.length} tracks identified`}
            </p>
          </div>
          {running && <LoaderCircle className="mt-1 h-5 w-5 animate-spin text-[var(--color-accent)]" />}
        </header>

        <section className="border-b border-[var(--color-border-light)] bg-[var(--color-bg-secondary)] px-5 py-3">
          <div className="flex flex-wrap items-center gap-x-5 gap-y-2">
            <strong className="text-[10px] uppercase tracking-wide text-[var(--color-text-muted)]">Fields to apply</strong>
            {fields.map((field) => (
              <label key={field.key} className="flex cursor-pointer items-center gap-1.5 text-[10px] text-[var(--color-text-secondary)]">
                <input
                  type="checkbox"
                  checked={selectedFields.has(field.key)}
                  onChange={(event) => setSelectedFields((current) => {
                    const next = new Set(current);
                    if (event.target.checked) next.add(field.key); else next.delete(field.key);
                    return next;
                  })}
                />
                {field.label}
              </label>
            ))}
            <span className="ml-auto text-[9px] text-[var(--color-text-muted)]">AcoustID and MusicBrainz IDs are always saved</span>
          </div>
        </section>

        <div className="min-h-0 flex-1 overflow-y-auto p-4">
          <div className="space-y-2">
            {rows.map((row) => {
              const selectedCandidate = row.candidates.find((candidate) => candidate.id === row.selectedCandidateId) ?? null;
              return (
                <article key={row.track.id} className="rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-bg-secondary)] p-3" data-acoustid-row={row.track.id}>
                  <div className="flex items-center gap-3">
                    <input
                      type="checkbox"
                      disabled={row.status !== "matched"}
                      checked={selectedTrackIds.has(row.track.id)}
                      onChange={(event) => setSelectedTrackIds((current) => {
                        const next = new Set(current);
                        if (event.target.checked) next.add(row.track.id); else next.delete(row.track.id);
                        return next;
                      })}
                      aria-label={`Apply identification to ${row.track.title}`}
                    />
                    <span className="min-w-0 flex-1">
                      <strong className="block truncate text-[12px] text-[var(--color-text-primary)]">{row.track.title}</strong>
                      <small className="block truncate text-[10px] text-[var(--color-text-muted)]">{row.track.artist} · {row.track.album}</small>
                    </span>
                    <StatusIcon status={row.status} />
                    {selectedCandidate && <span className="rounded-full bg-[var(--color-accent-light)] px-2 py-1 text-[9px] font-semibold tabular-nums text-[var(--color-accent)]">{Math.round(selectedCandidate.score * 100)}%</span>}
                  </div>
                  {row.status === "matched" && (
                    <div className="mt-3 ml-7">
                      <select
                        className="h-9 w-full rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-bg-primary)] px-2.5 text-[11px] text-[var(--color-text-primary)] outline-none focus:border-[var(--color-accent)]"
                        value={row.selectedCandidateId ?? ""}
                        onChange={(event) => setRows((current) => current.map((item) => item.track.id === row.track.id ? { ...item, selectedCandidateId: event.target.value } : item))}
                        data-acoustid-candidate-select
                      >
                        {row.candidates.map((candidate) => <option key={candidate.id} value={candidate.id}>{candidateLabel(candidate)} · {Math.round(candidate.score * 100)}%</option>)}
                      </select>
                      {row.cached && <span className="mt-1 block text-[9px] text-[var(--color-text-muted)]">Loaded from local fingerprint cache</span>}
                    </div>
                  )}
                  {row.status === "no-match" && <p className="mt-2 ml-7 text-[10px] text-[var(--color-text-muted)]">No linked MusicBrainz recording was found.</p>}
                  {row.error && <p className="mt-2 ml-7 text-[10px] text-red-500">{row.error}</p>}
                </article>
              );
            })}
          </div>
        </div>

        <footer className="flex items-center gap-3 border-t border-[var(--color-border)] p-4">
          <span className="min-w-0 flex-1 text-[10px] text-[var(--color-text-muted)]">
            {applyError ? <span className="text-red-500">{applyError}</span> : "Review matches before writing tags to your files."}
          </span>
          <button className="px-3 py-2 text-[12px] text-[var(--color-text-secondary)]" onClick={onClose} type="button">Cancel</button>
          <button
            className="rounded-[var(--radius-md)] bg-[var(--color-accent)] px-4 py-2 text-[12px] font-semibold text-white disabled:cursor-not-allowed disabled:opacity-50"
            disabled={running || selectedCount === 0 || isApplying}
            onClick={() => { void applyMatches(); }}
            data-apply-acoustid
            type="button"
          >
            {isApplying ? "Applying…" : `Apply ${selectedCount} ${selectedCount === 1 ? "match" : "matches"}`}
          </button>
        </footer>
      </div>
    </div>,
    document.body,
  );
};

const StatusIcon = ({ status }: { status: IdentificationStatus }) => {
  if (status === "pending" || status === "fingerprinting") return <LoaderCircle className="h-4 w-4 animate-spin text-[var(--color-text-muted)]" />;
  if (status === "matched") return <CheckCircle2 className="h-4 w-4 text-emerald-500" />;
  if (status === "no-match") return <SearchX className="h-4 w-4 text-[var(--color-text-muted)]" />;
  return <AlertTriangle className="h-4 w-4 text-red-500" />;
};
