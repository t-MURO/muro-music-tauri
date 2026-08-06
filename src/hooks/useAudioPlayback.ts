import { useCallback, useEffect, useRef } from "react";
import { listen } from "@muro/desktop/events";
import { t } from "../i18n";
import type { Track } from "../types";
import {
  useLibraryStore,
  usePlaybackStore,
  trackToCurrentTrack,
  notify,
  useSettingsStore,
} from "../stores";
import {
  useRemoteOutputStore,
  isRemoteOutputActive,
  activeRemoteProtocol,
} from "../stores/remoteOutputStore";
import {
  playbackGetState,
  playbackPause,
  playbackPlay,
  playbackPlayFile,
  playbackSeek,
  playbackSetOutputDevice,
  playbackSetSeekMode,
  playbackSetTrackGain,
  playbackSetVolume,
  playbackToggle,
  type PlaybackState,
} from "../utils";
import type { TransitionStatePayload } from "../utils/playbackApi";
import { resolveGainFactor } from "../utils/replayGain";
import { disconnectFromRemote } from "../utils/remoteOutputController";
import {
  isRemoteUnsupportedFormat,
  remoteGetStates,
  remoteLoadTrack,
  remotePause,
  remotePlay,
  remoteSeek,
  remoteSetVolume,
  type RemoteDiscoverySnapshot,
  type RemoteMediaStatusEvent,
  type RemoteOutputProtocol,
  type RemoteSessionState,
} from "../utils/remoteOutputApi";

// Keep the playback track type available to hook consumers.
export type { CurrentTrack } from "../stores";

export type AudioPlaybackState = {
  isPlaying: boolean;
  currentPosition: number;
  duration: number;
  volume: number;
  currentTrack: ReturnType<typeof usePlaybackStore.getState>["currentTrack"];
};

type UseAudioPlaybackOptions = {
  onTrackEnd?: () => void;
  onMediaControl?: (action: string) => void;
  seekMode?: "fast" | "accurate";
};

type MediaControlEvent = string | {
  action?: string;
  source?: string;
};

