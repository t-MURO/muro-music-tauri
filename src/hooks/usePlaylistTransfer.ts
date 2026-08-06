import { listen } from "@muro/desktop/events";
import { useCallback, useEffect, useRef } from "react";
import { useLibraryStore, notify } from "../stores";
import {
  addTracksToPlaylist,
  configurePlaylistSync,
  createPlaylist,
  createPlaylistFolder,
  deletePlaylist,
  deletePlaylistFolder,
  exportAllPlaylists as exportAllPlaylistFiles,
  exportPlaylistFile,
  importFiles,
  importedTrackToTrack,
  importPlaylistFile,
  listPlaylistFiles,
  syncPlaylistSource,
  type PlaylistSourceSyncResult,
} from "../utils";
import { useDbPath } from "./useDbPath";
import { t } from "../i18n";
import type { Playlist } from "../types";

const normalizePath = (value: string) =>
  value.replace(/\//g, "\\").toLocaleLowerCase();

export const usePlaylistTransfer = () => {
  const sequenceRef = useRef(0);
  const setInboxTracks = useLibraryStore((state) => state.setInboxTracks);
  const setPlaylists = useLibraryStore((state) => state.setPlaylists);
  const setPlaylistFolders = useLibraryStore((state) => state.setPlaylistFolders);
  const resolveDbPath = useDbPath();

  useEffect(() => {
    let cancelled = false;
    let unlisten: (() => void) | null = null;

    void (async () => {
      unlisten = await listen<PlaylistSourceSyncResult>(
        "muro://playlist-source-synced",
        (event) => {
          const result = event.payload;
          if (!result) return;

          const converted = result.imported.map(importedTrackToTrack);
          if (converted.length > 0) {
            setInboxTracks((current) => {
              const existing = new Set(current.map((track) => track.id));
              return [
                ...converted.filter((track) => !existing.has(track.id)),
                ...current,
              ];
            });
          }
          setPlaylists((current) => current.map((playlist) =>
            playlist.id === result.playlistId
              ? {
                  ...playlist,
                  trackIds: result.trackIds,
                  sourcePath: result.sourcePath,
                  sourceSyncError: result.sourceSyncError ?? undefined,
                  lastSyncedAt: Math.floor(Date.now() / 1000),
                }
              : playlist
          ));

          if (result.sourceSyncError) {
            notify.error(
              result.skipped > 0
                ? t("toast.playlist.syncPartial", {
                    name: result.name,
                    count: String(result.skipped),
                  })
                : t("toast.playlist.syncFailed", { name: result.name }),
            );
          } else if (result.changed) {
            notify.success(t("toast.playlist.synced", {
              name: result.name,
              added: String(result.added),
              removed: String(result.removed),
            }));
          }
        },
      );
      if (cancelled) {
        unlisten();
        unlisten = null;
        return;
      }
      const dbPath = await resolveDbPath();
      if (!cancelled) await configurePlaylistSync(dbPath);
    })().catch((error) => {
      console.warn("Failed to start imported playlist synchronization", error);
    });

    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [resolveDbPath, setInboxTracks, setPlaylists]);

  const importPlaylistIntoStore = useCallback(async (
    dbPath: string,
    filePath: string,
    folderId?: string,
  ) => {
    const parsed = await importPlaylistFile(dbPath, filePath);
    const libraryTrackIdByPath = new Map(
      useLibraryStore.getState().tracks.map((track) => [normalizePath(track.sourcePath), track.id])
    );
    const missingPaths = [...new Set(
      parsed.entries
        .filter((entry) => (
          !entry.track_id
          && !libraryTrackIdByPath.has(normalizePath(entry.path))
          && entry.exists
        ))
        .map((entry) => entry.path)
    )];
    const importResult = missingPaths.length > 0
      ? await importFiles(dbPath, missingPaths)
      : { imported: [], scanned: 0, failures: [] };
    const imported = importResult.imported;
    const converted = imported.map(importedTrackToTrack);
    if (converted.length > 0) {
      setInboxTracks((current) => {
        const existing = new Set(current.map((track) => track.id));
        return [...converted.filter((track) => !existing.has(track.id)), ...current];
      });
    }

    const importedIdByPath = new Map(
      imported.map((track) => [normalizePath(track.source_path), track.id])
    );
    const orderedTrackIds = parsed.entries
      .map((entry) => {
        const normalizedPath = normalizePath(entry.path);
        return entry.track_id
          ?? libraryTrackIdByPath.get(normalizedPath)
          ?? importedIdByPath.get(normalizedPath)
          ?? null;
      })
      .filter((trackId): trackId is string => Boolean(trackId));
    const trackIds = [...new Set(orderedTrackIds)];

    sequenceRef.current += 1;
    const sortOrder = useLibraryStore.getState().playlists
      .filter((item) => item.folderId === folderId)
      .reduce((highest, item) => Math.max(highest, item.sortOrder), -1) + 1;
    const playlist: Playlist = {
      id: `playlist-import-${Date.now()}-${sequenceRef.current}`,
      name: parsed.name || "Imported Playlist",
      trackIds,
      folderId,
      sortOrder,
      sourcePath: parsed.source_path,
    };
    await createPlaylist(
      dbPath,
      playlist.id,
      playlist.name,
      folderId,
      sortOrder,
      parsed.source_path,
    );
    try {
      if (playlist.trackIds.length > 0) {
        await addTracksToPlaylist(dbPath, playlist.id, playlist.trackIds);
      }
    } catch (error) {
      await deletePlaylist(dbPath, playlist.id).catch(() => undefined);
      throw error;
    }
    setPlaylists((current) => [...current, playlist]);
    const initialSync = await syncPlaylistSource(dbPath, playlist.id).catch((error) => {
      console.warn(`Initial playlist sync failed for ${playlist.name}`, error);
      return null;
    });
    if (initialSync) {
      const initiallyImported = initialSync.imported.map(importedTrackToTrack);
      if (initiallyImported.length > 0) {
        setInboxTracks((current) => {
          const existing = new Set(current.map((track) => track.id));
          return [
            ...initiallyImported.filter((track) => !existing.has(track.id)),
            ...current,
          ];
        });
      }
      setPlaylists((current) => current.map((item) =>
        item.id === playlist.id
          ? {
              ...item,
              trackIds: initialSync.trackIds,
              sourceSyncError: initialSync.sourceSyncError ?? undefined,
              lastSyncedAt: Math.floor(Date.now() / 1000),
            }
          : item
      ));
      playlist.trackIds = initialSync.trackIds;
      playlist.sourceSyncError = initialSync.sourceSyncError ?? undefined;
      playlist.lastSyncedAt = Math.floor(Date.now() / 1000);
    }

    const skipped = initialSync?.skipped ?? parsed.entries.length - trackIds.length;
    return { playlist, skipped };
  }, [setInboxTracks, setPlaylists]);

  const importPlaylist = useCallback(async (filePath: string) => {
    try {
      const dbPath = await resolveDbPath();
      const result = await importPlaylistIntoStore(dbPath, filePath);
      if (!result) {
        notify.error(t("toast.playlist.noAvailableFiles"));
        return null;
      }
      notify.success(
        result.skipped > 0
          ? t("toast.playlist.importedLinkedPartial", {
              name: result.playlist.name,
              count: String(result.playlist.trackIds.length),
              skipped: String(result.skipped),
            })
          : t("toast.playlist.importedLinked", {
              name: result.playlist.name,
              count: String(result.playlist.trackIds.length),
            })
      );
      return result.playlist.id;
    } catch {
      notify.error(t("toast.playlist.importFailed"));
      return null;
    }
  }, [importPlaylistIntoStore, resolveDbPath]);

  const importPlaylistFolder = useCallback(async (directoryPath: string) => {
    let dbPath: string | null = null;
    const createdFolderIds: string[] = [];
    const cleanupFolders = async () => {
      if (!dbPath || createdFolderIds.length === 0) return;
      for (const folderId of [...createdFolderIds].reverse()) {
        await deletePlaylistFolder(dbPath, folderId).catch(() => undefined);
      }
      const created = new Set(createdFolderIds);
      setPlaylistFolders((current) => current.filter((folder) => !created.has(folder.id)));
    };
    try {
      const scan = await listPlaylistFiles(directoryPath);
      if (scan.files.length === 0) {
        notify.error(t("toast.playlist.noPlaylistsInFolder"));
        return null;
      }

      dbPath = await resolveDbPath();
      sequenceRef.current += 1;
      const rootFolder = {
        id: `playlist-folder-import-${Date.now()}-${sequenceRef.current}`,
        name: scan.name || "Imported Playlists",
        sortOrder: useLibraryStore.getState().playlistFolders
          .filter((folder) => !folder.parentId)
          .reduce((highest, folder) => Math.max(highest, folder.sortOrder), -1) + 1,
      };
      await createPlaylistFolder(
        dbPath,
        rootFolder.id,
        rootFolder.name,
        undefined,
        rootFolder.sortOrder,
      );
      createdFolderIds.push(rootFolder.id);

      const folderIdByPath = new Map<string, string>([["", rootFolder.id]]);
      const nextSortOrderByParent = new Map<string, number>();
      const importedFolders = [rootFolder];
      for (const scannedFolder of scan.folders) {
        const parentId = folderIdByPath.get(scannedFolder.parentPath ?? "") ?? rootFolder.id;
        const sortOrder = nextSortOrderByParent.get(parentId) ?? 0;
        nextSortOrderByParent.set(parentId, sortOrder + 1);
        sequenceRef.current += 1;
        const folder = {
          id: `playlist-folder-import-${Date.now()}-${sequenceRef.current}`,
          name: scannedFolder.name,
          parentId,
          sortOrder,
        };
        await createPlaylistFolder(dbPath, folder.id, folder.name, parentId, sortOrder);
        createdFolderIds.push(folder.id);
        folderIdByPath.set(scannedFolder.path, folder.id);
        importedFolders.push(folder);
      }
      setPlaylistFolders((current) => [...current, ...importedFolders]);

      notify.info(t("toast.playlist.importing", { count: String(scan.files.length), folder: rootFolder.name }));
      const playlistIds: string[] = [];
      for (const entry of scan.entries) {
        try {
          const folderId = folderIdByPath.get(entry.folderPath ?? "") ?? rootFolder.id;
          const result = await importPlaylistIntoStore(dbPath, entry.path, folderId);
          if (result) playlistIds.push(result.playlist.id);
        } catch {
          // Keep importing the remaining files and summarize partial failures.
        }
      }

      if (playlistIds.length === 0) {
        await cleanupFolders();
        notify.error(t("toast.playlist.importedNone", { count: String(scan.files.length) }));
        return null;
      }

      notify.success(
        t("toast.playlistFolder.importedLinked", {
          imported: String(playlistIds.length),
          count: String(scan.files.length),
          folder: rootFolder.name,
        })
      );
      return { folderId: rootFolder.id, playlistIds };
    } catch {
      await cleanupFolders();
      notify.error(t("toast.playlistFolder.importFailed"));
      return null;
    }
  }, [importPlaylistIntoStore, resolveDbPath, setPlaylistFolders]);

  const exportPlaylist = useCallback(async (playlistId: string, filePath: string) => {
    try {
      const dbPath = await resolveDbPath();
      const result = await exportPlaylistFile(dbPath, playlistId, filePath);
      notify.success(t("toast.playlist.exported", { count: String(result.exported) }));
      return true;
    } catch {
      notify.error(t("toast.playlist.exportFailed"));
      return false;
    }
  }, [resolveDbPath]);

  const exportAllPlaylists = useCallback(async (destinationPath: string) => {
    try {
      const dbPath = await resolveDbPath();
      const result = await exportAllPlaylistFiles(dbPath, destinationPath);
      notify.success(
        `Exported ${result.playlistsExported} playlists with `
        + `${result.playlistEntriesExported} track entries`
      );
      return result;
    } catch {
      notify.error(t("toast.playlist.exportAllFailed"));
      return null;
    }
  }, [resolveDbPath]);

  return { importPlaylist, importPlaylistFolder, exportPlaylist, exportAllPlaylists };
};
