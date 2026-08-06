import { useCallback, useEffect, useState } from "react";
import { invoke } from "@muro/desktop/runtime";

export type AudioOutputDevice = {
  deviceId: string;
  label: string;
};

// CPAL enumerates the operating system's concrete output devices. Polling is
// used for hotplug parity because the native host API has no portable callback.
export const useAudioOutputDevices = (enabled: boolean) => {
  const [devices, setDevices] = useState<AudioOutputDevice[]>([]);

  const refresh = useCallback(async () => {
    try {
      const available = await invoke<AudioOutputDevice[]>("playback_list_output_devices");
      setDevices(available);
    } catch {
      setDevices([]);
    }
  }, []);

  useEffect(() => {
    if (!enabled) return;
    void refresh();
    const interval = window.setInterval(() => void refresh(), 3_000);
    return () => window.clearInterval(interval);
  }, [enabled, refresh]);

  return { devices, refresh };
};