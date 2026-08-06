import { useCallback } from "react";
import { commandManager } from "../command-manager/commandManager";
import { useLibraryStore, useSettingsStore, useUIStore, notify } from "../stores";
import { useDbPath } from "./useDbPath";
import { acceptTracks, rejectTracks, unacceptTracks } from "../utils";
import { t } from "../i18n";

export const useInboxOperations = () => {
  // Get state and actions from stores
  const inboxTracks = useLibraryStore((s) => s.inboxTracks);
  const setTracks = useLibraryStore((s) => s.setTracks);
  const setInboxTracks = useLibraryStore((s) => s.setInboxTracks);
  const organizeAcceptedTracks = useSettingsStore((s) => s.organizeAcceptedTracks);
  const watchedFolder = useSettingsStore((s) => s.watchedFolder);
  const selectedIds = useUIStore((s) => s.selectedIds);
  const clearSelection = useUIStore((s) => s.clearSelection);
  const resolveDbPath = useDbPath();

  const handleAcceptTracks = useCallback(async () => {
    const selectedTrackIds = Array.from(selectedIds);
    if (selectedTrackIds.length === 0) {
      return;
    }
    if (!watchedFolder) {
      notify.info(t("toast.inbox.chooseFolder"));
      return;
    }

    let tracksToAccept = inboxTracks.filter((t) => selectedIds.has(t.id));
    let acceptedTrackIds = selectedTrackIds;
    let trackIdsToAccept = selectedTrackIds;
    let organizedFileCount = 0;
    const resolvedDbPath = await resolveDbPath();

    clearSelection();

    const command = {
      label: `Accept ${selectedTrackIds.length} tracks`,
      do: async () => {
        const result = await acceptTracks(resolvedDbPath, trackIdsToAccept, {
          organize: organizeAcceptedTracks,
          libraryFolder: watchedFolder,
        });
        if (result.accepted === 0) {
          throw new Error("No Inbox files could be moved into the library folder");
        }
        acceptedTrackIds = result.acceptedTrackIds;
        trackIdsToAccept = result.acceptedTrackIds;
        const acceptedIdSet = new Set(acceptedTrackIds);
        tracksToAccept = tracksToAccept.filter((track) => acceptedIdSet.has(track.id));
        const movedPaths = new Map(
          result.moved.map((entry) => [entry.trackId, entry.sourcePath]),
        );
        organizedFileCount = result.moved.length;
        const applyMovedPaths = (track: typeof tracksToAccept[number]) => {
          const sourcePath = movedPaths.get(track.id);
          return sourcePath ? { ...track, sourcePath } : track;
        };
        tracksToAccept = tracksToAccept.map(applyMovedPaths);
        setInboxTracks((current) =>
          current.filter((t) => !acceptedIdSet.has(t.id))
        );
        setTracks((current) => [
          ...tracksToAccept,
          ...current.filter((track) => !acceptedIdSet.has(track.id)),
        ]);
        if (result.failures.length > 0) {
          notify.error(t("toast.inbox.organizeFailed", {
            count: String(result.failures.length),
          }));
        }
        return t(
          result.accepted === 1
            ? "history.inbox.accepted.one"
            : "history.inbox.accepted.many",
          { count: String(result.accepted) },
        );
      },
      undo: async () => {
        await unacceptTracks(resolvedDbPath, acceptedTrackIds);
        const acceptedIdSet = new Set(acceptedTrackIds);
        setTracks((current) =>
          current.filter((t) => !acceptedIdSet.has(t.id))
        );
        setInboxTracks((current) => [
          ...tracksToAccept,
          ...current.filter((track) => !acceptedIdSet.has(track.id)),
        ]);
        const organizedNote = organizedFileCount > 0
          ? ` ${t("history.inbox.organizedFilesKept")}`
          : "";
        return `${t(
          acceptedTrackIds.length === 1
            ? "history.inbox.returned.one"
            : "history.inbox.returned.many",
          { count: String(acceptedTrackIds.length) },
        )}${organizedNote}`;
      },
    };

    try {
      await commandManager.execute(command);
    } catch {
      notify.error(t("toast.inbox.acceptFailed"));
    }
  }, [
    clearSelection,
    resolveDbPath,
    inboxTracks,
    selectedIds,
    organizeAcceptedTracks,
    watchedFolder,
    setInboxTracks,
    setTracks,
  ]);

  const handleRejectTracks = useCallback(async () => {
    const selectedTrackIds = Array.from(selectedIds);
    if (selectedTrackIds.length === 0) {
      return;
    }

    const resolvedDbPath = await resolveDbPath();

    clearSelection();
    try {
      await rejectTracks(resolvedDbPath, selectedTrackIds);
      setInboxTracks((current) =>
        current.filter((track) => !selectedTrackIds.includes(track.id))
      );
      notify.info(
        t(
          selectedTrackIds.length === 1
            ? "history.inbox.rejected.one"
            : "history.inbox.rejected.many",
          { count: String(selectedTrackIds.length) },
        ),
      );
    } catch {
      notify.error(t("toast.inbox.rejectFailed"));
    }
  }, [clearSelection, resolveDbPath, selectedIds, setInboxTracks]);

  return {
    handleAcceptTracks,
    handleRejectTracks,
  };
};
