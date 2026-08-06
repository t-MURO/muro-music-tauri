import { useCallback, useEffect, useRef, useState } from "react";
import { listen, type UnlistenFn } from "@muro/desktop/events";
import { useDragSession } from "../contexts/DragSessionContext";

/**
 * Hook for handling native file drag-and-drop from the OS.
 *
 * This hook listens for native desktop drag events and shows an overlay
 * when files are dragged over the window. It automatically ignores
 * drag events during internal drags (playlist, columns, etc.) by
 * checking with the DragSession context.
 *
 * @param onImport - Callback when files are dropped
 * @returns { isDragging, nativeDropStatus }
 */
export const useNativeDrag = (onImport: (paths: string[]) => void) => {
  const { isNativeFileDragAllowed } = useDragSession();

  const [isDragging, setIsDragging] = useState(false);
  const [nativeDropStatus, setNativeDropStatus] = useState<string | null>(null);

  const nativeDropTimerRef = useRef<number | null>(null);
  const setupCompleteRef = useRef(false);
  const wasShowingOverlayRef = useRef(false);
  const onImportRef = useRef(onImport);
  const isNativeFileDragAllowedRef = useRef(isNativeFileDragAllowed);

  // Keep refs in sync
  useEffect(() => {
    onImportRef.current = onImport;
  }, [onImport]);

  useEffect(() => {
    isNativeFileDragAllowedRef.current = isNativeFileDragAllowed;
  }, [isNativeFileDragAllowed]);

  const clearStatus = useCallback(() => {
    if (nativeDropTimerRef.current !== null && typeof window !== "undefined") {
      window.clearTimeout(nativeDropTimerRef.current);
      nativeDropTimerRef.current = null;
    }
    setNativeDropStatus(null);
  }, []);

  const showStatus = useCallback((message: string, duration = 2000) => {
    if (typeof window === "undefined") return;

    if (nativeDropTimerRef.current !== null) {
      window.clearTimeout(nativeDropTimerRef.current);
    }
    setNativeDropStatus(message);
    nativeDropTimerRef.current = window.setTimeout(() => {
      setNativeDropStatus(null);
      nativeDropTimerRef.current = null;
    }, duration);
  }, []);

  // Clean up drag state when internal drags end
  useEffect(() => {
    const handleDragEnd = () => {
      setIsDragging(false);
    };

    window.addEventListener("dragend", handleDragEnd, true);
    return () => {
      window.removeEventListener("dragend", handleDragEnd, true);
    };
  }, []);

  // Set up the native drag listener
  useEffect(() => {
    if (setupCompleteRef.current) return;
    setupCompleteRef.current = true;

    let unlisten: UnlistenFn | null = null;

    const setup = async () => {
      try {
        unlisten = await listen<{ kind: string; paths: string[] }>(
          "muro://native-drag",
          (event) => {
            const payload = event.payload;
            if (!payload) return;

            const kind = payload.kind;

            // Handle drag over
            if (kind === "over") {
              // Skip if internal drag is active
              if (!isNativeFileDragAllowedRef.current()) {
                return;
              }
              wasShowingOverlayRef.current = true;
              setIsDragging(true);
              setNativeDropStatus("Drop files to import");
              return;
            }

            // Handle drag leave
            if (kind === "leave") {
              wasShowingOverlayRef.current = false;
              setIsDragging(false);
              clearStatus();
              return;
            }

            // Handle drop
            if (kind === "drop") {
              const wasShowingOverlay = wasShowingOverlayRef.current;
              wasShowingOverlayRef.current = false;
              setIsDragging(false);

              // Only process drop if we were showing the overlay
              // (i.e., it wasn't an internal drag)
              if (!wasShowingOverlay) {
                clearStatus();
                return;
              }

              const paths = payload.paths;
              if (paths?.length) {
                showStatus(
                  `Imported ${paths.length} file${paths.length === 1 ? "" : "s"}`
                );
                onImportRef.current(paths);
              } else {
                showStatus("Drop received, no files found");
              }
            }
          }
        );
      } catch (error) {
        console.error("Failed to set up native drag listener:", error);
      }
    };

    void setup();

    return () => {
      unlisten?.();
    };
  }, [clearStatus, showStatus]);

  return { isDragging, nativeDropStatus };
};
