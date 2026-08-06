import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";

/**
 * Drag Session Context
 *
 * Centralizes all drag state in the app, so internal drags (playlist, columns, etc.)
 * don't conflict with native file import drags from the OS.
 *
 * Usage:
 * 1. Wrap your app in <DragSessionProvider>
 * 2. Call startInternalDrag("source") in onDragStart
 * 3. Call endInternalDrag() in onDragEnd
 * 4. Check isInternalDrag before handling native file drops
 *
 * The dataTransfer marker (INTERNAL_DRAG_TYPE) can be used to verify
 * a drag is internal when receiving drops.
 */

// Marker to set on dataTransfer to identify internal drags
export const INTERNAL_DRAG_TYPE = "application/x-muro-internal";

type DragSource = "playlist" | "columns" | "queue" | "tracks";

type DragSession = {
  /** Whether an internal drag is currently active */
  isInternalDrag: boolean;
  /** The source of the current internal drag, if any */
  dragSource: DragSource | null;
  /** Start an internal drag - call this in onDragStart */
  startInternalDrag: (source: DragSource) => void;
  /** End an internal drag - call this in onDragEnd */
  endInternalDrag: () => void;
  /**
   * Check if native file drag should be allowed.
   * Returns false during internal drags and for a brief window after.
   */
  isNativeFileDragAllowed: () => boolean;
  /**
   * Mark dataTransfer as internal drag.
   * Call this in onDragStart: markAsInternalDrag(e.dataTransfer)
   */
  markAsInternalDrag: (dataTransfer: DataTransfer) => void;
  /**
   * Check if a dataTransfer is from an internal drag.
   * Call this in onDrop: isInternalDragTransfer(e.dataTransfer)
   */
  isInternalDragTransfer: (dataTransfer: DataTransfer) => boolean;
};

const DragSessionContext = createContext<DragSession | null>(null);

type DragSessionProviderProps = {
  children: ReactNode;
};

export const DragSessionProvider = ({ children }: DragSessionProviderProps) => {
  const [isInternalDrag, setIsInternalDrag] = useState(false);
  const [dragSource, setDragSource] = useState<DragSource | null>(null);

  // Refs for synchronous access (avoids race conditions with native events)
  const isInternalDragRef = useRef(false);
  const suppressUntilRef = useRef(0);

  const startInternalDrag = useCallback((source: DragSource) => {
    isInternalDragRef.current = true;
    suppressUntilRef.current = Date.now() + 500; // Suppress for 500ms after drag starts
    setIsInternalDrag(true);
    setDragSource(source);
  }, []);

  const endInternalDrag = useCallback(() => {
    isInternalDragRef.current = false;
    suppressUntilRef.current = Date.now() + 300; // Keep suppressing for 300ms after drag ends
    setIsInternalDrag(false);
    setDragSource(null);
  }, []);

  const isNativeFileDragAllowed = useCallback(() => {
    // Block native file drag if:
    // 1. Internal drag is active, OR
    // 2. We're within the suppression window (handles race conditions)
    if (isInternalDragRef.current) {
      return false;
    }
    if (Date.now() < suppressUntilRef.current) {
      return false;
    }
    return true;
  }, []);

  const markAsInternalDrag = useCallback((dataTransfer: DataTransfer) => {
    dataTransfer.setData(INTERNAL_DRAG_TYPE, "1");
  }, []);

  const isInternalDragTransfer = useCallback((dataTransfer: DataTransfer) => {
    return dataTransfer.types.includes(INTERNAL_DRAG_TYPE);
  }, []);

  const value = useMemo<DragSession>(
    () => ({
      isInternalDrag,
      dragSource,
      startInternalDrag,
      endInternalDrag,
      isNativeFileDragAllowed,
      markAsInternalDrag,
      isInternalDragTransfer,
    }),
    [
      isInternalDrag,
      dragSource,
      startInternalDrag,
      endInternalDrag,
      isNativeFileDragAllowed,
      markAsInternalDrag,
      isInternalDragTransfer,
    ]
  );

  return (
    <DragSessionContext.Provider value={value}>
      {children}
    </DragSessionContext.Provider>
  );
};

/**
 * Hook to access the drag session.
 * Must be used within a DragSessionProvider.
 */
export const useDragSession = (): DragSession => {
  const context = useContext(DragSessionContext);
  if (!context) {
    throw new Error("useDragSession must be used within a DragSessionProvider");
  }
  return context;
};
