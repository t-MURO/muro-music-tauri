import { useCallback, useEffect, useState } from "react";

export type AudioOutputDevice = {
  deviceId: string;
  label: string;
};

// Chromium exposes "default" and "communications" pseudo-devices alongside
// the concrete ones; the picker shows a single explicit system-default entry
// instead (deviceId ""), so those are filtered out here.
const isConcreteOutput = (device: MediaDeviceInfo) =>
  device.kind === "audiooutput" &&
  device.deviceId !== "default" &&
  device.deviceId !== "communications";

// Enumerates local audio outputs and follows hotplug changes.
export const useAudioOutputDevices = (enabled: boolean) => {
  const [devices, setDevices] = useState<AudioOutputDevice[]>([]);

  const refresh = useCallback(async () => {
    try {
      const all = await navigator.mediaDevices.enumerateDevices();
      setDevices(
        all.filter(isConcreteOutput).map((device, index) => ({
          deviceId: device.deviceId,
          label: device.label || `Audio device ${index + 1}`,
        })),
      );
    } catch {
      setDevices([]);
    }
  }, []);

  useEffect(() => {
    if (!enabled) return;
    void refresh();
    const handleChange = () => void refresh();
    navigator.mediaDevices.addEventListener("devicechange", handleChange);
    return () => {
      navigator.mediaDevices.removeEventListener("devicechange", handleChange);
    };
  }, [enabled, refresh]);

  return { devices, refresh };
};
