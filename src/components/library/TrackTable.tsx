import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useVirtualizer, type VirtualItem } from "@tanstack/react-virtual";
import type { ColumnConfig, Track } from "../../types";
import type { ArtistTarget } from "../../utils/artistCredits";
import { TableHeader } from "./TableHeader";
import { TableEmptyState } from "./TableEmptyState";
import { TableRow } from "./TableRow";
import { usePlaybackStore, useSettingsStore, useUIStore } from "../../stores";
import { LEADING_COLUMN_WIDTH, PAGE_STEP } from "../../constants/ui";
import { matchesShortcut } from "../../keyboard/shortcuts";

type TrackTableProps = {
  tracks: Track[];
  columns: ColumnConfig[];
  emptyTitle: string;
  emptyDescription: string;
  emptyActionLabel?: string;
  onEmptyAction?: () => void;
  emptySecondaryActionLabel?: string;
  onEmptySecondaryAction?: () => void;
  onRowSelect: (
    index: number,
    id: string,
    options?: { isMetaKey?: boolean; isShiftKey?: boolean }
  ) => void;
  onRowDragStart: (event: React.DragEvent<HTMLDivElement>, id: string) => void;
  onRowDrag: (event: React.DragEvent<HTMLDivElement>) => void;
  onRowDragEnd: () => void;
  onRowContextMenu: (
    event: React.MouseEvent,
    id: string,
    index: number,
    isSelected: boolean
  ) => void;
  onRowDoubleClick?: (trackId: string) => void;
  onTogglePlay?: () => void;
  onOpenArtist?: (artist: ArtistTarget) => void;
  onOpenAlbum?: (trackId: string) => void;
  onAlbumContextMenu?: (event: React.MouseEvent, trackId: string) => void;
  onColumnResize: (key: ColumnConfig["key"], width: number) => void;
  onColumnAutoFit: (key: ColumnConfig["key"]) => void;
  onColumnReorder?: (dragKey: ColumnConfig["key"], targetIndex: number) => void;
  onHeaderContextMenu?: (event: React.MouseEvent<HTMLDivElement>) => void;
  onSortChange?: (key: ColumnConfig["key"]) => void;
  onRatingChange: (id: string, rating: number) => void;
  revealRequest?: { trackId: string; requestId: number } | null;
  onRevealHandled: (requestId: number) => void;
};

