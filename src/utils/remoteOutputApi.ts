import {
  castConnect,
  castDisconnect,
  castGetState,
  castLoadTrack,
  castPause,
  castPlay,
  castSeek,
  castSetVolume,
  castStartDiscovery,
  castStopDiscovery,
  type CastDevice,
  type CastDiscoverySnapshot,
  type CastLoadTrackPayload,
  type CastMediaStatus,
  type CastMediaStatusEvent,
  type CastSessionState,
  type CastSessionStateName,
  type CastErrorPayload,
  type CastLoadedTrack,
} from "./castApi";
import {
  dlnaConnect,
  dlnaDisconnect,
  dlnaGetState,
  dlnaLoadTrack,
  dlnaPause,
  dlnaPlay,
  dlnaSeek,
  dlnaSetVolume,
  dlnaStartDiscovery,
  dlnaStopDiscovery,
} from "./dlnaApi";

// One façade over both remote-output protocols. The renderer deals in
// RemoteDevice values and an active protocol; everything below dispatches to
// the matching cast_* or dlna_* command family.

export type RemoteOutputProtocol = "cast" | "dlna";

export type RemoteDevice = {
  key: string; // `${protocol}:${id}` — unique across protocols
  protocol: RemoteOutputProtocol;
  id: string;
  name: string;
  model: string;
};

export type RemoteDiscoverySnapshot = CastDiscoverySnapshot;
export type RemoteSessionState = CastSessionState;
export type RemoteSessionStateName = CastSessionStateName;
export type RemoteMediaStatus = CastMediaStatus;
export type RemoteMediaStatusEvent = CastMediaStatusEvent;
export type RemoteErrorPayload = CastErrorPayload;
export type RemoteLoadedTrack = CastLoadedTrack;
export type RemoteLoadTrackPayload = CastLoadTrackPayload;

export const remoteDeviceKey = (protocol: RemoteOutputProtocol, id: string) =>
  `${protocol}:${id}`;

export const toRemoteDevices = (
  protocol: RemoteOutputProtocol,
  devices: CastDevice[],
): RemoteDevice[] =>
  devices.map((device) => ({
    key: remoteDeviceKey(protocol, device.id),
    protocol,
    id: device.id,
    name: device.name,
    model: device.model,
  }));

// Stable CAST_*/DLNA_* codes ride in error messages across IPC.
export const remoteErrorCode = (error: unknown): string | null =>
  /((?:CAST|DLNA)_[A-Z_]+)/.exec(error instanceof Error ? error.message : String(error))?.[1] ?? null;

export const isRemoteUnsupportedFormat = (error: unknown): boolean => {
  const code = remoteErrorCode(error);
  return code === "CAST_UNSUPPORTED_FORMAT" || code === "DLNA_UNSUPPORTED_FORMAT";
};

export const remoteStartDiscovery = async (): Promise<void> => {
  await Promise.allSettled([castStartDiscovery(), dlnaStartDiscovery()]);
};

export const remoteStopDiscovery = async (): Promise<void> => {
  await Promise.allSettled([castStopDiscovery(), dlnaStopDiscovery()]);
};

export const remoteConnect = (device: RemoteDevice) =>
  device.protocol === "cast" ? castConnect(device.id) : dlnaConnect(device.id);

export const remoteDisconnect = (protocol: RemoteOutputProtocol) =>
  protocol === "cast" ? castDisconnect() : dlnaDisconnect();

export const remoteLoadTrack = (
  protocol: RemoteOutputProtocol,
  payload: RemoteLoadTrackPayload,
) => (protocol === "cast" ? castLoadTrack(payload) : dlnaLoadTrack(payload));

export const remotePlay = (protocol: RemoteOutputProtocol) =>
  protocol === "cast" ? castPlay() : dlnaPlay();

export const remotePause = (protocol: RemoteOutputProtocol) =>
  protocol === "cast" ? castPause() : dlnaPause();

export const remoteSeek = (protocol: RemoteOutputProtocol, positionSecs: number) =>
  protocol === "cast" ? castSeek(positionSecs) : dlnaSeek(positionSecs);

export const remoteSetVolume = (protocol: RemoteOutputProtocol, volume: number) =>
  protocol === "cast" ? castSetVolume(volume) : dlnaSetVolume(volume);

export const remoteGetStates = async (): Promise<{
  cast: (RemoteSessionState & { discovery: RemoteDiscoverySnapshot }) | null;
  dlna: (RemoteSessionState & { discovery: RemoteDiscoverySnapshot }) | null;
}> => {
  const [cast, dlna] = await Promise.allSettled([castGetState(), dlnaGetState()]);
  return {
    cast: cast.status === "fulfilled" ? cast.value : null,
    dlna: dlna.status === "fulfilled" ? dlna.value : null,
  };
};
