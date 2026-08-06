import { invoke } from "@muro/desktop/runtime";

// ============================================================================
// Types
// ============================================================================

export type CastDevice = {
  id: string;
  name: string;
  model: string;
  host: string;
  port: number;
};

export type CastDiscoverySnapshot = {
  devices: CastDevice[];
  scanning: boolean;
  error: string | null;
};

export type CastSessionStateName =
  | "idle"
  | "connecting"
  | "connected"
  | "loading"
  | "playing"
  | "paused"
  | "buffering"
  | "disconnecting"
  | "error";

export type CastRemotePlayerState = "playing" | "paused" | "buffering" | "idle";

export type CastMediaStatus = {
  mediaSessionId: number | null;
  playerState: CastRemotePlayerState;
  idleReason: string | null;
  position: number;
  duration: number | null;
  contentId: string | null;
};

export type CastMediaStatusEvent = {
  status: CastMediaStatus;
  finished: boolean;
};

export type CastErrorPayload = {
  code: string;
  message: string;
};

export type CastLoadedTrack = {
  trackId: string | null;
  title: string;
  artist: string;
  album: string;
  durationSeconds: number | null;
};

export type CastSessionState = {
  state: CastSessionStateName;
  deviceId: string | null;
  deviceName: string | null;
  media: CastMediaStatus | null;
  track: CastLoadedTrack | null;
  lastError: CastErrorPayload | null;
};

export type CastLoadTrackPayload = {
  trackId: string;
  sourcePath: string;
  title: string;
  artist: string;
  album: string;
  durationSeconds: number;
  coverArtPath?: string;
  startPositionSecs?: number;
  autoplay?: boolean;
};

// The main process prefixes stable CAST_* codes onto error messages because
// Electron strips custom error properties across IPC.
export const castErrorCode = (error: unknown): string | null =>
  /(CAST_[A-Z_]+)/.exec(error instanceof Error ? error.message : String(error))?.[1] ?? null;

// ============================================================================
// Commands
// ============================================================================

export const castStartDiscovery = () =>
  invoke<CastDiscoverySnapshot>("cast_start_discovery");

export const castStopDiscovery = () =>
  invoke<CastDiscoverySnapshot>("cast_stop_discovery");

export const castGetDevices = () =>
  invoke<CastDiscoverySnapshot>("cast_get_devices");

export const castConnect = (deviceId: string) =>
  invoke<CastSessionState>("cast_connect", { deviceId });

export const castDisconnect = () =>
  invoke<{ lastPositionSecs: number | null; trackId: string | null }>("cast_disconnect");

export const castLoadTrack = (payload: CastLoadTrackPayload) =>
  invoke<CastSessionState>("cast_load_track", payload);

export const castPlay = () => invoke<CastSessionState>("cast_play");

export const castPause = () => invoke<CastSessionState>("cast_pause");

export const castSeek = (positionSecs: number) =>
  invoke<CastSessionState>("cast_seek", { positionSecs });

export const castSetVolume = (volume: number) =>
  invoke<CastSessionState>("cast_set_volume", { volume });

export const castGetState = () =>
  invoke<CastSessionState & { discovery: CastDiscoverySnapshot }>("cast_get_state");
