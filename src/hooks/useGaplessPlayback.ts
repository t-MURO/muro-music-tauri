import { useCallback, useEffect, useRef } from "react";
import { listen } from "@muro/desktop/events";
import type { Track } from "../types";
import { usePlaybackStore, useSettingsStore } from "../stores";
import { isRemoteOutputActive } from "../stores/remoteOutputStore";
import {
  playbackPreloadNext,
  playbackSetCrossfade,
  playbackSetGapless,
  type TrackAdvancedPayload,
} from "../utils/playbackApi";
import { resolveGainFactor } from "../utils/replayGain";

type UseGaplessPlaybackArgs = {
  allTracksById: Map<string, Track>;
  /** Playback list backing the current track, used for the repeat-all wrap. */
  getPlaybackContext: (activeTrackId: string | null) => Track[];
};

/**
 * Keeps the runtime's preload slot pointed at whatever the queue says is next,
 * and commits the queue when the runtime advances on its own.
 *
 * The renderer stays the single source of truth for ordering: the runtime never
 * picks a track, it only holds the one it was handed and reports taking it.
 */
export const useGaplessPlayback = ({
  allTracksById,
  getPlaybackContext,
}: UseGaplessPlaybackArgs) => {
  const gaplessEnabled = useSettingsStore((s) => s.gaplessEnabled);
  const crossfadeSeconds = useSettingsStore((s) => s.crossfadeSeconds);
  const replayGainMode = useSettingsStore((s) => s.replayGainMode);
  const replayGainPreampDb = useSettingsStore((s) => s.replayGainPreampDb);
  const replayGainPreventClipping = useSettingsStore((s) => s.replayGainPreventClipping);

  const currentTrackId = usePlaybackStore((s) => s.currentTrack?.id ?? null);
  const queue = usePlaybackStore((s) => s.queue);
  const playingNext = usePlaybackStore((s) => s.playingNext);
  const repeatMode = usePlaybackStore((s) => s.repeatMode);
  const setQueue = usePlaybackStore((s) => s.setQueue);
  const setPlayingNext = usePlaybackStore((s) => s.setPlayingNext);

  const getPlaybackContextRef = useRef(getPlaybackContext);
  useEffect(() => {
    getPlaybackContextRef.current = getPlaybackContext;
  }, [getPlaybackContext]);

  // Mirror the transport settings into the runtime.
  useEffect(() => {
    playbackSetGapless(gaplessEnabled).catch(() => undefined);
  }, [gaplessEnabled]);

  useEffect(() => {
    // A crossfade needs a staged track to fade into, so it only applies while
    // gapless preloading is on.
    playbackSetCrossfade(gaplessEnabled ? crossfadeSeconds : 0).catch(() => undefined);
  }, [crossfadeSeconds, gaplessEnabled]);

  /** Next track without consuming it — same priority order as advanceToNext. */
  const peekNextTrack = useCallback((): Track | null => {
    const queued = queue.find((trackId) => allTracksById.has(trackId));
    if (queued) return allTracksById.get(queued) ?? null;

    const upcoming = playingNext.find((trackId) => allTracksById.has(trackId));
    if (upcoming) return allTracksById.get(upcoming) ?? null;

    if (repeatMode === "one" && currentTrackId) {
      return allTracksById.get(currentTrackId) ?? null;
    }
    if (repeatMode === "all") {
      // Shuffle picks its next cycle at the boundary, so preloading a specific
      // track would pin an order that has not been decided yet.
      if (usePlaybackStore.getState().shuffleEnabled) return null;
      const [first] = getPlaybackContextRef.current(currentTrackId);
      return first ?? null;
    }
    return null;
  }, [allTracksById, currentTrackId, playingNext, queue, repeatMode]);

  // Stage the next track whenever the queue, the playing track, or the
  // loudness settings change.
  useEffect(() => {
    if (!gaplessEnabled || !currentTrackId || isRemoteOutputActive()) {
      playbackPreloadNext(null).catch(() => undefined);
      return;
    }

    const next = peekNextTrack();
    if (!next || next.id === currentTrackId) {
      // Repeat-one replays the same element; there is nothing to stage.
      playbackPreloadNext(null).catch(() => undefined);
      return;
    }

    playbackPreloadNext({
      id: next.id,
      title: next.title,
      artist: next.artist,
      album: next.album,
      sourcePath: next.sourcePath,
      durationHint: next.durationSeconds,
      coverArtPath: next.coverArtPath,
      coverArtThumbPath: next.coverArtThumbPath,
      gainFactor: resolveGainFactor(next, {
        mode: replayGainMode,
        preampDb: replayGainPreampDb,
        preventClipping: replayGainPreventClipping,
      }),
    }).catch(() => undefined);
  }, [
    currentTrackId,
    gaplessEnabled,
    peekNextTrack,
    replayGainMode,
    replayGainPreampDb,
    replayGainPreventClipping,
  ]);

  // The runtime took the staged track by itself; drop it from the queue here so
  // it is not played twice.
  useEffect(() => {
    let unlisten: (() => void) | null = null;
    let cancelled = false;

    void listen<TrackAdvancedPayload>("muro://track-advanced", (event) => {
      const trackId = event.payload?.track_id;
      if (!trackId) return;

      const state = usePlaybackStore.getState();
      const queueIndex = state.queue.indexOf(trackId);
      if (queueIndex >= 0) {
        setQueue(state.queue.slice(queueIndex + 1));
        setPlayingNext((current) => current.filter((id) => id !== trackId));
        return;
      }

      const upcomingIndex = state.playingNext.indexOf(trackId);
      if (upcomingIndex >= 0) {
        setPlayingNext(state.playingNext.slice(upcomingIndex + 1));
      }
    }).then((remove) => {
      if (cancelled) remove();
      else unlisten = remove;
    });

    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [setPlayingNext, setQueue]);
};