export const TrackTable = memo(
  ({
    tracks,
    columns,
    emptyTitle,
    emptyDescription,
    emptyActionLabel,
    onEmptyAction,
    emptySecondaryActionLabel,
    onEmptySecondaryAction,
    onRowSelect,
    onRowDragStart,
    onRowDrag,
    onRowDragEnd,
    onRowContextMenu,
    onRowDoubleClick,
    onTogglePlay,
    onOpenArtist,
    onOpenAlbum,
    onAlbumContextMenu,
    onColumnResize,
    onColumnAutoFit,
    onColumnReorder,
    onHeaderContextMenu,
    onSortChange,
    onRatingChange,
    revealRequest,
    onRevealHandled,
  }: TrackTableProps) => {
    // Read state from stores
    const selectedIds = useUIStore((s) => s.selectedIds);
    const activeIndex = useUIStore((s) => s.activeIndex);
    const sortState = useUIStore((s) => s.sortState);
    const selectAll = useUIStore((s) => s.selectAll);
    const clearSelection = useUIStore((s) => s.clearSelection);
    const isCurrentlyPlaying = usePlaybackStore((s) => s.isPlaying);
    const currentTrack = usePlaybackStore((s) => s.currentTrack);
    const shortcuts = useSettingsStore((s) => s.keyboardShortcuts);
    const playingTrackId = currentTrack?.id;
    const tableHeaderScrollRef = useRef<HTMLDivElement | null>(null);
    const tableContainerRef = useRef<HTMLDivElement | null>(null);
    const handledRevealRequestIdRef = useRef<number | null>(null);
    const [rowHeight, setRowHeight] = useState(48);

    useEffect(() => {
      const updateRowHeight = () => {
        const value = getComputedStyle(document.documentElement)
          .getPropertyValue("--table-row-height")
          .trim();
        const parsed = parseInt(value, 10);
        if (!isNaN(parsed)) {
          setRowHeight(parsed);
        }
      };
      updateRowHeight();

      // Listen for theme changes via data-theme attribute
      const observer = new MutationObserver(updateRowHeight);
      observer.observe(document.documentElement, {
        attributes: true,
        attributeFilter: ["data-theme", "data-table-density"]
      });
      return () => observer.disconnect();
    }, []);

    const visibleColumns = useMemo(
      () => columns.filter((column) => column.visible),
      [columns]
    );
    const selectedVisibleCount = useMemo(
      () => tracks.reduce((count, track) => count + (selectedIds.has(track.id) ? 1 : 0), 0),
      [selectedIds, tracks],
    );
    const tableWidth = useMemo(() => {
      return (
        visibleColumns.reduce((total, column) => total + column.width, 0) +
        LEADING_COLUMN_WIDTH
      );
    }, [visibleColumns]);
    const gridTemplateColumns = useMemo(
      () =>
        [`${LEADING_COLUMN_WIDTH}px`, ...visibleColumns.map((column) => `${column.width}px`)].join(
          " "
        ),
      [visibleColumns]
    );

    const rowVirtualizer = useVirtualizer({
      count: tracks.length,
      getScrollElement: () => tableContainerRef.current,
      estimateSize: () => rowHeight,
      overscan: 50,
    });

    useLayoutEffect(() => {
      rowVirtualizer.measure();
    }, [rowHeight, rowVirtualizer]);

    useLayoutEffect(() => {
      if (!revealRequest) return;
      if (handledRevealRequestIdRef.current === revealRequest.requestId) return;
      const index = tracks.findIndex((track) => track.id === revealRequest.trackId);
      if (index < 0) return;

      handledRevealRequestIdRef.current = revealRequest.requestId;
      onRowSelect(index, revealRequest.trackId);
      rowVirtualizer.scrollToIndex(index, { align: "center" });
      // Focus synchronously: rAF callbacks can starve indefinitely while the
      // window is hidden or occluded, so focus must not wait on a frame.
      tableContainerRef.current?.focus({ preventScroll: true });
      // The request is consumed synchronously below. Keep the second-pass
      // virtualizer correction alive for the next frame; it is guarded by the
      // mounted scroll element rather than by the now-cleared request prop.
      requestAnimationFrame(() => {
        if (tableContainerRef.current) {
          rowVirtualizer.scrollToIndex(index, { align: "center" });
        }
      });
      onRevealHandled(revealRequest.requestId);
    }, [onRevealHandled, onRowSelect, revealRequest, rowVirtualizer, tracks]);

    const virtualRows = rowVirtualizer.getVirtualItems();

    const clampIndex = (index: number) =>
      Math.max(0, Math.min(tracks.length - 1, index));

    const handleKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
      if (event.currentTarget !== event.target) {
        return;
      }

      if (matchesShortcut(event, shortcuts.selectAll)) {
        event.preventDefault();
        selectAll(tracks.map((t) => t.id));
        return;
      }

      if (matchesShortcut(event, shortcuts.clearSelection)) {
        event.preventDefault();
        clearSelection();
        return;
      }

      if (matchesShortcut(event, shortcuts.togglePlay)) {
        event.preventDefault();
        event.stopPropagation();
        if (playingTrackId) {
          onTogglePlay?.();
        } else if (activeIndex !== null) {
          const track = tracks[activeIndex];
          if (track) onRowDoubleClick?.(track.id);
        }
        return;
      }

      if (matchesShortcut(event, shortcuts.playSelected) && activeIndex !== null) {
        event.preventDefault();
        event.stopPropagation();
        const track = tracks[activeIndex];
        if (track) onRowDoubleClick?.(track.id);
        return;
      }

      if (tracks.length === 0) {
        return;
      }

      const current = activeIndex;
      let nextIndex = current ?? 0;

      if (event.key === "ArrowDown") {
        nextIndex = current === null ? 0 : clampIndex(current + 1);
      } else if (event.key === "ArrowUp") {
        nextIndex = current === null ? tracks.length - 1 : clampIndex(current - 1);
      } else if (event.key === "PageDown") {
        nextIndex = current === null ? 0 : clampIndex(current + PAGE_STEP);
      } else if (event.key === "PageUp") {
        nextIndex = current === null ? tracks.length - 1 : clampIndex(current - PAGE_STEP);
      } else if (event.key === "Home") {
        nextIndex = 0;
      } else if (event.key === "End") {
        nextIndex = tracks.length - 1;
      } else {
        return;
      }

      event.preventDefault();
      const track = tracks[nextIndex];
      if (!track) {
        return;
      }
      onRowSelect(nextIndex, track.id, { isShiftKey: event.shiftKey });
      rowVirtualizer.scrollToIndex(nextIndex, { align: "auto" });
    };

    // Stable callbacks for TableRow to prevent re-renders
    const handleRowSelectStable = useCallback(
      (index: number, id: string, options?: { isMetaKey?: boolean; isShiftKey?: boolean }) => {
        onRowSelect(index, id, options);
      },
      [onRowSelect]
    );

    const handleRowDragStartStable = useCallback(
      (event: React.DragEvent<HTMLDivElement>, id: string) => {
        onRowDragStart(event, id);
      },
      [onRowDragStart]
    );

    const handleRowContextMenuStable = useCallback(
      (event: React.MouseEvent, id: string, index: number, isSelected: boolean) => {
        onRowContextMenu(event, id, index, isSelected);
      },
      [onRowContextMenu]
    );

    const handleRowDoubleClickStable = useCallback(
      (trackId: string) => {
        onRowDoubleClick?.(trackId);
      },
      [onRowDoubleClick]
    );

    const handleRatingChangeStable = useCallback(
      (id: string, rating: number) => {
        onRatingChange(id, rating);
      },
      [onRatingChange]
    );

    return (
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <div
          className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden"
          role="grid"
          aria-rowcount={tracks.length}
          aria-colcount={visibleColumns.length + 1}
        >
          <div
            ref={tableHeaderScrollRef}
            className="min-w-0 shrink-0 overflow-x-hidden overflow-y-scroll"
            data-track-table-header-scroll
            style={{ scrollbarGutter: "stable" }}
          >
            <TableHeader
              columns={visibleColumns}
              tableWidth={tableWidth}
              leadingColumnWidth={LEADING_COLUMN_WIDTH}
              gridTemplateColumns={gridTemplateColumns}
              onColumnResize={onColumnResize}
              onColumnAutoFit={onColumnAutoFit}
              onColumnReorder={onColumnReorder}
              onHeaderContextMenu={onHeaderContextMenu}
              onSortChange={onSortChange}
              sortState={sortState}
              allSelected={tracks.length > 0 && selectedVisibleCount === tracks.length}
              onToggleSelectAll={() => {
                if (tracks.length > 0 && selectedVisibleCount === tracks.length) clearSelection();
                else selectAll(tracks.map((track) => track.id));
              }}
            />
          </div>
          <div
            ref={tableContainerRef}
            className="relative min-h-0 min-w-0 flex-1 overflow-x-auto overflow-y-auto"
            data-track-table-scroll
            style={{ scrollbarGutter: "stable" }}
            tabIndex={0}
            onKeyDown={handleKeyDown}
            onMouseDownCapture={(event) => {
              const target = event.target as HTMLElement | null;
              if (target?.closest("button, input, select, textarea, [contenteditable='true']")) {
                return;
              }
              tableContainerRef.current?.focus({ preventScroll: true });
            }}
            onScroll={(event) => {
              if (tableHeaderScrollRef.current) {
                tableHeaderScrollRef.current.scrollLeft = event.currentTarget.scrollLeft;
              }
            }}
          >
          {tracks.length === 0 ? (
            <TableEmptyState
              title={emptyTitle}
              description={emptyDescription}
              primaryActionLabel={emptyActionLabel}
              onPrimaryAction={onEmptyAction}
              secondaryActionLabel={emptySecondaryActionLabel}
              onSecondaryAction={onEmptySecondaryAction}
            />
          ) : (
          <div
            className="relative"
            style={{ height: rowVirtualizer.getTotalSize(), minWidth: tableWidth }}
          >
            {virtualRows.map((virtualRow: VirtualItem) => {
              const track = tracks[virtualRow.index];
              if (!track) {
                return null;
              }
              return (
                <TableRow
                  key={virtualRow.key}
                  track={track}
                  index={virtualRow.index}
                  isSelected={selectedIds.has(track.id)}
                  isPlayingTrack={track.id === playingTrackId}
                  isCurrentlyPlaying={isCurrentlyPlaying}
                  visibleColumns={visibleColumns}
                  gridTemplateColumns={gridTemplateColumns}
                  tableWidth={tableWidth}
                  virtualStart={virtualRow.start}
                  onRowSelect={handleRowSelectStable}
                  onRowDragStart={handleRowDragStartStable}
                  onRowDrag={onRowDrag}
                  onRowDragEnd={onRowDragEnd}
                  onRowContextMenu={handleRowContextMenuStable}
                  onRowDoubleClick={handleRowDoubleClickStable}
                  onOpenArtist={onOpenArtist}
                  onOpenAlbum={onOpenAlbum}
                  onAlbumContextMenu={onAlbumContextMenu}
                  onRatingChange={handleRatingChangeStable}
                />
              );
            })}
          </div>
          )}
          </div>
        </div>
        {tracks.length > 0 && (
          <div className="flex h-6 shrink-0 items-center border-t border-[var(--color-border)] bg-[var(--color-bg-secondary)] px-3 text-[10px] tabular-nums text-[var(--color-text-muted)]">
            <span>{selectedVisibleCount} of {tracks.length.toLocaleString()} selected</span>
            <span className="ml-auto" data-table-keyboard-hint>Up/Down select · Space plays</span>
            <span className="ml-4">{tracks.length.toLocaleString()} tracks in view</span>
          </div>
        )}
      </div>
    );
  }
);
