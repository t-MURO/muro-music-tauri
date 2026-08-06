import { invoke } from "@muro/desktop/runtime";
import type {
  CastDiscoverySnapshot,
  CastLoadTrackPayload,
  CastSessionState,
} from "./castApi";

// DLNA commands share the cast command payload shapes; only the protocol
// behind them differs.

export const dlnaStartDiscovery = () =>
  invoke<CastDiscoverySnapshot>("dlna_start_discovery");

export const dlnaStopDiscovery = () =>
  invoke<CastDiscoverySnapshot>("dlna_stop_discovery");

export const dlnaGetDevices = () =>
  invoke<CastDiscoverySnapshot>("dlna_get_devices");

export const dlnaConnect = (deviceId: string) =>
  invoke<CastSessionState>("dlna_connect", { deviceId });

export const dlnaDisconnect = () =>
  invoke<{ lastPositionSecs: number | null; trackId: string | null }>("dlna_disconnect");

export const dlnaLoadTrack = (payload: CastLoadTrackPayload) =>
  invoke<CastSessionState>("dlna_load_track", payload);

export const dlnaPlay = () => invoke<CastSessionState>("dlna_play");

export const dlnaPause = () => invoke<CastSessionState>("dlna_pause");

export const dlnaSeek = (positionSecs: number) =>
  invoke<CastSessionState>("dlna_seek", { positionSecs });

export const dlnaSetVolume = (volume: number) =>
  invoke<CastSessionState>("dlna_set_volume", { volume });

export const dlnaGetState = () =>
  invoke<CastSessionState & { discovery: CastDiscoverySnapshot }>("dlna_get_state");
