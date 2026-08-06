import { useCallback, useEffect, useRef, useState } from "react";
import { listen } from "../desktop/events";
import { notify, useLibraryStore, useSettingsStore } from "../stores";
import {
  exportOrganizedLibrary,
  importedTrackToTrack,
  loadTracks,
  type OrganizedLibraryExportResult,
} from "../utils";
import { useDbPath } from "./useDbPath";
import { t } from "../i18n";

type OrganizedLibraryExportProgress = {
  phase: "music" | "playlists";
  current: number;
  total: number;
  name?: string;
};

export const useOrganizedLibraryExport = () => {
  const resolveDbPath = useDbPath();
  const setTracks = useLibraryStore((state) => state.setTracks);
  const setInboxTracks = useLibraryStore((state) => state.setInboxTracks);
  const setLibraryRoot = useSettingsStore((state) => state.setWatchedFolder);
  const artistSeparatorExceptions = useSettingsStore(
    (state) => state.artistSeparatorExceptions,
  );
  const pendingRef = useRef(false);
  const [pending, setPending] = useState(false);
  const [status, setStatus] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    let unlisten: (() => void) | null = null;
    void listen<OrganizedLibraryExportProgress>(
      "muro://library-export-progress",
      ({ payload }) => {
        if (!active || !pendingRef.current || !payload) return;
        const subject = payload.phase === "music" ? "music files" : "playlists";
        setStatus(
          payload.total > 0
            ? `Exporting ${subject}: ${payload.current.toLocaleString()} of ${payload.total.toLocaleString()}`
            : `Preparing ${subject}…`,
        );
      },
    ).then((cleanup) => {
      if (active) unlisten = cleanup;
      else cleanup();
    });
    return () => {
      active = false;
      unlisten?.();
    };
  }, []);

  const exportLibrary = useCallback(async (
    destinationPath: string,
    useAsCurrentLibrary: boolean,
  ): Promise<OrganizedLibraryExportResult | null> => {
    pendingRef.current = true;
    setPending(true);
    setStatus("Preparing organized library export…");
    try {
      const dbPath = await resolveDbPath();
      const result = await exportOrganizedLibrary(
        dbPath,
        destinationPath,
        useAsCurrentLibrary,
      );
      let rendererReloadError: string | null = null;
      if (result.librarySwitched) {
        try {
          setLibraryRoot(result.exportRoot);
          const snapshot = await loadTracks(
            dbPath,
            result.exportRoot,
            artistSeparatorExceptions,
          );
          setTracks(snapshot.library.map(importedTrackToTrack));
          setInboxTracks(snapshot.inbox.map(importedTrackToTrack));
        } catch (error) {
          rendererReloadError = error instanceof Error ? error.message : String(error);
        }
      }
      const failureSuffix = result.tracksFailed > 0
        ? ` ${result.tracksFailed.toLocaleString()} unavailable files were skipped.`
        : "";
      const switchSuffix = result.librarySwitched
        ? rendererReloadError
          ? " The exported files are now the current library; restart Muro to refresh the view."
          : " Muro is now using the exported files as the current library."
        : result.librarySwitchRequested
          ? ` The current library was not switched${
              result.librarySwitchError ? `: ${result.librarySwitchError}` : "."
            }`
          : " The current library still uses the original files.";
      setStatus(
        `Copied ${result.filesCopied.toLocaleString()} music files and exported `
        + `${result.playlistsExported.toLocaleString()} playlists.${failureSuffix} `
        + `Saved to ${result.exportRoot}.${switchSuffix}`,
      );
      if (result.librarySwitchRequested && !result.librarySwitched) {
        notify.info(t("toast.export.doneNotSwitched"));
      } else if (rendererReloadError) {
        notify.info(t("toast.export.restartNeeded"));
      } else if (result.tracksFailed > 0) {
        notify.info(t("toast.export.completedWithSkips", { count: String(result.tracksFailed) }));
      } else if (result.librarySwitched) {
        notify.success(t("toast.export.doneSwitched"));
      } else {
        notify.success(t("toast.export.organizedDone"));
      }
      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to export the library";
      setStatus(message);
      notify.error(message);
      return null;
    } finally {
      pendingRef.current = false;
      setPending(false);
    }
  }, [
    artistSeparatorExceptions,
    resolveDbPath,
    setInboxTracks,
    setLibraryRoot,
    setTracks,
  ]);

  return {
    organizedLibraryExportPending: pending,
    organizedLibraryExportStatus: status,
    exportOrganizedLibrary: exportLibrary,
  };
};
