import { useCallback, useEffect, useRef } from "react";
import type { Track } from "../types";
import {
  useLibraryStore,
  usePlaybackStore,
  useSettingsStore,
  notify,
  type TransitionUiState,
} from "../stores";
import { getOrComputeBeatGrid, type BeatGrid } from "../lib/beatgrid";
import { planTransition } from "../lib/mix/plan";
import { playbackCancelTransition, playbackTransitionTo } from "../utils/playbackApi";
import { resolveGainFactor } from "../utils/replayGain";
import { useDbPath } from "./useDbPath";
import { t } from "../i18n";

type UseMixTransitionArgs = {
  enabled: boolean;
  allTracks: Track[];
  playTrack: (track: Track) => Promise<void>;
  seek: (positionSecs: number) => Promise<void>;
};

const toTransitionTarget = (track: Track) => ({
  id: track.id,
  title: track.title,
  artist: track.artist,
  album: track.album,
  sourcePath: track.sourcePath,
  durationHint: track.durationSeconds,
  coverArtPath: track.coverArtPath,
  coverArtThumbPath: track.coverArtThumbPath,
  gainFactor: resolveGainFactor(track, {
    mode: useSettingsStore.getState().replayGainMode,
    preampDb: useSettingsStore.getState().replayGainPreampDb,
    preventClipping: useSettingsStore.getState().replayGainPreventClipping,
  }),
});

