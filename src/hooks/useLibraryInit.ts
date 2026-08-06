import { useCallback, useEffect, useState } from "react";
import { appDataDir, join } from "@muro/desktop/paths";
import { useLibraryStore, useSettingsStore, useRecentlyPlayedStore, notify } from "../stores";
import {
  backfillCoverArt,
  backfillSearchText,
  clearTracks,
  loadPlaylists,
    loadRecentlyPlayed,
    loadTracks,
    migrateArtistCredits,
  importedTrackToTrack,
  scanTechnicalMetadata,
} from "../utils";
import { useDbPath } from "./useDbPath";
import { confirm } from "@muro/desktop/dialogs";
import { t } from "../i18n";

const INITIAL_TECHNICAL_SCAN_DELAY_MS = 3_000;
const CONTINUE_TECHNICAL_SCAN_DELAY_MS = 500;
const TECHNICAL_SCAN_BATCH_SIZE = 25;

export const useLibraryInit = () => {
  const setTracks = useLibraryStore((s) => s.setTracks);
  const setInboxTracks = useLibraryStore((s) => s.setInboxTracks);
  const setPlaylists = useLibraryStore((s) => s.setPlaylists);
  const setPlaylistFolders = useLibraryStore((s) => s.setPlaylistFolders);
  const setRecentlyPlayedTracks = useRecentlyPlayedStore((s) => s.setRecentlyPlayedTracks);

  const dbPath = useSettingsStore((s) => s.dbPath);
  const dbFileName = useSettingsStore((s) => s.dbFileName);
  const useAutoDbPath = useSettingsStore((s) => s.useAutoDbPath);
  const libraryRoot = useSettingsStore((s) => s.watchedFolder || undefined);
  const artistSeparatorExceptions = useSettingsStore((s) => s.artistSeparatorExceptions);

  const resolveDbPath = useDbPath();

  const [libraryLoading, setLibraryLoading] = useState(true);

  // Backfill state
  const [backfillPending, setBackfillPending] = useState(false);
  const [backfillStatus, setBackfillStatus] = useState<string | null>(null);
  const [coverArtBackfillPending, setCoverArtBackfillPending] = useState(false);
  const [coverArtBackfillStatus, setCoverArtBackfillStatus] = useState<string | null>(null);
  const [clearSongsPending, setClearSongsPending] = useState(false);

  // Auto-resolve DB path
  useEffect(() => {
    let isMounted = true;

    const resolveDefaultDbPath = async () => {
      if (!useAutoDbPath) {
        return;
      }

      try {
        const baseDir = await appDataDir();
        const defaultPath = await join(baseDir, dbFileName || "muro.db");
        if (isMounted) {
          useSettingsStore.setState({ dbPath: defaultPath });
        }
      } catch (error) {
        console.warn("Failed to resolve default db path", error);
      }
    };

    resolveDefaultDbPath();
    return () => {
      isMounted = false;
    };
  }, [dbFileName, useAutoDbPath]);

  // Load library on mount
  useEffect(() => {
    let isMounted = true;
    setLibraryLoading(true);

    const loadLibrary = async () => {
      try {
        const resolvedPath = await resolveDbPath();
        await migrateArtistCredits(resolvedPath, artistSeparatorExceptions);
        const [snapshot, playlistSnapshot, recentlyPlayedSnapshot] = await Promise.all([
          loadTracks(resolvedPath, libraryRoot, artistSeparatorExceptions),
          loadPlaylists(resolvedPath, libraryRoot),
          loadRecentlyPlayed(resolvedPath, 50, libraryRoot, artistSeparatorExceptions),
        ]);
        if (!isMounted) {
          return;
        }
        setTracks(snapshot.library.map(importedTrackToTrack));
        setInboxTracks(snapshot.inbox.map(importedTrackToTrack));
        setPlaylists(
          playlistSnapshot.playlists.map((playlist) => ({
            id: playlist.id,
            name: playlist.name,
            folderId: playlist.folder_id ?? undefined,
            sortOrder: playlist.sort_order,
            sourcePath: playlist.source_path ?? undefined,
            sourceMtimeMs: playlist.source_mtime_ms ?? undefined,
            sourceSize: playlist.source_size ?? undefined,
            sourceSyncError: playlist.source_sync_error ?? undefined,
            lastSyncedAt: playlist.last_synced_at ?? undefined,
            trackIds: playlist.track_ids,
          }))
        );
        setPlaylistFolders(playlistSnapshot.folders.map((folder) => ({
          id: folder.id,
          name: folder.name,
          parentId: folder.parent_id ?? undefined,
          sortOrder: folder.sort_order,
        })));
        setRecentlyPlayedTracks(recentlyPlayedSnapshot.map(importedTrackToTrack));
      } catch (error) {
        if (isMounted) notify.error(t("toast.library.loadFailed"));
      } finally {
        if (isMounted) setLibraryLoading(false);
      }
    };

    loadLibrary();
    return () => {
      isMounted = false;
    };
  }, [
    artistSeparatorExceptions,
    libraryRoot,
    resolveDbPath,
    setTracks,
    setInboxTracks,
    setPlaylists,
    setPlaylistFolders,
    setRecentlyPlayedTracks,
  ]);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const schedule = (delayMs: number) => {
      if (!cancelled) timer = setTimeout(run, delayMs);
    };
    const run = async () => {
      try {
        const resolvedPath = await resolveDbPath();
        const result = await scanTechnicalMetadata(resolvedPath, TECHNICAL_SCAN_BATCH_SIZE);
        if (cancelled) return;
        if (result.updated > 0) {
          const snapshot = await loadTracks(resolvedPath, libraryRoot, artistSeparatorExceptions);
          if (cancelled) return;
          setTracks(snapshot.library.map(importedTrackToTrack));
          setInboxTracks(snapshot.inbox.map(importedTrackToTrack));
        }
        if (result.remaining > 0) schedule(CONTINUE_TECHNICAL_SCAN_DELAY_MS);
      } catch (error) {
        console.warn("Failed to scan technical track metadata", error);
      }
    };
    schedule(INITIAL_TECHNICAL_SCAN_DELAY_MS);
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [artistSeparatorExceptions, libraryRoot, resolveDbPath, setInboxTracks, setTracks]);

  // Backfill handlers
  const handleBackfillSearchText = useCallback(async () => {
    if (!dbPath.trim()) {
      setBackfillStatus("Enter a database path to run the backfill.");
      return;
    }

    try {
      setBackfillPending(true);
      setBackfillStatus("Running backfill...");
      const updated = await backfillSearchText(dbPath.trim());
      setBackfillStatus(`Updated ${updated} tracks.`);
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Backfill failed.";
      setBackfillStatus(message);
    } finally {
      setBackfillPending(false);
    }
  }, [dbPath]);

  const handleBackfillCoverArt = useCallback(async () => {
    if (!dbPath.trim()) {
      setCoverArtBackfillStatus("Enter a database path to run the backfill.");
      return;
    }

    try {
      setCoverArtBackfillPending(true);
      setCoverArtBackfillStatus("Rebuilding high-resolution cover cache...");
      const updated = await backfillCoverArt(dbPath.trim());
      setCoverArtBackfillStatus(`Rebuilt high-resolution cover art for ${updated} tracks.`);
      // Reload tracks to get the new cover art paths
      const resolvedPath = await resolveDbPath();
      const snapshot = await loadTracks(resolvedPath, libraryRoot, artistSeparatorExceptions);
      setTracks(snapshot.library.map(importedTrackToTrack));
      setInboxTracks(snapshot.inbox.map(importedTrackToTrack));
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Cover art cache rebuild failed.";
      setCoverArtBackfillStatus(message);
    } finally {
      setCoverArtBackfillPending(false);
    }
  }, [artistSeparatorExceptions, dbPath, libraryRoot, resolveDbPath, setTracks, setInboxTracks]);

  // Clear songs handler
  const handleClearSongs = useCallback(async () => {
    if (clearSongsPending) {
      return;
    }

    const shouldClear = await confirm(
      t("settings.dev.clearSongs.confirm.body"),
      {
        title: t("settings.dev.clearSongs.confirm.title"),
        kind: "warning",
      }
    );
    if (!shouldClear) {
      return;
    }

    setClearSongsPending(true);
    try {
      const resolvedPath = await resolveDbPath();
      await clearTracks(resolvedPath);
      setTracks([]);
      setInboxTracks([]);
    } catch (error) {
      notify.error(t("toast.library.clearFailed"));
    } finally {
      setClearSongsPending(false);
    }
  }, [clearSongsPending, resolveDbPath, setTracks, setInboxTracks]);

  return {
    libraryLoading,
    // Backfill state
    backfillPending,
    backfillStatus,
    coverArtBackfillPending,
    coverArtBackfillStatus,
    clearSongsPending,
    // Handlers
    handleBackfillSearchText,
    handleBackfillCoverArt,
    handleClearSongs,
  };
};
