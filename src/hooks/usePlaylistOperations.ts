import { useCallback } from "react";
import { commandManager } from "../command-manager/commandManager";
import { useLibraryStore, useUIStore, notify } from "../stores";
import { useDbPath } from "./useDbPath";
import {
  deletePlaylists,
  restorePlaylists,
  setPlaylistTracks,
  updatePlaylist,
} from "../utils";
import type { LibraryView } from "./useLibraryView";
import { t } from "../i18n";

type UsePlaylistOperationsArgs = {
  currentView: LibraryView;
  navigateToView: (view: LibraryView) => void;
};

export const usePlaylistOperations = ({
  currentView,
  navigateToView,
}: UsePlaylistOperationsArgs) => {
  // Get state and actions from stores
  const playlists = useLibraryStore((s) => s.playlists);
  const setPlaylists = useLibraryStore((s) => s.setPlaylists);
  const playlistEditState = useUIStore((s) => s.playlistEditState);
  const openPlaylistEdit = useUIStore((s) => s.openPlaylistEdit);
  const closePlaylistEdit = useUIStore((s) => s.closePlaylistEdit);
  const setPlaylistEditName = useUIStore((s) => s.setPlaylistEditName);
  const clearSelection = useUIStore((s) => s.clearSelection);
  const resolveDbPath = useDbPath();

  const handleOpenPlaylistEdit = useCallback(
    (playlist: { id: string; name: string }) => {
      openPlaylistEdit(playlist.id, playlist.name);
    },
    [openPlaylistEdit]
  );

  const handleClosePlaylistEdit = useCallback(() => {
    closePlaylistEdit();
  }, [closePlaylistEdit]);

  const handleRenamePlaylist = useCallback(
    async (playlistId: string, nextName: string) => {
      const resolvedDbPath = await resolveDbPath();
      const previousName = playlists.find((playlist) => playlist.id === playlistId)?.name;
      if (!previousName || previousName === nextName) return;
      const command = {
        label: `Rename playlist to ${nextName}`,
        do: async () => {
          await updatePlaylist(resolvedDbPath, playlistId, { name: nextName });
          setPlaylists((current) =>
            current.map((playlist) =>
              playlist.id === playlistId ? { ...playlist, name: nextName } : playlist
            )
          );
          return t("history.playlist.renamed", { previousName, nextName });
        },
        undo: async () => {
          await updatePlaylist(resolvedDbPath, playlistId, { name: previousName });
          setPlaylists((current) =>
            current.map((playlist) =>
              playlist.id === playlistId
                ? { ...playlist, name: previousName }
                : playlist
            )
          );
          return t("history.playlist.renameUndone", { previousName, nextName });
        },
      };

      try {
        await commandManager.execute(command);
      } catch {
        notify.error(t("toast.playlist.renameFailed"));
      }
    },
    [playlists, resolveDbPath, setPlaylists]
  );

  const handleDeletePlaylists = useCallback(
    async (playlistIds: string[]) => {
      const ids = new Set(playlistIds);
      const removed = playlists
        .map((playlist, index) => ({ playlist, index }))
        .filter(({ playlist }) => ids.has(playlist.id));
      if (removed.length === 0) return;
      const resolvedDbPath = await resolveDbPath();
      const activePlaylistId = currentView.startsWith("playlist:")
        ? currentView.slice("playlist:".length)
        : null;
      const wasOnDeletedPlaylist = activePlaylistId ? ids.has(activePlaylistId) : false;

      const command = {
        label: removed.length === 1 ? "Delete playlist" : `Delete ${removed.length} playlists`,
        do: async () => {
          const result = await deletePlaylists(resolvedDbPath, [...ids]);
          if (result.deleted !== removed.length) {
            throw new Error(t("history.playlist.deletePartial", {
              actual: String(result.deleted),
              expected: String(removed.length),
            }));
          }
          setPlaylists((current) =>
            current.filter((playlist) => !ids.has(playlist.id))
          );
          if (wasOnDeletedPlaylist) {
            navigateToView("library");
          }
          return t(
            removed.length === 1
              ? "history.playlist.deleted.one"
              : "history.playlist.deleted.many",
            { count: String(removed.length) },
          );
        },
        undo: async () => {
          const result = await restorePlaylists(
            resolvedDbPath,
            removed.map(({ playlist }) => playlist),
          );
          if (result.restored !== removed.length) {
            throw new Error(t("history.playlist.restorePartial", {
              actual: String(result.restored),
              expected: String(removed.length),
            }));
          }
          setPlaylists((current) => {
            const next = [...current];
            for (const { playlist, index } of removed) {
              next.splice(Math.min(index, next.length), 0, playlist);
            }
            return next;
          });
          if (wasOnDeletedPlaylist && activePlaylistId) {
            navigateToView(`playlist:${activePlaylistId}` as LibraryView);
          }
          const restoredTracks = removed.reduce(
            (total, entry) => total + entry.playlist.trackIds.length,
            0,
          );
          return t(
            removed.length === 1
              ? "history.playlist.restored.one"
              : "history.playlist.restored.many",
            { count: String(removed.length), tracks: String(restoredTracks) },
          );
        },
      };

      try {
        await commandManager.execute(command);
      } catch {
        notify.error(t("toast.playlist.deleteFailed"));
      }
    },
    [resolveDbPath, navigateToView, playlists, setPlaylists, currentView]
  );

  const handlePlaylistEditSubmit = useCallback(() => {
    if (!playlistEditState) {
      return;
    }
    const trimmed = playlistEditState.name.trim();
    if (!trimmed) {
      return;
    }
    void handleRenamePlaylist(playlistEditState.id, trimmed);
    handleClosePlaylistEdit();
  }, [handleRenamePlaylist, playlistEditState, handleClosePlaylistEdit]);

  const handleRemoveTracksFromPlaylist = useCallback(
    async (playlistId: string, trackIds: string[]) => {
      const playlist = playlists.find((item) => item.id === playlistId);
      if (!playlist || trackIds.length === 0) return;
      if (playlist.sourcePath) {
        notify.info(t("toast.playlist.sourceManaged", { name: playlist.name }));
        return;
      }

      const removed = new Set(trackIds);
      const previousIds = [...playlist.trackIds];
      const nextIds = previousIds.filter((trackId) => !removed.has(trackId));
      if (nextIds.length === previousIds.length) return;
      const resolvedDbPath = await resolveDbPath();

      clearSelection();
      const removedCount = previousIds.length - nextIds.length;
      try {
        await commandManager.execute({
          label: `Remove ${removedCount} tracks from playlist`,
          do: async () => {
            await setPlaylistTracks(resolvedDbPath, playlistId, nextIds);
            setPlaylists((current) => current.map((item) =>
              item.id === playlistId ? { ...item, trackIds: nextIds } : item
            ));
            return t(
              removedCount === 1
                ? "history.playlist.removed.one"
                : "history.playlist.removed.many",
              { count: String(removedCount), name: playlist.name },
            );
          },
          undo: async () => {
            await setPlaylistTracks(resolvedDbPath, playlistId, previousIds);
            setPlaylists((current) => current.map((item) =>
              item.id === playlistId ? { ...item, trackIds: previousIds } : item
            ));
            return t(
              removedCount === 1
                ? "history.playlist.tracksRestored.one"
                : "history.playlist.tracksRestored.many",
              { count: String(removedCount), name: playlist.name },
            );
          },
        });
      } catch {
        notify.error(t("toast.playlist.removeFailed"));
      }
    },
    [clearSelection, playlists, resolveDbPath, setPlaylists]
  );

  return {
    // Edit modal state
    isPlaylistEditOpen: playlistEditState !== null,
    playlistEditName: playlistEditState?.name ?? "",
    setPlaylistEditName,
    // Handlers
    handleOpenPlaylistEdit,
    handleClosePlaylistEdit,
    handleRenamePlaylist,
    handleDeletePlaylists,
    handleRemoveTracksFromPlaylist,
    handlePlaylistEditSubmit,
  };
};
