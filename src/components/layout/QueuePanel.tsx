import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import {
  AudioLines,
  GripVertical,
  ListMusic,
  Maximize2,
  Minimize2,
  Music2,
  PanelRightClose,
  PanelRightOpen,
  Sparkles,
  X,
} from "lucide-react";
import { t } from "../../i18n";
import { useDragSession } from "../../contexts/DragSessionContext";
import { NowPlayingTrack } from "../queue/NowPlayingTrack";
import { MixSuggestions } from "../queue/MixSuggestions";
import type { Playlist, Track } from "../../types";
import type { CurrentTrack } from "../../hooks";

type QueuePanelProps = {
  collapsed: boolean;
  expanded: boolean;
  onToggleCollapsed: () => void;
  onToggleExpanded: () => void;
  queueTracks: Track[];
  playingNextTracks: Track[];
  allTracks: Track[];
  currentTrack: CurrentTrack | null;
  currentTrackDetails?: Track | null;
  currentPlaylist?: Playlist | null;
  onRemoveFromQueue: (index: number) => void;
  onReorderQueue: (fromIndex: number, toIndex: number) => void;
  onReorderPlayingNext: (fromIndex: number, toIndex: number) => void;
  onMovePlayingNextToQueue: (fromIndex: number, toIndex: number) => void;
  onClearQueue: () => void;
  onPlayTrack: (trackId: string) => void;
  onPlayNext: (trackId: string) => void;
  onMixWithCurrent?: (trackId: string) => void;
};

const formatDuration = (seconds: number) => {
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const remainingSeconds = Math.floor(seconds % 60);
  return hours > 0
    ? `${hours}:${minutes.toString().padStart(2, "0")}:${remainingSeconds.toString().padStart(2, "0")}`
    : `${minutes}:${remainingSeconds.toString().padStart(2, "0")}`;
};

type PlaybackListKind = "queue" | "playing-next";

type QueueListItem =
  | { kind: "header"; list: PlaybackListKind }
  | { kind: "empty"; list: "playing-next" }
  | { kind: "track"; list: PlaybackListKind; track: Track; trackIndex: number };

const SECTION_HEADER_HEIGHT = 54;
const TRACK_ROW_HEIGHT = 49;

