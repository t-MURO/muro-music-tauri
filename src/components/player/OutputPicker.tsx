import { useCallback, useEffect, useState } from "react";
import { Check, Loader2, MonitorSpeaker, RefreshCw, Wifi } from "lucide-react";
import { t } from "../../i18n";
import { notify, useSettingsStore } from "../../stores";
import {
  useRemoteOutputStore,
  selectRemoteOutputActive,
  selectRemoteScanning,
} from "../../stores/remoteOutputStore";
import { useAudioOutputDevices } from "../../hooks/useAudioOutputDevices";
import {
  remoteDeviceKey,
  remoteStartDiscovery,
  remoteStopDiscovery,
} from "../../utils/remoteOutputApi";
import {
  connectToRemoteDevice,
  disconnectFromRemote,
} from "../../utils/remoteOutputController";
import { playbackSetOutputDevice } from "../../utils/playbackApi";

const PROTOCOL_BADGES = { cast: "Cast", dlna: "DLNA" } as const;

const rowClass = (selected: boolean) =>
  `flex w-full items-center justify-between gap-2 rounded-[var(--radius-md)] px-2 py-2 text-left text-[12px] hover:bg-[var(--color-bg-hover)] ${selected ? "text-[var(--color-accent)]" : "text-[var(--color-text-primary)]"}`;

const SectionHeading = ({ icon, children }: { icon: React.ReactNode; children: React.ReactNode }) => (
  <div className="flex items-center gap-1.5 px-2 pb-1 pt-2 text-[10px] font-semibold uppercase tracking-[0.08em] text-[var(--color-text-muted)]">
    {icon}
    {children}
  </div>
);

