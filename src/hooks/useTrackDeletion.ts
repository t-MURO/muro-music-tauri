import { useCallback, useMemo, useState } from "react";
import { t } from "../i18n";
import {
  notify,
  selectAllTracks,
  useLibraryStore,
  usePlaybackStore,
  useRecentlyPlayedStore,
  useSettingsStore,
  useUIStore,
} from "../stores";
import { deleteTracks, playbackStop } from "../utils";
import { useDbPath } from "./useDbPath";

export const useTrackDeletion = () => {
  const allTracks = useLibraryStore(selectAllTracks);
  const setTracks = useLibraryStore((state) => state.setTracks);
  const setInboxTracks = useLibraryStore((state) => state.setInboxTracks);
  const setPlaylists = useLibraryStore((state) => state.setPlaylists);
  const recentlyPlayedTracks = useRecentlyPlayedStore((state) => state.recentlyPlayedTracks);
  const setRecentlyPlayedTracks = useRecentlyPlayedStore((state) => state.setRecentlyPlayedTracks);
  const currentTrack = usePlaybackStore((state) => state.currentTrack);
  const setQueue = usePlaybackStore((state) => state.setQueue);
  const setPlayingNext = usePlaybackStore((state) => state.setPlayingNext);
  const clearSelection = useUIStore((state) => state.clearSelection);
  const lastDeleteMode = useSettingsStore((state) => state.lastDeleteMode);
  const setLastDeleteMode = useSettingsStore((state) => state.setLastDeleteMode);
  const resolveDbPath = useDbPath();
  const [pendingTrackIds, setPendingTrackIds] = useState<string[]>([]);
  const [isDeleting, setIsDeleting] = useState(false);

  const pendingTracks = useMemo(() => {
    const pending = new Set(pendingTrackIds);
    return allTracks.filter((track) => pending.has(track.id));
  }, [allTracks, pendingTrackIds]);

  const requestTrackDeletion = useCallback((trackIds: string[]) => {
    const available = new Set(allTracks.map((track) => track.id));
    setPendingTrackIds([...new Set(trackIds)].filter((id) => available.has(id)));
  }, [allTracks]);

  const closeTrackDeletion = useCallback(() => {
    if (!isDeleting) setPendingTrackIds([]);
  }, [isDeleting]);

  const deletePendingTracks = useCallback(async (deleteFromDisk: boolean) => {
    if (pendingTrackIds.length === 0 || isDeleting) return;
    setIsDeleting(true);
    try {
      const requested = new Set(pendingTrackIds);
      if (currentTrack && requested.has(currentTrack.id)) {
        await playbackStop().catch(() => undefined);
      }

      const resolvedDbPath = await resolveDbPath();
      const result = await deleteTracks(resolvedDbPath, pendingTrackIds, deleteFromDisk);
      const deleted = new Set(result.deletedTrackIds);

      if (deleted.size > 0) {
        setTracks((current) => current.filter((track) => !deleted.has(track.id)));
        setInboxTracks((current) => current.filter((track) => !deleted.has(track.id)));
        setPlaylists((current) => current.map((playlist) => ({
          ...playlist,
          trackIds: playlist.trackIds.filter((trackId) => !deleted.has(trackId)),
        })));
        setRecentlyPlayedTracks(
          recentlyPlayedTracks.filter((track) => !deleted.has(track.id))
        );
        setQueue((current) => current.filter((trackId) => !deleted.has(trackId)));
        setPlayingNext((current) => current.filter((trackId) => !deleted.has(trackId)));
        notify.success(t("delete.toast.removed", { count: String(deleted.size) }));
      }

      if (result.failures.length > 0) {
        notify.error(t("delete.toast.failed", { count: String(result.failures.length) }));
      }

      clearSelection();
      setPendingTrackIds([]);
    } catch (error) {
      notify.error(error instanceof Error ? error.message : "Failed to delete tracks");
    } finally {
      setIsDeleting(false);
    }
  }, [
    clearSelection,
    currentTrack,
    isDeleting,
    pendingTrackIds,
    recentlyPlayedTracks,
    resolveDbPath,
    setInboxTracks,
    setPlaylists,
    setPlayingNext,
    setQueue,
    setRecentlyPlayedTracks,
    setTracks,
  ]);

  const removePendingFromLibrary = useCallback(() => {
    setLastDeleteMode("library");
    void deletePendingTracks(false);
  }, [deletePendingTracks, setLastDeleteMode]);

  const deletePendingFromDisk = useCallback(() => {
    setLastDeleteMode("disk");
    void deletePendingTracks(true);
  }, [deletePendingTracks, setLastDeleteMode]);

  return {
    pendingTracks,
    isDeleting,
    lastDeleteMode,
    requestTrackDeletion,
    closeTrackDeletion,
    removePendingFromLibrary,
    deletePendingFromDisk,
  };
};