export const useAudioPlayback = (options: UseAudioPlaybackOptions = {}) => {
  const { onTrackEnd, onMediaControl, seekMode } = options;

  // Get state and actions from store
  const isPlaying = usePlaybackStore((s) => s.isPlaying);
  const currentTrack = usePlaybackStore((s) => s.currentTrack);
  const currentPosition = usePlaybackStore((s) => s.currentPosition);
  const duration = usePlaybackStore((s) => s.duration);
  const volume = usePlaybackStore((s) => s.volume);
  const replayGainMode = useSettingsStore((s) => s.replayGainMode);
  const replayGainPreampDb = useSettingsStore((s) => s.replayGainPreampDb);
  const replayGainPreventClipping = useSettingsStore((s) => s.replayGainPreventClipping);

  const setIsPlaying = usePlaybackStore((s) => s.setIsPlaying);
  const setCurrentTrack = usePlaybackStore((s) => s.setCurrentTrack);
  const setCurrentPosition = usePlaybackStore((s) => s.setCurrentPosition);
  const setDuration = usePlaybackStore((s) => s.setDuration);
  const setVolume = usePlaybackStore((s) => s.setVolume);
  const setTransition = usePlaybackStore((s) => s.setTransition);

  // Use refs for callbacks to avoid effect re-runs
  const onTrackEndRef = useRef(onTrackEnd);
  const onMediaControlRef = useRef(onMediaControl);
  const latestGlobalMediaControlRef = useRef<Map<string, number>>(new Map());
  const pendingMediaSessionControlsRef = useRef<Set<{
    group: string;
    receivedAt: number;
    timeoutId: number;
  }>>(new Set());

  useEffect(() => {
    onTrackEndRef.current = onTrackEnd;
  }, [onTrackEnd]);

  useEffect(() => {
    onMediaControlRef.current = onMediaControl;
  }, [onMediaControl]);

  // Convert the playback runtime state to the store format.
  const updateFromPlaybackState = useCallback(
    (playbackState: PlaybackState) => {
      setIsPlaying(playbackState.is_playing);
      setCurrentPosition(playbackState.current_position);
      setDuration(playbackState.duration);
      setVolume(playbackState.volume);

      if (playbackState.current_track) {
        setCurrentTrack({
          id: playbackState.current_track.id,
          title: playbackState.current_track.title,
          artist: playbackState.current_track.artist,
          album: playbackState.current_track.album,
          sourcePath: playbackState.current_track.source_path,
          durationSeconds: playbackState.duration,
          coverArtPath: playbackState.current_track.cover_art_path,
          coverArtThumbPath: playbackState.current_track.cover_art_thumb_path,
        });
      } else {
        setCurrentTrack(null);
      }
    },
    [setIsPlaying, setCurrentPosition, setDuration, setVolume, setCurrentTrack]
  );

  // Listen for playback state updates from the desktop runtime.
  useEffect(() => {
    let cancelled = false;
    let removeListeners: (() => void) | null = null;

    const handleRemoteMediaStatus = (
      protocol: RemoteOutputProtocol,
      { status, finished }: RemoteMediaStatusEvent,
    ) => {
      useRemoteOutputStore.getState().applyMediaStatus(protocol, status);
      if (activeRemoteProtocol() === protocol && isRemoteOutputActive()) {
        setCurrentPosition(status.position);
        if (typeof status.duration === "number" && status.duration > 0) {
          setDuration(status.duration);
        }
        setIsPlaying(status.playerState === "playing" || status.playerState === "buffering");
        if (finished) onTrackEndRef.current?.();
      }
    };

    const setup = async () => {
      const listeners = await Promise.all([
        // While a remote output (Cast or DLNA) is active the device's status
        // drives the store; events from the (paused) local element are ignored.
        listen<PlaybackState>("muro://playback-state", (event) => {
          if (isRemoteOutputActive()) return;
          updateFromPlaybackState(event.payload);
        }),
        listen<number>("muro://playback-position", (event) => {
          if (isRemoteOutputActive()) return;
          setCurrentPosition(event.payload);
        }),
        listen<RemoteDiscoverySnapshot>("muro://cast-devices", (event) => {
          useRemoteOutputStore.getState().applyDiscovery("cast", event.payload);
        }),
        listen<RemoteDiscoverySnapshot>("muro://dlna-devices", (event) => {
          useRemoteOutputStore.getState().applyDiscovery("dlna", event.payload);
        }),
        listen<RemoteSessionState>("muro://cast-state", (event) => {
          const wasActive = activeRemoteProtocol() === "cast";
          useRemoteOutputStore.getState().applySessionState("cast", event.payload);
          if (wasActive && event.payload.state === "error") {
            setIsPlaying(false);
            void disconnectFromRemote().catch(() => undefined);
          }
        }),
        listen<RemoteSessionState>("muro://dlna-state", (event) => {
          const wasActive = activeRemoteProtocol() === "dlna";
          useRemoteOutputStore.getState().applySessionState("dlna", event.payload);
          if (wasActive && event.payload.state === "error") {
            setIsPlaying(false);
            void disconnectFromRemote().catch(() => undefined);
          }
        }),
        listen<RemoteMediaStatusEvent>("muro://cast-media-status", (event) => {
          handleRemoteMediaStatus("cast", event.payload);
        }),
        listen<RemoteMediaStatusEvent>("muro://dlna-media-status", (event) => {
          handleRemoteMediaStatus("dlna", event.payload);
        }),
        listen<MediaControlEvent>("muro://media-control", (event) => {
          const action = typeof event.payload === "string"
            ? event.payload
            : event.payload?.action;
          if (!action) return;

          const source = typeof event.payload === "string"
            ? "legacy"
            : event.payload.source ?? "unknown";
          const group = action === "play" || action === "pause" || action === "toggle"
            ? "playback"
            : action;
          const receivedAt = performance.now();

          if (source === "global-shortcut") {
            latestGlobalMediaControlRef.current.set(group, receivedAt);
            for (const pending of pendingMediaSessionControlsRef.current) {
              if (pending.group !== group) continue;
              window.clearTimeout(pending.timeoutId);
              pendingMediaSessionControlsRef.current.delete(pending);
            }
            onMediaControlRef.current?.(action);
            return;
          }

          if (source === "media-session") {
            const latestGlobal = latestGlobalMediaControlRef.current.get(group) ?? -Infinity;
            if (receivedAt - latestGlobal < 250) return;

            const pending = {
              group,
              receivedAt,
              timeoutId: 0,
            };
            pending.timeoutId = window.setTimeout(() => {
              pendingMediaSessionControlsRef.current.delete(pending);
              const globalAfterEvent = latestGlobalMediaControlRef.current.get(group) ?? -Infinity;
              if (globalAfterEvent >= receivedAt && globalAfterEvent - receivedAt < 250) return;
              onMediaControlRef.current?.(action);
            }, 60);
            pendingMediaSessionControlsRef.current.add(pending);
            return;
          }

          onMediaControlRef.current?.(action);
        }),
        listen("muro://track-ended", () => {
          if (isRemoteOutputActive()) return;
          onTrackEndRef.current?.();
        }),
        listen<TransitionStatePayload>("muro://transition-state", (event) => {
          const { status, progress, from_id, to_id, to_title } = event.payload;
          if (status === "cancelled") {
            setTransition(null);
            return;
          }
          setTransition({
            status,
            fromId: from_id,
            toId: to_id,
            toTitle: to_title,
            progress,
          });
        }),
      ]);

      const cleanup = () => listeners.forEach((removeListener) => removeListener());
      if (cancelled) {
        cleanup();
        return;
      }
      removeListeners = cleanup;

      // Recover remote session state first (survives a renderer reload).
      try {
        const states = await remoteGetStates();
        if (!cancelled) {
          const store = useRemoteOutputStore.getState();
          if (states.cast) {
            store.applySessionState("cast", states.cast);
            store.applyDiscovery("cast", states.cast.discovery);
          }
          if (states.dlna) {
            store.applySessionState("dlna", states.dlna);
            store.applyDiscovery("dlna", states.dlna.discovery);
          }
        }
      } catch {
        // The desktop bridge may predate remote outputs; local playback works.
      }

      // Get initial state
      try {
        const initialState = await playbackGetState();
        if (!cancelled && !isRemoteOutputActive()) updateFromPlaybackState(initialState);
      } catch (error) {
        if (!cancelled) notify.error(t("toast.playback.stateFailed"));
      }
    };

    void setup();

    return () => {
      cancelled = true;
      removeListeners?.();
      for (const pending of pendingMediaSessionControlsRef.current) {
        window.clearTimeout(pending.timeoutId);
      }
      pendingMediaSessionControlsRef.current.clear();
    };
  }, [setCurrentPosition, setTransition, updateFromPlaybackState]);

  useEffect(() => {
    if (!seekMode) {
      return;
    }
    playbackSetSeekMode(seekMode).catch(() => {
      notify.error(t("toast.playback.seekModeFailed"));
    });
  }, [seekMode]);

  useEffect(() => {
    if (!currentTrack || isRemoteOutputActive()) return;
    const library = useLibraryStore.getState();
    const track = [...library.tracks, ...library.inboxTracks]
      .find((candidate) => candidate.id === currentTrack.id);
    if (!track) return;
    void playbackSetTrackGain(resolveGainFactor(track, {
      mode: replayGainMode,
      preampDb: replayGainPreampDb,
      preventClipping: replayGainPreventClipping,
    })).catch(() => undefined);
  }, [
    currentTrack?.id,
    replayGainMode,
    replayGainPreampDb,
    replayGainPreventClipping,
  ]);

  // Restore the persisted local output device once at startup.
  useEffect(() => {
    const { audioOutputDeviceId } = useSettingsStore.getState();
    if (audioOutputDeviceId) {
      playbackSetOutputDevice(audioOutputDeviceId).catch(() => {
        // The device may be unplugged; playback falls back to the default.
      });
    }
  }, []);

  // Commands below route to exactly one output: the remote device while a
  // Cast/DLNA session owns playback, the local audio element otherwise.
  const playTrack = useCallback(
    async (track: Track) => {
      const protocol = activeRemoteProtocol();
      if (protocol && isRemoteOutputActive()) {
        try {
          await remoteLoadTrack(protocol, {
            trackId: track.id,
            sourcePath: track.sourcePath,
            title: track.title,
            artist: track.artist,
            album: track.album,
            durationSeconds: track.durationSeconds,
            coverArtPath: track.coverArtPath,
            startPositionSecs: 0,
            autoplay: true,
          });
          setIsPlaying(true);
          setCurrentPosition(0);
          setDuration(track.durationSeconds);
          setCurrentTrack(trackToCurrentTrack(track));
        } catch (error) {
          notify.error(
            isRemoteUnsupportedFormat(error)
              ? t("player.output.unsupported")
              : t("player.output.loadFailed"),
          );
        }
        return;
      }
      try {
        const {
          replayGainMode,
          replayGainPreampDb,
          replayGainPreventClipping,
        } = useSettingsStore.getState();
        await playbackPlayFile(
          track.id,
          track.title,
          track.artist,
          track.album,
          track.sourcePath,
          track.durationSeconds,
          track.coverArtPath,
          track.coverArtThumbPath,
          // Remote outputs render at the device's own level; loudness
          // normalization only applies to local playback.
          resolveGainFactor(track, {
            mode: replayGainMode,
            preampDb: replayGainPreampDb,
            preventClipping: replayGainPreventClipping,
          })
        );
        setIsPlaying(true);
        setCurrentPosition(0);
        setDuration(track.durationSeconds);
        setCurrentTrack(trackToCurrentTrack(track));
      } catch (error) {
        notify.error(t("toast.playback.playTrackFailed"));
      }
    },
    [setIsPlaying, setCurrentPosition, setDuration, setCurrentTrack]
  );

  const togglePlay = useCallback(async () => {
    const protocol = activeRemoteProtocol();
    if (protocol && isRemoteOutputActive()) {
      const remoteState = useRemoteOutputStore.getState().remoteMedia?.playerState;
      try {
        if (remoteState === "playing" || remoteState === "buffering") {
          await remotePause(protocol);
          setIsPlaying(false);
        } else {
          await remotePlay(protocol);
          setIsPlaying(true);
        }
      } catch (error) {
        notify.error(t("player.output.commandFailed"));
      }
      return;
    }
    try {
      const isNowPlaying = await playbackToggle();
      setIsPlaying(isNowPlaying);
    } catch (error) {
      notify.error(t("toast.playback.toggleFailed"));
    }
  }, [setIsPlaying]);

  const play = useCallback(async () => {
    const protocol = activeRemoteProtocol();
    if (protocol && isRemoteOutputActive()) {
      try {
        await remotePlay(protocol);
        setIsPlaying(true);
      } catch (error) {
        notify.error(t("player.output.commandFailed"));
      }
      return;
    }
    try {
      await playbackPlay();
      setIsPlaying(true);
    } catch (error) {
      notify.error(t("toast.playback.playFailed"));
    }
  }, [setIsPlaying]);

  const pause = useCallback(async () => {
    const protocol = activeRemoteProtocol();
    if (protocol && isRemoteOutputActive()) {
      try {
        await remotePause(protocol);
        setIsPlaying(false);
      } catch (error) {
        notify.error(t("player.output.commandFailed"));
      }
      return;
    }
    try {
      await playbackPause();
      setIsPlaying(false);
    } catch (error) {
      notify.error(t("toast.playback.pauseFailed"));
    }
  }, [setIsPlaying]);

  const seek = useCallback(
    async (positionSecs: number) => {
      const protocol = activeRemoteProtocol();
      if (protocol && isRemoteOutputActive()) {
        try {
          await remoteSeek(protocol, positionSecs);
          setCurrentPosition(positionSecs);
        } catch (error) {
          notify.error(t("player.output.commandFailed"));
        }
        return;
      }
      try {
        await playbackSeek(positionSecs);
        setCurrentPosition(positionSecs);
      } catch (error) {
        notify.error(t("toast.playback.seekFailed"));
      }
    },
    [setCurrentPosition]
  );

  const handleSetVolume = useCallback(
    async (newVolume: number) => {
      const clamped = Math.max(0, Math.min(1, newVolume));
      const protocol = activeRemoteProtocol();
      if (protocol && isRemoteOutputActive()) {
        try {
          await remoteSetVolume(protocol, clamped);
          setVolume(clamped);
        } catch (error) {
          notify.error(t("player.output.commandFailed"));
        }
        return;
      }
      try {
        await playbackSetVolume(clamped);
        setVolume(clamped);
      } catch (error) {
        notify.error(t("toast.playback.volumeFailed"));
      }
    },
    [setVolume]
  );

  return {
    isPlaying,
    currentPosition,
    duration,
    volume,
    currentTrack,
    playTrack,
    togglePlay,
    play,
    pause,
    seek,
    setVolume: handleSetVolume,
  };
};
