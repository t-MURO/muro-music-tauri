import { invoke } from "@muro/desktop/runtime";
import type { TransitionPlan } from "../lib/mix/plan";

// ============================================================================
// Types
// ============================================================================

export type PlaybackState = {
  is_playing: boolean;
  current_position: number;
  duration: number;
  volume: number;
  current_track: {
    id: string;
    title: string;
    artist: string;
    album: string;
    source_path: string;
    cover_art_path?: string;
    cover_art_thumb_path?: string;
  } | null;
};

// ============================================================================
// Playback Control
// ============================================================================

export const playbackPlayFile = (
  id: string,
  title: string,
  artist: string,
  album: string,
  sourcePath: string,
  durationHint: number,
  coverArtPath?: string,
  coverArtThumbPath?: string,
  gainFactor = 1
) => {
  return invoke<void>("playback_play_file", {
    id,
    title,
    artist,
    album,
    sourcePath,
    durationHint,
    coverArtPath,
    coverArtThumbPath,
    gainFactor,
  });
};

// ============================================================================
// Gapless, crossfade, and loudness
// ============================================================================

export type PreloadTrackPayload = {
  id: string;
  title: string;
  artist: string;
  album: string;
  sourcePath: string;
  durationHint: number;
  coverArtPath?: string;
  coverArtThumbPath?: string;
  gainFactor: number;
};

/** Emitted when the runtime advanced to the preloaded track by itself. */
export type TrackAdvancedPayload = {
  track_id: string;
  reason: "gapless" | "crossfade";
};

/** Pass null to drop whatever is currently staged. */
export const playbackPreloadNext = (track: PreloadTrackPayload | null) => {
  return invoke<void>("playback_preload_next", { track });
};

export const playbackClearPreload = () => {
  return invoke<void>("playback_clear_preload");
};

export const playbackSetGapless = (enabled: boolean) => {
  return invoke<void>("playback_set_gapless", { enabled });
};

export const playbackSetCrossfade = (seconds: number) => {
  return invoke<void>("playback_set_crossfade", { seconds });
};

export const playbackSetTrackGain = (gainFactor: number) => {
  return invoke<void>("playback_set_track_gain", { gainFactor });
};

export const playbackToggle = () => {
  return invoke<boolean>("playback_toggle");
};

export const playbackPlay = () => {
  return invoke<void>("playback_play");
};

export const playbackPause = () => {
  return invoke<void>("playback_pause");
};

export const playbackStop = () => {
  return invoke<void>("playback_stop");
};

export const playbackSeek = (positionSecs: number) => {
  return invoke<void>("playback_seek", { positionSecs });
};

export const playbackSetVolume = (volume: number) => {
  return invoke<void>("playback_set_volume", { volume });
};

export const playbackSetSeekMode = (mode: "fast" | "accurate") => {
  return invoke<void>("playback_set_seek_mode", { mode });
};

// deviceId "" selects the system default output.
export const playbackSetOutputDevice = (deviceId: string) => {
  return invoke<void>("playback_set_output_device", { deviceId });
};

export const playbackGetOutputDevice = () => {
  return invoke<string>("playback_get_output_device");
};

export const playbackGetState = () => {
  return invoke<PlaybackState>("playback_get_state");
};

export const playbackIsFinished = () => {
  return invoke<boolean>("playback_is_finished");
};

// ============================================================================
// DJ Transitions
// ============================================================================

export type TransitionStatePayload = {
  status: "armed" | "active" | "completed" | "cancelled";
  progress: number;
  from_id: string;
  to_id: string;
  to_title: string;
};

export const playbackTransitionTo = (
  track: {
    id: string;
    title: string;
    artist: string;
    album: string;
    sourcePath: string;
    durationHint: number;
    coverArtPath?: string;
    coverArtThumbPath?: string;
    gainFactor?: number;
  },
  plan: TransitionPlan,
  preservePitch = true
) => {
  return invoke<void>("playback_transition_to", { track, plan, preservePitch });
};

export const playbackCancelTransition = () => {
  return invoke<void>("playback_cancel_transition");
};