export const QueuePanel = ({
  collapsed,
  expanded,
  onToggleCollapsed,
  onToggleExpanded,
  queueTracks,
  playingNextTracks,
  allTracks,
  currentTrack,
  currentTrackDetails,
  currentPlaylist,
  onRemoveFromQueue,
  onReorderQueue,
  onReorderPlayingNext,
  onMovePlayingNextToQueue,
  onClearQueue,
  onPlayTrack,
  onPlayNext,
  onMixWithCurrent,
}: QueuePanelProps) => {
  const { startInternalDrag, endInternalDrag } = useDragSession();
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const [dragY, setDragY] = useState(0);
  const [dropIndex, setDropIndex] = useState<number | null>(null);
  const [dragList, setDragList] = useState<PlaybackListKind | null>(null);
  const [dropList, setDropList] = useState<PlaybackListKind | null>(null);
  const [panelView, setPanelView] = useState<"queue" | "mix">("queue");
  const dragStartRef = useRef<{
    list: PlaybackListKind;
    index: number;
    y: number;
    itemY: number;
  } | null>(null);
  const itemRefsRef = useRef<Map<string, HTMLDivElement>>(new Map());
  const sectionRefsRef = useRef<Map<PlaybackListKind, HTMLDivElement>>(new Map());
  const containerRef = useRef<HTMLDivElement>(null);
  const queueDuration = useMemo(
    () => queueTracks.reduce((total, track) => total + (track.durationSeconds || 0), 0),
    [queueTracks],
  );
  const playingNextDuration = useMemo(
    () => playingNextTracks.reduce((total, track) => total + (track.durationSeconds || 0), 0),
    [playingNextTracks],
  );
  const listItems = useMemo<QueueListItem[]>(
    () => [
      { kind: "header", list: "queue" },
      ...queueTracks.map(
        (track, trackIndex): QueueListItem => ({
          kind: "track",
          list: "queue",
          track,
          trackIndex,
        })
      ),
      { kind: "header", list: "playing-next" },
      ...(playingNextTracks.length > 0
        ? playingNextTracks.map(
            (track, trackIndex): QueueListItem => ({
              kind: "track",
              list: "playing-next",
              track,
              trackIndex,
            })
          )
        : [{ kind: "empty", list: "playing-next" } satisfies QueueListItem]),
    ],
    [playingNextTracks, queueTracks],
  );
  const listVirtualizer = useVirtualizer({
    count: listItems.length,
    getScrollElement: () => containerRef.current,
    estimateSize: (index) => {
      const item = listItems[index];
      if (item?.kind === "header") return SECTION_HEADER_HEIGHT;
      if (item?.kind === "empty") return 96;
      return TRACK_ROW_HEIGHT;
    },
    overscan: 12,
  });

  useLayoutEffect(() => {
    listVirtualizer.measure();
  }, [listVirtualizer, playingNextTracks.length, queueTracks.length]);

  const handleMouseDown = useCallback((
    event: React.MouseEvent,
    list: PlaybackListKind,
    index: number,
  ) => {
    if ((event.target as HTMLElement).closest("[data-no-drag]")) return;
    event.preventDefault();
    const item = itemRefsRef.current.get(`${list}:${index}`);
    if (!item) return;
    dragStartRef.current = {
      list,
      index,
      y: event.clientY,
      itemY: item.getBoundingClientRect().top,
    };
  }, []);

  useEffect(() => {
    const handleMouseMove = (event: MouseEvent) => {
      if (!dragStartRef.current) return;
      const { list, index, y: startY, itemY } = dragStartRef.current;
      const deltaY = event.clientY - startY;
      if (dragIndex === null && Math.abs(deltaY) > 4) {
        setDragIndex(index);
        setDragList(list);
        startInternalDrag("queue");
      }
      if (dragIndex === null) return;
      setDragY(itemY + deltaY);

      const container = containerRef.current;
      if (container) {
        const containerRect = container.getBoundingClientRect();
        if (event.clientY < containerRect.top + 36) {
          container.scrollTop -= 20;
        } else if (event.clientY > containerRect.bottom - 36) {
          container.scrollTop += 20;
        }
      }

      const pointerOffset = container
        ? event.clientY - container.getBoundingClientRect().top + container.scrollTop
        : Number.POSITIVE_INFINITY;
      const playingNextRowsStart =
        SECTION_HEADER_HEIGHT +
        queueTracks.length * TRACK_ROW_HEIGHT +
        SECTION_HEADER_HEIGHT;
      const targetList: PlaybackListKind =
        list === "playing-next" &&
        pointerOffset < playingNextRowsStart
          ? "queue"
          : list;
      const tracks = targetList === "queue" ? queueTracks : playingNextTracks;
      let nextDropIndex: number | null = null;
      for (let itemIndex = 0; itemIndex < tracks.length; itemIndex += 1) {
        const item = itemRefsRef.current.get(`${targetList}:${itemIndex}`);
        if (!item) continue;
        const rect = item.getBoundingClientRect();
        if (event.clientY < rect.top + rect.height / 2) {
          nextDropIndex = itemIndex;
          break;
        }
        nextDropIndex = itemIndex + 1;
      }
      if (targetList === "queue" && tracks.length === 0) nextDropIndex = 0;
      if (
        targetList === list &&
        (nextDropIndex === index || nextDropIndex === index + 1)
      ) {
        nextDropIndex = null;
      }
      setDropList(nextDropIndex === null ? null : targetList);
      setDropIndex(nextDropIndex);
    };

    const handleMouseUp = () => {
      const sourceList = dragStartRef.current?.list;
      if (sourceList && dropList && dragIndex !== null && dropIndex !== null) {
        const targetIndex = dropIndex > dragIndex ? dropIndex - 1 : dropIndex;
        if (sourceList === "playing-next" && dropList === "queue") {
          onMovePlayingNextToQueue(dragIndex, dropIndex);
        } else if (targetIndex !== dragIndex) {
          if (sourceList === "queue") {
            onReorderQueue(dragIndex, targetIndex);
          } else {
            onReorderPlayingNext(dragIndex, targetIndex);
          }
        }
      }
      dragStartRef.current = null;
      setDragIndex(null);
      setDragY(0);
      setDropIndex(null);
      setDragList(null);
      setDropList(null);
      endInternalDrag();
    };
    window.addEventListener("mousemove", handleMouseMove);
    window.addEventListener("mouseup", handleMouseUp);
    return () => {
      window.removeEventListener("mousemove", handleMouseMove);
      window.removeEventListener("mouseup", handleMouseUp);
    };
  }, [
    dragIndex,
    dropIndex,
    endInternalDrag,
    dropList,
    onMovePlayingNextToQueue,
    onReorderPlayingNext,
    onReorderQueue,
    playingNextTracks,
    queueTracks,
    startInternalDrag,
  ]);

  const draggedTrack = dragIndex !== null && dragList
    ? (dragList === "queue" ? queueTracks : playingNextTracks)[dragIndex]
    : null;

  if (collapsed) {
    return (
      <aside className="flex h-full flex-col items-center border-l border-[var(--color-border)] bg-[var(--color-bg-secondary)] py-5">
        <button className="toolbar-icon-button" onClick={onToggleCollapsed} title="Expand queue" aria-label="Expand queue" type="button"><PanelRightOpen className="h-4 w-4" /></button>
        {(queueTracks.length > 0 || playingNextTracks.length > 0) && (
          <span className="mt-6 text-[10px] tabular-nums text-[var(--color-accent)]">
            {queueTracks.length + playingNextTracks.length}
          </span>
        )}
      </aside>
    );
  }

  return (
    <aside className="flex h-full flex-col overflow-hidden border-l border-[var(--color-border)] bg-[var(--color-bg-secondary)]">
      <div className="flex h-[68px] shrink-0 items-center gap-2 border-b border-[var(--color-border)] px-3">
        <div className="flex min-w-0 flex-1 rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-bg-primary)] p-0.5" role="tablist" aria-label="Right sidebar view">
          <button
            className={`flex min-w-0 flex-1 items-center justify-center gap-1.5 rounded-[calc(var(--radius-md)-2px)] px-2 py-1.5 text-[10px] font-medium transition-colors ${panelView === "queue" ? "bg-[var(--color-bg-active)] text-[var(--color-text-primary)] shadow-sm" : "text-[var(--color-text-muted)] hover:text-[var(--color-text-primary)]"}`}
            onClick={() => setPanelView("queue")}
            role="tab"
            aria-selected={panelView === "queue"}
            data-panel-view="queue"
            type="button"
          >
            <ListMusic className="h-3.5 w-3.5 shrink-0" />
            <span className="truncate">Queue</span>
          </button>
          <button
            className={`flex min-w-0 flex-1 items-center justify-center gap-1.5 rounded-[calc(var(--radius-md)-2px)] px-2 py-1.5 text-[10px] font-medium transition-colors ${panelView === "mix" ? "bg-[var(--color-accent-light)] text-[var(--color-accent)] shadow-sm" : "text-[var(--color-text-muted)] hover:text-[var(--color-text-primary)]"}`}
            onClick={() => setPanelView("mix")}
            role="tab"
            aria-selected={panelView === "mix"}
            data-panel-view="mix"
            type="button"
          >
            <Sparkles className="h-3.5 w-3.5 shrink-0" />
            <span className="truncate">Mix Next</span>
          </button>
        </div>
        {panelView === "mix" && (
          <button
            className="toolbar-icon-button ml-auto"
            onClick={onToggleExpanded}
            title={expanded ? "Restore Mix Next panel" : "Expand Mix Next panel"}
            aria-label={expanded ? "Restore Mix Next panel" : "Expand Mix Next panel"}
            aria-pressed={expanded}
            data-mix-expand
            type="button"
          >
            {expanded ? <Minimize2 className="h-4 w-4" /> : <Maximize2 className="h-4 w-4" />}
          </button>
        )}
        <button className={`toolbar-icon-button ${panelView === "mix" ? "" : "ml-auto"}`} onClick={onToggleCollapsed} title="Collapse queue" aria-label="Collapse queue" type="button"><PanelRightClose className="h-4 w-4" /></button>
      </div>

      {panelView === "queue" ? (
        <>
      <div className="min-h-[198px] border-b border-[var(--color-border)] pt-5">
        <NowPlayingTrack currentTrack={currentTrack} trackDetails={currentTrackDetails} />
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto" ref={containerRef}>
        <div
          className="relative"
          style={{ height: `${listVirtualizer.getTotalSize()}px` }}
        >
          {listVirtualizer.getVirtualItems().map((virtualRow) => {
            const item = listItems[virtualRow.index];
            const wrapperStyle = {
              height: `${virtualRow.size}px`,
              transform: `translateY(${virtualRow.start}px)`,
            };

            if (item.kind === "header") {
              const isQueue = item.list === "queue";
              const tracks = isQueue ? queueTracks : playingNextTracks;
              const duration = isQueue ? queueDuration : playingNextDuration;
              return (
                <div
                  key={`header-${item.list}`}
                  ref={(element) => {
                    if (element) sectionRefsRef.current.set(item.list, element);
                    else sectionRefsRef.current.delete(item.list);
                  }}
                  className={`absolute left-0 top-0 flex w-full items-center border-b border-[var(--color-border-light)] px-4 transition-colors ${
                    item.list === "queue" && dragList === "playing-next" && dropList === "queue"
                      ? "bg-[var(--color-accent-light)]"
                      : ""
                  }`}
                  style={wrapperStyle}
                  data-queue-section={item.list}
                  data-queue-drop-target={
                    item.list === "queue" && dragList === "playing-next"
                      ? (dropList === "queue" ? "active" : "available")
                      : undefined
                  }
                >
                  <div className="min-w-0">
                    <h3 className="text-[11px] font-semibold uppercase tracking-[0.08em] text-[var(--color-text-primary)]">
                      {isQueue ? t("panel.queue") : t("panel.playingNext")}
                    </h3>
                    <p className="mt-1 text-[10px] tabular-nums text-[var(--color-text-muted)]">
                      {tracks.length} tracks · {formatDuration(duration)}
                      {!isQueue && queueTracks.length > 0 ? ` · after ${queueTracks.length} queued` : ""}
                    </p>
                  </div>
                  {isQueue && queueTracks.length > 0 && (
                    <button
                      className="ml-auto text-[11px] text-[var(--color-text-secondary)] transition-colors hover:text-[var(--color-text-primary)]"
                      onClick={onClearQueue}
                      title="Clear queue"
                      aria-label="Clear queue"
                      type="button"
                    >
                      Clear
                    </button>
                  )}
                  {isQueue && queueTracks.length === 0 && dropList === "queue" && (
                    <span className="absolute inset-x-3 bottom-0 h-px bg-[var(--color-accent)]" />
                  )}
                </div>
              );
            }

            if (item.kind === "empty") {
              return (
                <div
                  key="playing-next-empty"
                  className="absolute left-0 top-0 flex w-full flex-col items-center justify-center px-6 text-center text-[var(--color-text-muted)]"
                  style={wrapperStyle}
                  data-playing-next-empty
                >
                  <Music2 className="mb-2 h-4 w-4" />
                  <p className="text-xs">Nothing is playing next</p>
                  <p className="mt-1 text-[10px]">Start a track from a list to see what follows.</p>
                </div>
              );
            }

            const { list, track, trackIndex } = item;
            const tracks = list === "queue" ? queueTracks : playingNextTracks;
            const isDragging = dragList === list && dragIndex === trackIndex;
            const isCurrentQueueTrack = currentTrack?.id === track.id;
            const showDropBefore =
              dropList === list && dropIndex === trackIndex;
            const showDropAfter =
              dropList === list &&
              dropIndex === tracks.length &&
              trackIndex === tracks.length - 1;
            const itemKey = `${list}:${trackIndex}`;

            return (
              <div
                key={`${list}-${track.id}-${trackIndex}`}
                className="absolute left-0 top-0 w-full"
                style={wrapperStyle}
              >
                {showDropBefore && <div className="absolute -top-px left-3 right-3 z-10 h-px bg-[var(--color-accent)]" />}
                <div
                  ref={(element) => {
                    if (element) itemRefsRef.current.set(itemKey, element);
                    else itemRefsRef.current.delete(itemKey);
                  }}
                  onMouseDown={(event) => handleMouseDown(event, list, trackIndex)}
                  className={`group grid min-h-[49px] cursor-grab grid-cols-[16px_20px_minmax(0,1fr)_44px_38px_24px] items-center gap-1.5 border-b border-[var(--color-border-light)] px-3 text-[10px] active:cursor-grabbing ${isDragging ? "opacity-25" : "hover:bg-[var(--color-bg-hover)]"}`}
                  data-queue-track={list === "queue" ? true : undefined}
                  data-playing-next-track={list === "playing-next" ? true : undefined}
                >
                  {isCurrentQueueTrack
                    ? <AudioLines className="h-3.5 w-3.5 text-[var(--color-accent)]" />
                    : <GripVertical className="h-3.5 w-3.5 text-[var(--color-text-muted)] opacity-60" />}
                  <span className="text-center tabular-nums text-[var(--color-text-muted)]">{trackIndex + 1}</span>
                  <div className="min-w-0"><div className="truncate text-[12px] font-medium text-[var(--color-text-primary)]">{track.title}</div><div className="mt-0.5 truncate text-[10px] text-[var(--color-text-muted)]">{track.artist}</div></div>
                  <div className="text-right tabular-nums"><div className="font-semibold text-[var(--color-accent)]">{track.key || "—"}</div><div className="mt-0.5 text-[var(--color-text-muted)]">{track.bpm ? track.bpm.toFixed(1) : "—"}</div></div>
                  <span className="text-right tabular-nums text-[var(--color-text-secondary)]">{track.duration}</span>
                  {list === "queue" ? (
                    <button data-no-drag onClick={() => onRemoveFromQueue(trackIndex)} className="toolbar-icon-button h-6 w-6 opacity-0 group-hover:opacity-100" title="Remove from queue" aria-label={`Remove ${track.title} from queue`} type="button"><X className="h-3.5 w-3.5" /></button>
                  ) : (
                    <span aria-hidden="true" />
                  )}
                </div>
                {showDropAfter && <div className="absolute -bottom-px left-3 right-3 z-10 h-px bg-[var(--color-accent)]" />}
              </div>
            );
          })}
        </div>
      </div>

      {draggedTrack && dragIndex !== null && (
        <div className="pointer-events-none fixed z-50 border border-[var(--color-border)] bg-[var(--color-bg-tertiary)] px-3 py-2 shadow-[var(--shadow-lg)]" style={{ left: containerRef.current?.getBoundingClientRect().left ?? 0, top: dragY, width: containerRef.current?.getBoundingClientRect().width ?? 240 }}>
          <div className="truncate text-xs font-medium text-[var(--color-text-primary)]">{draggedTrack.title}</div>
          <div className="truncate text-[10px] text-[var(--color-text-muted)]">{draggedTrack.artist}</div>
        </div>
      )}
        </>
      ) : (
        <MixSuggestions
          tracks={allTracks}
          currentTrack={currentTrackDetails}
          queuedTrackIds={queueTracks.map((track) => track.id)}
          currentPlaylistTrackIds={currentPlaylist?.trackIds}
          onPlayTrack={onPlayTrack}
          onPlayNext={onPlayNext}
          onMixWithCurrent={onMixWithCurrent}
        />
      )}
    </aside>
  );
};