// Shared device-picker popover content: every available output in one list —
// this computer's audio devices plus Google Cast and DLNA renderers on the
// network. Mounted by the player-bar button and the queue-panel footer.
export const OutputPickerPopover = ({ className = "" }: { className?: string }) => {
  const { devices: localDevices } = useAudioOutputDevices(true);
  const localDeviceId = useSettingsStore((state) => state.audioOutputDeviceId);
  const setAudioOutputDevice = useSettingsStore((state) => state.setAudioOutputDevice);

  const networkDevices = useRemoteOutputStore((state) => state.devices);
  const scanning = useRemoteOutputStore(selectRemoteScanning);
  const discoveryError = useRemoteOutputStore((state) => state.discoveryError);
  const sessionState = useRemoteOutputStore((state) => state.sessionState);
  const protocol = useRemoteOutputStore((state) => state.protocol);
  const deviceId = useRemoteOutputStore((state) => state.deviceId);
  const deviceName = useRemoteOutputStore((state) => state.deviceName);
  const lastError = useRemoteOutputStore((state) => state.lastError);
  const outputActive = useRemoteOutputStore(selectRemoteOutputActive);

  const [busyKey, setBusyKey] = useState<string | null>(null);

  const isConnecting = sessionState === "connecting" || sessionState === "loading";
  const hasSessionError = sessionState === "error" && lastError !== null;
  const connectedKey = outputActive && protocol && deviceId
    ? remoteDeviceKey(protocol, deviceId)
    : null;

  useEffect(() => {
    void remoteStartDiscovery();
    return () => {
      if (!selectRemoteOutputActive(useRemoteOutputStore.getState())) {
        void remoteStopDiscovery();
      }
    };
  }, []);

  const handleSelectLocal = useCallback(async (targetDeviceId: string, label: string) => {
    setBusyKey(`local:${targetDeviceId}`);
    try {
      if (useRemoteOutputStore.getState().protocol) {
        await disconnectFromRemote();
      }
      await playbackSetOutputDevice(targetDeviceId);
      setAudioOutputDevice(targetDeviceId, label);
    } catch {
      notify.error(t("output.switchFailed"));
    } finally {
      setBusyKey(null);
    }
  }, [setAudioOutputDevice]);

  const handleSelectNetwork = useCallback(async (deviceKey: string) => {
    const device = useRemoteOutputStore.getState().devices
      .find((entry) => entry.key === deviceKey);
    if (!device) return;
    setBusyKey(deviceKey);
    try {
      await connectToRemoteDevice(device);
    } catch {
      notify.error(t("player.output.connectFailed"));
    } finally {
      setBusyKey(null);
    }
  }, []);

  const handleDisconnect = useCallback(async () => {
    setBusyKey(null);
    try {
      await disconnectFromRemote();
    } catch {
      notify.error(t("player.output.commandFailed"));
    }
  }, []);

  const handleRetry = useCallback(() => {
    void remoteStartDiscovery();
  }, []);

  const localEntries = [
    { deviceId: "", label: t("output.systemDefault") },
    ...localDevices,
  ];

  return (
    <div
      className={`absolute z-50 w-72 rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-bg-secondary)] p-2 shadow-[0_12px_32px_rgba(0,0,0,0.45)] ${className}`}
      role="menu"
      aria-label={t("player.output.heading")}
      data-output-menu
    >
      <SectionHeading icon={<MonitorSpeaker className="h-3 w-3" />}>
        {t("output.section.local")}
      </SectionHeading>
      {localEntries.map((device) => {
        const key = `local:${device.deviceId}`;
        const isSelected = !outputActive && localDeviceId === device.deviceId;
        return (
          <button
            key={key}
            className={rowClass(isSelected)}
            onClick={() => void handleSelectLocal(device.deviceId, device.deviceId === "" ? "" : device.label)}
            disabled={busyKey !== null || isConnecting}
            role="menuitem"
            type="button"
            data-output-local-device={device.deviceId || "default"}
          >
            <span className="min-w-0 truncate font-medium">{device.label}</span>
            {busyKey === key
              ? <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin" />
              : isSelected
                ? <Check className="h-3.5 w-3.5 shrink-0" />
                : null}
          </button>
        );
      })}

      <div className="mt-1 flex items-center justify-between border-t border-[var(--color-border)]">
        <SectionHeading icon={<Wifi className="h-3 w-3" />}>
          {t("output.section.network")}
        </SectionHeading>
        {scanning && (
          <span className="flex items-center gap-1.5 pr-2 pt-1 text-[10px] text-[var(--color-text-muted)]" role="status">
            <Loader2 className="h-3 w-3 animate-spin" />
            {t("player.output.scanning")}
          </span>
        )}
      </div>

      {networkDevices.length === 0 && !scanning && (
        <div className="px-2 py-2 text-[11px] text-[var(--color-text-muted)]">
          <p>{discoveryError ?? t("player.output.noDevices")}</p>
          <p className="mt-1">{t("player.output.noDevicesHint")}</p>
          <button
            className="mt-2 flex items-center gap-1.5 rounded-[var(--radius-md)] border border-[var(--color-border)] px-2 py-1 text-[11px] text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-hover)] hover:text-[var(--color-text-primary)]"
            onClick={handleRetry}
            type="button"
          >
            <RefreshCw className="h-3 w-3" />
            {t("player.output.retry")}
          </button>
        </div>
      )}

      {networkDevices.map((device) => {
        const isConnected = device.key === connectedKey;
        const isBusy = busyKey === device.key;
        return (
          <button
            key={device.key}
            className={rowClass(isConnected)}
            onClick={() => (isConnected ? void handleDisconnect() : void handleSelectNetwork(device.key))}
            disabled={busyKey !== null || isBusy || isConnecting}
            role="menuitem"
            type="button"
            data-output-device={device.key}
          >
            <span className="min-w-0">
              <span className="block truncate font-medium">{device.name}</span>
              <span className="block truncate text-[10px] text-[var(--color-text-muted)]">
                {PROTOCOL_BADGES[device.protocol]}
                {device.model ? ` · ${device.model}` : ""}
              </span>
            </span>
            {isBusy
              ? <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin" />
              : isConnected
                ? <Check className="h-3.5 w-3.5 shrink-0" />
                : null}
          </button>
        );
      })}

      {outputActive && deviceName && (
        <div className="mt-1 border-t border-[var(--color-border)] px-2 pb-1 pt-2">
          <p className="truncate text-[10px] text-[var(--color-text-muted)]" data-output-label>
            {t("player.output.playingOn", { name: deviceName })}
          </p>
          <button
            className="mt-1.5 w-full rounded-[var(--radius-md)] border border-[var(--color-border)] px-2 py-1.5 text-[11px] text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-hover)] hover:text-[var(--color-text-primary)]"
            onClick={() => void handleDisconnect()}
            type="button"
            data-output-disconnect
          >
            {t("player.output.disconnect")}
          </button>
        </div>
      )}

      {hasSessionError && (
        <div className="mt-1 border-t border-[var(--color-border)] px-2 pb-1 pt-2">
          <p className="text-[10px] text-red-500">{lastError.message}</p>
          <button
            className="mt-1.5 flex items-center gap-1.5 rounded-[var(--radius-md)] border border-[var(--color-border)] px-2 py-1 text-[11px] text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-hover)] hover:text-[var(--color-text-primary)]"
            onClick={handleRetry}
            type="button"
          >
            <RefreshCw className="h-3 w-3" />
            {t("player.output.retry")}
          </button>
        </div>
      )}
    </div>
  );
};

// Shared open/close behavior for popover triggers.
export const useOutputPickerToggle = (containerRef: React.RefObject<HTMLElement | null>) => {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!open) return;
    const handlePointerDown = (event: PointerEvent) => {
      if (!containerRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [open, containerRef]);

  return { open, setOpen };
};