export const useMixTransition = ({ enabled, allTracks, playTrack, seek }: UseMixTransitionArgs) => {
  const transition: TransitionUiState | null = usePlaybackStore((s) => s.transition);
  const setTransition = usePlaybackStore((s) => s.setTransition);
  const setQueue = usePlaybackStore((s) => s.setQueue);
  const isPlaying = usePlaybackStore((s) => s.isPlaying);
  const currentTrackId = usePlaybackStore((s) => s.currentTrack?.id ?? null);
  const nextQueuedId = usePlaybackStore((s) => (s.queue.length > 0 ? s.queue[0] : null));
  const autoMix = useSettingsStore((s) => s.autoMix);
  const mixBars = useSettingsStore((s) => s.mixBars);
  const mixPreservePitch = useSettingsStore((s) => s.mixPreservePitch);
  const getDbPath = useDbPath();

  // Guards shared between the manual and auto-mix paths.
  const manualMixInFlightRef = useRef(false);
  const autoMixGenRef = useRef(0);
  const autoMixKeyRef = useRef<string | null>(null);
  const autoArmedRef = useRef(false);
  const autoArmPendingRef = useRef(false);

  // Computes (or reuses) a beat grid and mirrors it into the library store.
  // Returns null when analysis fails so the transition degrades to a fade.
  const resolveGrid = useCallback(
    async (track: Track): Promise<BeatGrid | null> => {
      try {
        const dbPath = await getDbPath();
        const grid = await getOrComputeBeatGrid(track, dbPath);
        useLibraryStore.getState().updateTrack(track.id, { beatGrid: grid });
        return grid;
      } catch (error) {
        console.warn(`Beat-grid analysis failed for ${track.title}:`, error);
        return null;
      }
    },
    [getDbPath]
  );

  const cancelAutomaticMix = useCallback(async () => {
    autoMixGenRef.current += 1;
    if (!autoArmedRef.current && !autoArmPendingRef.current) return;
    autoArmedRef.current = false;
    autoArmPendingRef.current = false;
    await playbackCancelTransition().catch(() => undefined);
  }, []);

  const prepareTransition = useCallback(async (a: Track, b: Track) => {
    const gridA = await resolveGrid(a);
    const gridB = await resolveGrid(b);
    const failedTitles = [gridA ? null : a.title, gridB ? null : b.title].filter(
      (title): title is string => title !== null
    );
    if (failedTitles.length > 0) {
      notify.error(t("toast.mix.beatAnalysisFailed", { titles: failedTitles.join(", ") }));
    }
    const plan = planTransition({
      gridA,
      gridB,
      durationASec: a.durationSeconds,
      durationBSec: b.durationSeconds,
      bars: mixBars,
    });
    return { gridA, gridB, plan };
  }, [mixBars, resolveGrid]);

  const reportFallbackMode = useCallback((gridA: BeatGrid | null, gridB: BeatGrid | null) => {
    notify.info(
      gridA && gridB
        ? "Tempos too far apart - using a simple blend"
        : "Beat analysis unavailable - using a simple blend"
    );
  }, []);

  const mixSelectedPair = useCallback(
    async (trackIds: string[]) => {
      if (!enabled) return;
      if (manualMixInFlightRef.current) return;
      if (trackIds.length !== 2) {
        notify.error(t("toast.mix.needsTwoTracks"));
        return;
      }
      const a = allTracks.find((track) => track.id === trackIds[0]);
      const b = allTracks.find((track) => track.id === trackIds[1]);
      if (!a || !b) {
        notify.error(t("toast.tracks.notFound"));
        return;
      }

      manualMixInFlightRef.current = true;
      await cancelAutomaticMix();
      try {
        notify.info(t("toast.mix.analyzing"));
        const { gridA, gridB, plan } = await prepareTransition(a, b);

        await playTrack(a);
        await seek(Math.max(0, plan.startAtSec - 10));
        await playbackTransitionTo(toTransitionTarget(b), plan, mixPreservePitch);

        if (plan.mode === "fade") {
          notify.info(
            gridA && gridB
              ? "Tempos too far apart — using a simple blend"
              : "Beat analysis unavailable — using a simple blend"
          );
        }
      } catch {
        notify.error(t("toast.mix.startFailed"));
      } finally {
        manualMixInFlightRef.current = false;
      }
    },
    [
      allTracks,
      cancelAutomaticMix,
      enabled,
      mixPreservePitch,
      playTrack,
      prepareTransition,
      seek,
    ]
  );

  const mixCurrentWith = useCallback(async (nextTrackId: string) => {
    if (!enabled || manualMixInFlightRef.current) return;
    const playback = usePlaybackStore.getState();
    const outgoingId = playback.currentTrack?.id;
    if (!playback.isPlaying || !outgoingId) {
      notify.error(t("toast.mix.needsPlayingTrack"));
      return;
    }
    const automaticTransition = autoArmedRef.current || autoArmPendingRef.current;
    if (playback.transition !== null && !automaticTransition) {
      notify.info(t("toast.mix.alreadyRunning"));
      return;
    }
    if (outgoingId === nextTrackId) {
      notify.error(t("toast.mix.chooseOther"));
      return;
    }
    const outgoing = allTracks.find((track) => track.id === outgoingId);
    const incoming = allTracks.find((track) => track.id === nextTrackId);
    if (!outgoing || !incoming) {
      notify.error(t("toast.tracks.notFound"));
      return;
    }

    manualMixInFlightRef.current = true;
    await cancelAutomaticMix();
    try {
      notify.info(t("toast.mix.analyzing"));
      const { gridA, gridB, plan } = await prepareTransition(outgoing, incoming);
      const latestPlayback = usePlaybackStore.getState();
      if (!latestPlayback.isPlaying || latestPlayback.currentTrack?.id !== outgoing.id) {
        notify.error(t("toast.mix.trackChanged"));
        return;
      }
      const transitionEnd = plan.startAtSec + plan.durationSec;
      if (latestPlayback.currentPosition >= transitionEnd - 0.5) {
        notify.error(t("toast.mix.tooCloseToEnd"));
        return;
      }

      await playbackTransitionTo(toTransitionTarget(incoming), plan, mixPreservePitch);
      if (plan.mode === "fade") reportFallbackMode(gridA, gridB);
    } catch {
      notify.error(t("toast.mix.startFailed"));
    } finally {
      manualMixInFlightRef.current = false;
    }
  }, [
    allTracks,
    cancelAutomaticMix,
    enabled,
    mixPreservePitch,
    prepareTransition,
    reportFallbackMode,
  ]);

  // Clear finished transitions and advance the queue when the mix engine
  // handed playback to the queued track.
  useEffect(() => {
    if (transition?.status !== "completed") return;
    const currentQueue = usePlaybackStore.getState().queue;
    if (currentQueue.length > 0 && currentQueue[0] === transition.toId) {
      setQueue((queue) => queue.slice(1));
    }
    autoArmedRef.current = false;
    setTransition(null);
  }, [transition, setQueue, setTransition]);

  // Auto-mix: arm a transition into queue[0] whenever a track is playing.
  useEffect(() => {
    if (!enabled || !autoMix) {
      autoMixKeyRef.current = null;
      autoMixGenRef.current += 1;
      if (autoArmedRef.current || autoArmPendingRef.current) {
        autoArmedRef.current = false;
        autoArmPendingRef.current = false;
        void playbackCancelTransition().catch(() => {});
      }
      return;
    }

    const key = `${currentTrackId ?? ""}→${nextQueuedId ?? ""}`;
    if (key !== autoMixKeyRef.current) {
      // The playing track or the next queued track changed: drop any
      // previously auto-armed transition before re-arming below.
      autoMixKeyRef.current = key;
      autoMixGenRef.current += 1;
      if (autoArmedRef.current || autoArmPendingRef.current) {
        autoArmedRef.current = false;
        autoArmPendingRef.current = false;
        void playbackCancelTransition().catch(() => {});
      }
    }

    // Only auto-arm when nothing (manual or auto) is armed or active.
    if (transition !== null) return;
    if (manualMixInFlightRef.current) return;
    if (autoArmedRef.current || autoArmPendingRef.current) return;
    if (!isPlaying || !currentTrackId || !nextQueuedId) return;

    const current = allTracks.find((track) => track.id === currentTrackId);
    const next = allTracks.find((track) => track.id === nextQueuedId);
    if (!current || !next) return;

    const generation = autoMixGenRef.current;
    autoArmPendingRef.current = true;
    void (async () => {
      try {
        const gridA = await resolveGrid(current);
        if (generation !== autoMixGenRef.current) return;
        const gridB = await resolveGrid(next);
        if (generation !== autoMixGenRef.current) return;
        if (manualMixInFlightRef.current) return;
        if (usePlaybackStore.getState().transition !== null) return;

        const plan = planTransition({
          gridA,
          gridB,
          durationASec: current.durationSeconds,
          durationBSec: next.durationSeconds,
          bars: mixBars,
        });
        await playbackTransitionTo(toTransitionTarget(next), plan, mixPreservePitch);
        if (generation !== autoMixGenRef.current || !enabled || !autoMix) {
          await playbackCancelTransition().catch(() => undefined);
          return;
        }
        autoArmedRef.current = true;
      } catch {
        // Auto-mix arming is best effort; the natural track end still advances.
      } finally {
        if (generation === autoMixGenRef.current) {
          autoArmPendingRef.current = false;
        }
      }
    })();
  }, [
    allTracks,
    autoMix,
    currentTrackId,
    enabled,
    isPlaying,
    mixBars,
    mixPreservePitch,
    nextQueuedId,
    resolveGrid,
    transition,
  ]);

  return { mixCurrentWith, mixSelectedPair, transition: enabled ? transition : null };
};
