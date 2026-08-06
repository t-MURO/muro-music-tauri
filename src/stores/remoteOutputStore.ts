import { create } from "zustand";
import {
  toRemoteDevices,
  type RemoteDevice,
  type RemoteDiscoverySnapshot,
  type RemoteErrorPayload,
  type RemoteLoadedTrack,
  type RemoteMediaStatus,
  type RemoteOutputProtocol,
  type RemoteSessionState,
  type RemoteSessionStateName,
} from "../utils/remoteOutputApi";

type RemoteOutputState = {
  devices: RemoteDevice[];
  scanningByProtocol: Record<RemoteOutputProtocol, boolean>;
  discoveryErrorsByProtocol: Record<RemoteOutputProtocol, string | null>;
  discoveryError: string | null;
  protocol: RemoteOutputProtocol | null;
  sessionState: RemoteSessionStateName;
  deviceId: string | null;
  deviceName: string | null;
  remoteMedia: RemoteMediaStatus | null;
  remoteTrack: RemoteLoadedTrack | null;
  lastError: RemoteErrorPayload | null;
};

type RemoteOutputActions = {
  applyDiscovery: (protocol: RemoteOutputProtocol, snapshot: RemoteDiscoverySnapshot) => void;
  applySessionState: (protocol: RemoteOutputProtocol, payload: RemoteSessionState) => void;
  applyMediaStatus: (protocol: RemoteOutputProtocol, status: RemoteMediaStatus) => void;
  reset: () => void;
};

export type RemoteOutputStore = RemoteOutputState & RemoteOutputActions;

const initialState: RemoteOutputState = {
  devices: [],
  scanningByProtocol: { cast: false, dlna: false },
  discoveryErrorsByProtocol: { cast: null, dlna: null },
  discoveryError: null,
  protocol: null,
  sessionState: "idle",
  deviceId: null,
  deviceName: null,
  remoteMedia: null,
  remoteTrack: null,
  lastError: null,
};

const sessionActive = (state: RemoteSessionStateName) =>
  state !== "idle" && state !== "error";

export const useRemoteOutputStore = create<RemoteOutputStore>()((set) => ({
  ...initialState,

  applyDiscovery: (protocol, snapshot) =>
    set((state) => {
      const discoveryErrorsByProtocol = {
        ...state.discoveryErrorsByProtocol,
        [protocol]: snapshot.error,
      };
      return {
        devices: [
          ...state.devices.filter((device) => device.protocol !== protocol),
          ...toRemoteDevices(protocol, snapshot.devices),
        ].sort((left, right) => left.name.localeCompare(right.name)),
        scanningByProtocol: { ...state.scanningByProtocol, [protocol]: snapshot.scanning },
        discoveryErrorsByProtocol,
        discoveryError: discoveryErrorsByProtocol.cast ?? discoveryErrorsByProtocol.dlna,
      };
    }),

  // Each protocol service reports its own session state; the store keeps the
  // one that owns the active session and ignores stale idle reports from the
  // other protocol.
  applySessionState: (protocol, payload) =>
    set((state) => {
      const ownsSession = state.protocol === protocol || state.protocol === null;
      if (!sessionActive(payload.state) && !ownsSession) return state;
      return {
        protocol: sessionActive(payload.state)
          ? protocol
          : payload.state === "error" && state.protocol === protocol
            ? protocol // keep for the error display until the user acts
            : null,
        sessionState: payload.state,
        deviceId: payload.deviceId,
        deviceName: payload.deviceName,
        remoteMedia: payload.media,
        remoteTrack: payload.track,
        lastError: payload.lastError,
      };
    }),

  applyMediaStatus: (protocol, status) =>
    set((state) => (state.protocol === protocol ? { remoteMedia: status } : state)),

  reset: () => set(initialState),
}));

export const selectRemoteScanning = (state: RemoteOutputStore): boolean =>
  state.scanningByProtocol.cast || state.scanningByProtocol.dlna;

// The remote output owns playback commands whenever a session is being set
// up, active, or winding down. "idle" and "error" mean local playback owns
// them.
export const selectRemoteOutputActive = (state: Pick<RemoteOutputStore, "sessionState">): boolean =>
  sessionActive(state.sessionState);

export const isRemoteOutputActive = (): boolean =>
  selectRemoteOutputActive(useRemoteOutputStore.getState());

export const activeRemoteProtocol = (): RemoteOutputProtocol | null =>
  useRemoteOutputStore.getState().protocol;
