import { useCallback, useRef } from "react";
import { useLibraryStore, notify } from "../stores";
import {
  createPlaylistFolder as createPlaylistFolderInDatabase,
  deletePlaylistFolder as deletePlaylistFolderInDatabase,
  reorderPlaylists as reorderPlaylistsInDatabase,
  updatePlaylistFolder as updatePlaylistFolderInDatabase,
} from "../utils";
import { useDbPath } from "./useDbPath";
import { t } from "../i18n";

export const usePlaylistFolders = () => {
  const sequenceRef = useRef(0);
  const setPlaylists = useLibraryStore((state) => state.setPlaylists);
  const playlists = useLibraryStore((state) => state.playlists);
  const setPlaylistFolders = useLibraryStore((state) => state.setPlaylistFolders);
  const playlistFolders = useLibraryStore((state) => state.playlistFolders);
  const resolveDbPath = useDbPath();

  const createFolder = useCallback(async (name: string) => {
    const trimmed = name.trim();
    if (!trimmed) return null;
    sequenceRef.current += 1;
    const folder = {
      id: `playlist-folder-${Date.now()}-${sequenceRef.current}`,
      name: trimmed,
      sortOrder: playlistFolders
        .filter((item) => !item.parentId)
        .reduce((highest, item) => Math.max(highest, item.sortOrder), -1) + 1,
    };
    try {
      const dbPath = await resolveDbPath();
      await createPlaylistFolderInDatabase(
        dbPath,
        folder.id,
        folder.name,
        undefined,
        folder.sortOrder,
      );
      setPlaylistFolders((current) => [...current, folder]);
      notify.success(t("toast.playlistFolder.created", { name: folder.name }));
      return folder.id;
    } catch {
      notify.error(t("toast.playlistFolder.createFailed"));
      return null;
    }
  }, [playlistFolders, resolveDbPath, setPlaylistFolders]);

  const renameFolder = useCallback(async (folderId: string, name: string) => {
    const trimmed = name.trim();
    if (!trimmed) return false;
    try {
      const dbPath = await resolveDbPath();
      await updatePlaylistFolderInDatabase(dbPath, folderId, trimmed);
      setPlaylistFolders((current) => current.map((folder) =>
        folder.id === folderId ? { ...folder, name: trimmed } : folder
      ));
      notify.success(t("toast.playlistFolder.renamed", { name: trimmed }));
      return true;
    } catch {
      notify.error(t("toast.playlistFolder.renameFailed"));
      return false;
    }
  }, [resolveDbPath, setPlaylistFolders]);

  const removeFolder = useCallback(async (folderId: string) => {
    try {
      const dbPath = await resolveDbPath();
      const parentId = playlistFolders.find((folder) => folder.id === folderId)?.parentId;
      await deletePlaylistFolderInDatabase(dbPath, folderId);
      setPlaylistFolders((current) => {
        let nextSortOrder = current
          .filter((folder) => folder.id !== folderId && folder.parentId === parentId)
          .reduce((highest, folder) => Math.max(highest, folder.sortOrder), -1) + 1;
        const childSortOrders = new Map(
          current
            .filter((folder) => folder.parentId === folderId)
            .sort((a, b) => a.sortOrder - b.sortOrder)
            .map((folder) => [folder.id, nextSortOrder++]),
        );
        return current
          .filter((folder) => folder.id !== folderId)
          .map((folder) => childSortOrders.has(folder.id)
            ? { ...folder, parentId, sortOrder: childSortOrders.get(folder.id) ?? folder.sortOrder }
            : folder);
      });
      setPlaylists((current) => {
        let nextSortOrder = current
          .filter((playlist) => playlist.folderId === parentId)
          .reduce((highest, playlist) => Math.max(highest, playlist.sortOrder), -1) + 1;
        const movedSortOrders = new Map(
          current
            .filter((playlist) => playlist.folderId === folderId)
            .sort((a, b) => a.sortOrder - b.sortOrder)
            .map((playlist) => [playlist.id, nextSortOrder++]),
        );
        return current.map((playlist) => movedSortOrders.has(playlist.id)
          ? {
              ...playlist,
              folderId: parentId,
              sortOrder: movedSortOrders.get(playlist.id) ?? playlist.sortOrder,
            }
          : playlist);
      });
      notify.success(t("toast.playlistFolder.deleted"));
      return true;
    } catch {
      notify.error(t("toast.playlistFolder.deleteFailed"));
      return false;
    }
  }, [playlistFolders, resolveDbPath, setPlaylistFolders, setPlaylists]);

  const movePlaylists = useCallback(async (
    playlistIds: string[],
    folderId: string | null,
  ) => {
    const selectedIds = new Set(playlistIds);
    const playlistsById = new Map(playlists.map((playlist) => [playlist.id, playlist]));
    const selected = playlistIds.flatMap((playlistId) => {
      const playlist = playlistsById.get(playlistId);
      return playlist ? [playlist] : [];
    });
    if (selected.length === 0) return false;
    try {
      let nextSortOrder = playlists
        .filter((playlist) => (
          (playlist.folderId ?? null) === folderId && !selectedIds.has(playlist.id)
        ))
        .reduce((highest, playlist) => Math.max(highest, playlist.sortOrder), -1) + 1;
      const moved = selected.map((playlist) => ({
        ...playlist,
        folderId: folderId ?? undefined,
        sortOrder: nextSortOrder++,
      }));
      const movedById = new Map(moved.map((playlist) => [playlist.id, {
        folderId: playlist.folderId,
        sortOrder: playlist.sortOrder,
      }]));
      const dbPath = await resolveDbPath();
      await reorderPlaylistsInDatabase(
        dbPath,
        moved.map((playlist) => ({
          id: playlist.id,
          folderId: playlist.folderId,
          sortOrder: playlist.sortOrder,
        })),
      );
      setPlaylists((current) => current.map((playlist) => {
        const movedFields = movedById.get(playlist.id);
        return movedFields ? { ...playlist, ...movedFields } : playlist;
      }));
      const subject = moved.length === 1 ? "playlist" : `${moved.length} playlists`;
      notify.success(folderId ? `Moved ${subject} to folder` : `Moved ${subject} to Playlists`);
      return true;
    } catch {
      notify.error(selected.length === 1 ? "Failed to move playlist" : "Failed to move playlists");
      return false;
    }
  }, [playlists, resolveDbPath, setPlaylists]);

  const reorderPlaylist = useCallback(async (
    sourceId: string,
    targetId: string,
    placement: "before" | "after",
  ) => {
    if (sourceId === targetId) return false;
    const source = playlists.find((playlist) => playlist.id === sourceId);
    const target = playlists.find((playlist) => playlist.id === targetId);
    if (!source || !target) return false;

    const targetFolderId = target.folderId;
    const folderKey = (folderId?: string) => folderId ?? "";
    const affectedKeys = new Set([
      folderKey(source.folderId),
      folderKey(targetFolderId),
    ]);
    const groups = new Map<string, typeof playlists>();
    for (const key of affectedKeys) {
      groups.set(key, playlists
        .filter((playlist) => folderKey(playlist.folderId) === key && playlist.id !== sourceId)
        .sort((a, b) => a.sortOrder - b.sortOrder));
    }
    const targetGroup = groups.get(folderKey(targetFolderId));
    if (!targetGroup) return false;
    const targetIndex = targetGroup.findIndex((playlist) => playlist.id === targetId);
    if (targetIndex < 0) return false;
    targetGroup.splice(
      targetIndex + (placement === "after" ? 1 : 0),
      0,
      { ...source, folderId: targetFolderId },
    );

    const updates = new Map<string, (typeof playlists)[number]>();
    for (const group of groups.values()) {
      group.forEach((playlist, sortOrder) => {
        updates.set(playlist.id, { ...playlist, sortOrder });
      });
    }
    const previous = playlists;
    const next = playlists.map((playlist) => updates.get(playlist.id) ?? playlist);
    setPlaylists(next);
    try {
      const dbPath = await resolveDbPath();
      await reorderPlaylistsInDatabase(
        dbPath,
        [...updates.values()].map((playlist) => ({
          id: playlist.id,
          folderId: playlist.folderId,
          sortOrder: playlist.sortOrder,
        })),
      );
      return true;
    } catch {
      setPlaylists(previous);
      notify.error(t("toast.playlist.reorderFailed"));
      return false;
    }
  }, [playlists, resolveDbPath, setPlaylists]);

  return {
    createFolder,
    renameFolder,
    removeFolder,
    movePlaylists,
    reorderPlaylist,
  };
};
