import { useCallback, useEffect, useRef, useState } from "react";
import { useDragSession } from "../contexts/DragSessionContext";
import { startFileDrag } from "../desktop/runtime";
import type { Track } from "../types";

/**
 * Coordinates track drags both inside Muro Music and out to the desktop.
 * Electron receives the original source paths, so Explorer and other desktop
 * applications see the selection as real files rather than app-only data.
 */

type DragIndicator = {
  x: number;
  y: number;
  count: number;
};

type UsePlaylistDragArgs = {
  tracks: Track[];
  selectedIds: Set<string>;
  onDropToPlaylist: (playlistId: string, payload?: string[]) => void;
};

export const usePlaylistDrag = ({
  tracks,
  selectedIds,
  onDropToPlaylist,
}: UsePlaylistDragArgs) => {
  const { startInternalDrag, endInternalDrag, isInternalDrag, markAsInternalDrag } =
    useDragSession();

  const [draggingPlaylistId, setDraggingPlaylistId] = useState<string | null>(null);
  const [dragIndicator, setDragIndicator] = useState<DragIndicator | null>(null);

  const dragPayloadRef = useRef<string[]>([]);
  const tracksRef = useRef(tracks);
  const selectedIdsRef = useRef(selectedIds);
  const onDropToPlaylistRef = useRef(onDropToPlaylist);

  useEffect(() => {
    tracksRef.current = tracks;
  }, [tracks]);

  useEffect(() => {
    selectedIdsRef.current = selectedIds;
  }, [selectedIds]);

  useEffect(() => {
    onDropToPlaylistRef.current = onDropToPlaylist;
  }, [onDropToPlaylist]);

  const resetDragState = useCallback(() => {
    dragPayloadRef.current = [];
    setDragIndicator(null);
    setDraggingPlaylistId(null);
    endInternalDrag();
  }, [endInternalDrag]);

  const onRowDragStart = useCallback(
    (event: React.DragEvent<HTMLDivElement>, trackId: string) => {
      const currentTracks = tracksRef.current;
      const currentSelectedIds = selectedIdsRef.current;
      const draggedTracks = currentSelectedIds.has(trackId)
        ? currentTracks.filter((track) => currentSelectedIds.has(track.id))
        : currentTracks.filter((track) => track.id === trackId);
      const availableTracks = draggedTracks.filter(
        (track) => !track.isMissing && Boolean(track.sourcePath.trim())
      );

      if (availableTracks.length === 0) {
        event.preventDefault();
        return;
      }

      // Electron owns the drag loop from this point. Letting Chromium start
      // its HTML drag as well can create overlapping native drag sessions on
      // Windows and terminate the process inside webContents.startDrag().
      event.preventDefault();

      const trackIds = availableTracks.map((track) => track.id);
      dragPayloadRef.current = trackIds;
      startInternalDrag("tracks");
      markAsInternalDrag(event.dataTransfer);
      event.dataTransfer.setData("text/plain", trackIds.join(","));
      event.dataTransfer.effectAllowed = "copy";
      setDragIndicator({
        x: event.clientX,
        y: event.clientY,
        count: trackIds.length,
      });

      startFileDrag(availableTracks.map((track) => track.sourcePath));
    },
    [markAsInternalDrag, startInternalDrag]
  );

  const onRowDrag = useCallback((event: React.DragEvent<HTMLDivElement>) => {
    // Chromium sometimes emits a final drag event at 0,0; keep the last useful
    // position so the count badge does not jump to the corner.
    if (event.clientX === 0 && event.clientY === 0) return;
    setDragIndicator((current) =>
      current ? { ...current, x: event.clientX, y: event.clientY } : current
    );
  }, []);

  const onRowDragEnd = useCallback(() => {
    resetDragState();
  }, [resetDragState]);

  const onPlaylistDragEnter = useCallback((id: string) => {
    setDraggingPlaylistId(id);
  }, []);

  const onPlaylistDragLeave = useCallback((id: string) => {
    setDraggingPlaylistId((current) => (current === id ? null : current));
  }, []);

  const onPlaylistDragOver = useCallback((id: string) => {
    setDraggingPlaylistId(id);
  }, []);

  const onPlaylistDropEvent = useCallback(
    (event: React.DragEvent<HTMLButtonElement>, playlistId: string) => {
      const data = event.dataTransfer.getData("text/plain");
      const transferredPayload = data
        ? data.split(",").map((item) => item.trim()).filter(Boolean)
        : [];
      const payload = transferredPayload.length > 0
        ? transferredPayload
        : dragPayloadRef.current;
      onDropToPlaylistRef.current(playlistId, payload);
      resetDragState();
    },
    [resetDragState]
  );

  return {
    dragIndicator,
    draggingPlaylistId,
    isInternalDrag,
    onPlaylistDragEnter,
    onPlaylistDragLeave,
    onPlaylistDragOver,
    onPlaylistDropEvent,
    onRowDragStart,
    onRowDrag,
    onRowDragEnd,
  };
};
