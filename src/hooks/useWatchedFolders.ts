import { useCallback, useEffect, useState } from "react";
import { invoke } from "@muro/desktop/runtime";
import { listen } from "@muro/desktop/events";
import { open } from "@muro/desktop/dialogs";
import { notify, useLibraryStore, useSettingsStore } from "../stores";
import { importedTrackToTrack, type ImportedTrack } from "../utils";
import { t } from "../i18n";
import { useDbPath } from "./useDbPath";

type WatchedImportPayload = {
  track: ImportedTrack;
  sourcePath: string;
};

/**
 * Keeps the main process watching the configured folder and folds anything it
 * imports into the Inbox list without a full library reload.
 */
export const useWatchedFolders = () => {
  const [scanning, setScanning] = useState(false);
  const watchFolderEnabled = useSettingsStore((s) => s.watchFolderEnabled);
  const watchedFolder = useSettingsStore((s) => s.watchedFolder);
  const organizeAcceptedTracks = useSettingsStore((s) => s.organizeAcceptedTracks);
  const setWatchFolderEnabled = useSettingsStore((s) => s.setWatchFolderEnabled);
  const setOrganizeAcceptedTracks = useSettingsStore((s) => s.setOrganizeAcceptedTracks);
  const setWatchedFolder = useSettingsStore((s) => s.setWatchedFolder);
  const setInboxTracks = useLibraryStore((s) => s.setInboxTracks);
  const resolveDbPath = useDbPath();

  // Push the watch set to the main process whenever it changes.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const dbPath = await resolveDbPath();
        if (cancelled) return;
        await invoke("set_watched_folder", {
          dbPath,
          folder: watchedFolder,
          isEnabled: watchFolderEnabled,
        });
      } catch {
        // Watching is best-effort; manual import still works.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [resolveDbPath, watchFolderEnabled, watchedFolder]);

  // Newly watched-in tracks arrive one at a time.
  useEffect(() => {
    let unlisten: (() => void) | null = null;
    let cancelled = false;

    void listen<WatchedImportPayload>("muro://watched-folder-import", (event) => {
      const imported = event.payload?.track;
      if (!imported) return;
      const track = importedTrackToTrack(imported);
      setInboxTracks((current) =>
        current.some((entry) => entry.id === track.id) ? current : [track, ...current]
      );
    }).then((remove) => {
      if (cancelled) remove();
      else unlisten = remove;
    });

    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [setInboxTracks]);

  const addFolder = useCallback(async () => {
    const selected = await open({ directory: true, multiple: false });
    if (typeof selected !== "string") return;
    setWatchedFolder(selected);
    if (!watchFolderEnabled) setWatchFolderEnabled(true);
  }, [setWatchedFolder, setWatchFolderEnabled, watchFolderEnabled]);

  /**
   * fs.watch only reports changes made while it is running, so a manual sweep
   * covers anything that appeared while the app was closed.
   */
  const scanNow = useCallback(async () => {
    if (scanning || !watchedFolder) return;
    setScanning(true);
    try {
      const dbPath = await resolveDbPath();
      const result = await invoke<{ imported: number; scanned: number }>(
        "scan_watched_folder",
        { dbPath, folder: watchedFolder }
      );
      if (result.imported > 0) {
        notify.success(t("watch.scan.imported", { count: String(result.imported) }));
      } else {
        notify.info(t("watch.scan.nothingNew"));
      }
    } catch {
      notify.error(t("watch.scan.failed"));
    } finally {
      setScanning(false);
    }
  }, [resolveDbPath, scanning, watchedFolder]);

  return {
    scanning,
    watchFolderEnabled,
    watchedFolder,
    organizeAcceptedTracks,
    setWatchFolderEnabled,
    setOrganizeAcceptedTracks,
    addFolder,
    scanNow,
  };
};
