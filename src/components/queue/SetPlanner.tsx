import {
  ArrowDownRight,
  ArrowUpRight,
  ListPlus,
  Minus,
  Music2,
  RefreshCw,
  Save,
  Sparkles,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { t } from "../../i18n";
import {
  CAMELOT_CODES,
  planDjSet,
  type SetBpmFlow,
  type SetPlan,
} from "../../lib/mix/setPlanner";
import { notify } from "../../stores";
import type { Playlist, Track } from "../../types";
import { toCamelotCode } from "../../utils/camelot";

type SetPlannerProps = {
  playlists: Playlist[];
  tracks: Track[];
  currentPlaylistId?: string;
  onReplaceQueue: (trackIds: string[]) => void;
  onAddToQueue: (trackIds: string[]) => void;
  onCreatePlaylist: (name: string, trackIds: string[]) => Promise<string | null>;
};

const flowIcon = (flow: SetBpmFlow) => {
  if (flow === "rising") return <ArrowUpRight className="h-3.5 w-3.5" />;
  if (flow === "falling") return <ArrowDownRight className="h-3.5 w-3.5" />;
  return <Minus className="h-3.5 w-3.5" />;
};

const formatDuration = (seconds: number) => {
  const minutes = Math.round(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const remainder = minutes % 60;
  return hours > 0 ? `${hours}h ${remainder}m` : `${minutes}m`;
};

export const SetPlanner = ({
  playlists,
  tracks,
  currentPlaylistId,
  onReplaceQueue,
  onAddToQueue,
  onCreatePlaylist,
}: SetPlannerProps) => {
  const trackById = useMemo(
    () => new Map(tracks.map((track) => [track.id, track])),
    [tracks],
  );
  const selectablePlaylists = useMemo(
    () => playlists.filter((playlist) => playlist.trackIds.length > 0),
    [playlists],
  );
  const [playlistId, setPlaylistId] = useState(
    () => currentPlaylistId ?? selectablePlaylists[0]?.id ?? "",
  );
  const [bpmFlow, setBpmFlow] = useState<SetBpmFlow>("rising");
  const [trackCount, setTrackCount] = useState(12);
  const [startTrackId, setStartTrackId] = useState("");
  const [startKey, setStartKey] = useState("");
  const [endKey, setEndKey] = useState("");
  const [plan, setPlan] = useState<SetPlan | null>(null);
  const [playlistName, setPlaylistName] = useState("");
  const [saving, setSaving] = useState(false);

  const selectedPlaylist = playlists.find((playlist) => playlist.id === playlistId) ?? null;
  const playlistTracks = useMemo(
    () => selectedPlaylist?.trackIds
      .map((trackId) => trackById.get(trackId))
      .filter((track): track is Track => Boolean(track)) ?? [],
    [selectedPlaylist, trackById],
  );
  const eligibleStartingTracks = useMemo(
    () => playlistTracks.filter((track) =>
      typeof track.bpm === "number" && Number.isFinite(track.bpm) && track.bpm > 0
    ),
    [playlistTracks],
  );

  useEffect(() => {
    if (playlistId && playlists.some((playlist) => playlist.id === playlistId)) return;
    setPlaylistId(currentPlaylistId ?? selectablePlaylists[0]?.id ?? "");
  }, [currentPlaylistId, playlistId, playlists, selectablePlaylists]);

  useEffect(() => {
    setPlan(null);
    setPlaylistName(selectedPlaylist ? `${selectedPlaylist.name} – DJ Set` : "");
    setTrackCount((current) => Math.max(1, Math.min(current, playlistTracks.length || 12)));
  }, [selectedPlaylist?.id, selectedPlaylist?.name, playlistTracks.length]);

  useEffect(() => {
    setStartTrackId("");
  }, [selectedPlaylist?.id]);

  useEffect(() => {
    if (startTrackId && !eligibleStartingTracks.some((track) => track.id === startTrackId)) {
      setStartTrackId("");
    }
  }, [eligibleStartingTracks, startTrackId]);

  useEffect(() => {
    setPlan(null);
  }, [bpmFlow, endKey, startKey, startTrackId, trackCount]);

  const generate = () => {
    const result = planDjSet(playlistTracks, {
      bpmFlow,
      trackCount: Math.max(1, Math.min(trackCount, playlistTracks.length)),
      startTrackId: startTrackId || null,
      startKey: startKey || null,
      endKey: endKey || null,
    });
    setPlan(result);
    if (result.tracks.length === 0) notify.info(t("setPlanner.noBpm"));
  };

  const savePlaylist = async () => {
    if (!plan?.tracks.length || !playlistName.trim() || saving) return;
    setSaving(true);
    try {
      const playlistId = await onCreatePlaylist(
        playlistName.trim(),
        plan.tracks.map((track) => track.id),
      );
      if (playlistId) notify.success(t("setPlanner.saved", { name: playlistName.trim() }));
    } finally {
      setSaving(false);
    }
  };

  if (selectablePlaylists.length === 0) {
    return (
      <div className="flex min-h-0 flex-1 flex-col items-center justify-center px-7 text-center text-[var(--color-text-muted)]" data-set-planner-empty>
        <Sparkles className="mb-3 h-7 w-7" />
        <p className="text-[13px] font-medium text-[var(--color-text-secondary)]">{t("setPlanner.empty.title")}</p>
        <p className="mt-1 max-w-64 text-[11px] leading-relaxed">{t("setPlanner.empty.description")}</p>
      </div>
    );
  }

  const plannedDuration = plan?.tracks.reduce(
    (total, track) => total + (track.durationSeconds || 0),
    0,
  ) ?? 0;
  const compatibleTransitions = plan?.transitions.filter(
    (transition) => transition.harmonicallyCompatible,
  ).length ?? 0;
  const plannedIds = plan?.tracks.map((track) => track.id) ?? [];

  return (
    <div className="flex min-h-0 flex-1 flex-col" data-set-planner>
      <div className="shrink-0 space-y-3 border-b border-[var(--color-border)] px-4 py-4">
        <div>
          <div className="text-[10px] font-semibold uppercase tracking-[0.1em] text-[var(--color-text-muted)]">{t("setPlanner.source")}</div>
          <select
            className="mt-1.5 h-9 w-full rounded-[var(--radius-sm)] border border-[var(--color-border)] bg-[var(--color-bg-primary)] px-2.5 text-[12px] text-[var(--color-text-primary)]"
            value={playlistId}
            onChange={(event) => setPlaylistId(event.target.value)}
            data-set-planner-playlist
          >
            {selectablePlaylists.map((playlist) => (
              <option key={playlist.id} value={playlist.id}>
                {playlist.name} ({playlist.trackIds.length})
              </option>
            ))}
          </select>
        </div>

        <label className="block min-w-0">
          <span className="mb-1 block text-[9px] font-semibold uppercase tracking-[0.08em] text-[var(--color-text-muted)]">{t("setPlanner.startTrack")}</span>
          <select
            className="h-8 w-full rounded-[var(--radius-sm)] border border-[var(--color-border)] bg-[var(--color-bg-primary)] px-2 text-[11px] text-[var(--color-text-primary)]"
            value={startTrackId}
            onChange={(event) => {
              setStartTrackId(event.target.value);
              if (event.target.value) setStartKey("");
            }}
            data-set-planner-start-track
          >
            <option value="">{t("setPlanner.auto")}</option>
            {eligibleStartingTracks.map((track) => (
              <option key={track.id} value={track.id}>
                {track.title} — {track.artist} · {track.bpm?.toFixed(1)} BPM · {toCamelotCode(track.key) || "—"}
              </option>
            ))}
          </select>
        </label>

        <div className="grid grid-cols-2 gap-2">
          <label className="min-w-0">
            <span className="mb-1 block text-[9px] font-semibold uppercase tracking-[0.08em] text-[var(--color-text-muted)]">{t("setPlanner.bpmFlow")}</span>
            <select
              className="h-8 w-full rounded-[var(--radius-sm)] border border-[var(--color-border)] bg-[var(--color-bg-primary)] px-2 text-[11px] text-[var(--color-text-primary)]"
              value={bpmFlow}
              onChange={(event) => setBpmFlow(event.target.value as SetBpmFlow)}
              data-set-planner-flow
            >
              <option value="rising">{t("setPlanner.flow.rising")}</option>
              <option value="falling">{t("setPlanner.flow.falling")}</option>
              <option value="steady">{t("setPlanner.flow.steady")}</option>
              <option value="flexible">{t("setPlanner.flow.flexible")}</option>
            </select>
          </label>
          <label className="min-w-0">
            <span className="mb-1 block text-[9px] font-semibold uppercase tracking-[0.08em] text-[var(--color-text-muted)]">{t("setPlanner.trackCount")}</span>
            <input
              className="h-8 w-full rounded-[var(--radius-sm)] border border-[var(--color-border)] bg-[var(--color-bg-primary)] px-2 text-[11px] tabular-nums text-[var(--color-text-primary)]"
              min={1}
              max={Math.max(1, playlistTracks.length)}
              type="number"
              value={trackCount}
              onChange={(event) => setTrackCount(Math.max(1, Number(event.target.value) || 1))}
              data-set-planner-count
            />
          </label>
          <label className="min-w-0">
            <span className="mb-1 block text-[9px] font-semibold uppercase tracking-[0.08em] text-[var(--color-text-muted)]">{t("setPlanner.startKey")}</span>
            <select
              className="h-8 w-full rounded-[var(--radius-sm)] border border-[var(--color-border)] bg-[var(--color-bg-primary)] px-2 text-[11px] text-[var(--color-text-primary)]"
              value={startKey}
              onChange={(event) => setStartKey(event.target.value)}
              disabled={Boolean(startTrackId)}
              data-set-planner-start-key
            >
              <option value="">{t("setPlanner.auto")}</option>
              {CAMELOT_CODES.map((code) => <option key={code} value={code}>{code}</option>)}
            </select>
          </label>
          <label className="min-w-0">
            <span className="mb-1 block text-[9px] font-semibold uppercase tracking-[0.08em] text-[var(--color-text-muted)]">{t("setPlanner.endKey")}</span>
            <select
              className="h-8 w-full rounded-[var(--radius-sm)] border border-[var(--color-border)] bg-[var(--color-bg-primary)] px-2 text-[11px] text-[var(--color-text-primary)]"
              value={endKey}
              onChange={(event) => setEndKey(event.target.value)}
              data-set-planner-end-key
            >
              <option value="">{t("setPlanner.auto")}</option>
              {CAMELOT_CODES.map((code) => <option key={code} value={code}>{code}</option>)}
            </select>
          </label>
        </div>

        <button
          className="flex h-9 w-full items-center justify-center gap-2 rounded-[var(--radius-sm)] bg-[var(--color-accent)] px-3 text-[11px] font-semibold text-white transition-colors hover:bg-[var(--color-accent-hover)] disabled:opacity-50"
          disabled={playlistTracks.length === 0}
          onClick={generate}
          type="button"
          data-set-planner-generate
        >
          <RefreshCw className="h-3.5 w-3.5" />
          {t(plan ? "setPlanner.regenerate" : "setPlanner.generate")}
        </button>
      </div>

      {!plan ? (
        <div className="flex min-h-0 flex-1 flex-col items-center justify-center px-7 text-center text-[var(--color-text-muted)]">
          <Music2 className="mb-3 h-6 w-6" />
          <p className="text-[12px] font-medium text-[var(--color-text-secondary)]">{t("setPlanner.ready.title")}</p>
          <p className="mt-1 max-w-64 text-[10px] leading-relaxed">{t("setPlanner.ready.description")}</p>
        </div>
      ) : (
        <>
          <div className="shrink-0 border-b border-[var(--color-border)] px-4 py-3" data-set-planner-summary>
            <div className="flex items-center gap-2">
              <span className="inline-flex items-center gap-1 text-[12px] font-semibold text-[var(--color-text-primary)]">
                {flowIcon(bpmFlow)} {plan.tracks.length} {t("setPlanner.tracks")}
              </span>
              <span className="ml-auto text-[10px] tabular-nums text-[var(--color-text-muted)]">{formatDuration(plannedDuration)}</span>
            </div>
            {plan.tracks.length > 0 && (
              <p className="mt-1 text-[10px] text-[var(--color-text-muted)]">
                {plan.tracks[0].bpm?.toFixed(1)} → {plan.tracks[plan.tracks.length - 1]?.bpm?.toFixed(1)} BPM · {compatibleTransitions}/{plan.transitions.length} {t("setPlanner.harmonicTransitions")}
              </p>
            )}
            {(plan.missingBpmCount > 0 || plan.missingKeyCount > 0 || plan.tracks.length < plan.requestedCount) && (
              <p className="mt-1.5 text-[9px] leading-relaxed text-[var(--color-warning)]" data-set-planner-warning>
                {plan.missingBpmCount > 0 && t("setPlanner.missingBpm", { count: String(plan.missingBpmCount) })}
                {plan.missingBpmCount > 0 && plan.missingKeyCount > 0 ? " · " : ""}
                {plan.missingKeyCount > 0 && t("setPlanner.missingKey", { count: String(plan.missingKeyCount) })}
              </p>
            )}
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto" data-set-planner-results>
            {plan.tracks.map((track, index) => {
              const transition = index > 0 ? plan.transitions[index - 1] : null;
              return (
                <div
                  key={track.id}
                  className="grid min-h-[48px] grid-cols-[22px_minmax(0,1fr)_52px] items-center gap-2 border-b border-[var(--color-border-light)] px-3 py-1.5"
                  data-set-planner-track
                  data-set-planner-track-id={track.id}
                  data-set-planner-bpm={track.bpm}
                  data-set-planner-key={toCamelotCode(track.key) || undefined}
                >
                  <span className="text-center text-[10px] tabular-nums text-[var(--color-text-muted)]">{index + 1}</span>
                  <div className="min-w-0">
                    <div className="truncate text-[11px] font-medium text-[var(--color-text-primary)]">{track.title}</div>
                    <div className="mt-0.5 flex items-center gap-1.5 truncate text-[9px] text-[var(--color-text-muted)]">
                      <span className="truncate">{track.artist}</span>
                      {transition && (
                        <span className={transition.harmonicallyCompatible ? "text-[var(--color-accent)]" : "text-[var(--color-text-muted)]"}>
                          {transition.bpmChange >= 0 ? "+" : ""}{transition.bpmChange.toFixed(1)}
                        </span>
                      )}
                    </div>
                  </div>
                  <div className="text-right tabular-nums">
                    <div className="text-[10px] font-semibold text-[var(--color-accent)]">{toCamelotCode(track.key) || "—"}</div>
                    <div className="mt-0.5 text-[9px] text-[var(--color-text-muted)]">{track.bpm?.toFixed(1) ?? "—"}</div>
                  </div>
                </div>
              );
            })}
          </div>

          <div className="shrink-0 space-y-2 border-t border-[var(--color-border)] p-3">
            <div className="flex gap-2">
              <input
                className="h-8 min-w-0 flex-1 rounded-[var(--radius-sm)] border border-[var(--color-border)] bg-[var(--color-bg-primary)] px-2 text-[10px] text-[var(--color-text-primary)]"
                value={playlistName}
                onChange={(event) => setPlaylistName(event.target.value)}
                aria-label={t("setPlanner.playlistName")}
                data-set-planner-name
              />
              <button
                className="inline-flex h-8 items-center gap-1.5 rounded-[var(--radius-sm)] bg-[var(--color-accent)] px-3 text-[10px] font-semibold text-white disabled:opacity-50"
                disabled={!playlistName.trim() || plannedIds.length === 0 || saving}
                onClick={() => { void savePlaylist(); }}
                type="button"
                data-set-planner-save
              >
                <Save className="h-3 w-3" /> {saving ? t("setPlanner.saving") : t("setPlanner.save")}
              </button>
            </div>
            <div className="grid grid-cols-2 gap-2">
              <button className="h-8 rounded-[var(--radius-sm)] border border-[var(--color-border)] text-[10px] font-medium text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-hover)]" onClick={() => onReplaceQueue(plannedIds)} type="button" data-set-planner-replace-queue>{t("setPlanner.replaceQueue")}</button>
              <button className="inline-flex h-8 items-center justify-center gap-1 rounded-[var(--radius-sm)] border border-[var(--color-border)] text-[10px] font-medium text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-hover)]" onClick={() => onAddToQueue(plannedIds)} type="button" data-set-planner-add-queue><ListPlus className="h-3 w-3" />{t("setPlanner.addQueue")}</button>
            </div>
          </div>
        </>
      )}
    </div>
  );
};
