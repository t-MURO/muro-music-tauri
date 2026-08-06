import { memo, useRef } from "react";
import { Circle, FileWarning, Music2, Play } from "lucide-react";
import { convertFileSrc } from "@muro/desktop/runtime";
import { t } from "../../i18n";
import type { ColumnConfig, Track } from "../../types";
import {
  albumArtistCredits,
  explicitAlbumArtistDisplay,
  trackArtistCredits,
  type ArtistTarget,
} from "../../utils/artistCredits";
import { getCamelotColor } from "../../utils/camelot";
import { ArtistCreditLinks } from "./ArtistCreditLinks";
import { RatingCell } from "./RatingCell";

type TableRowProps = {
  track: Track;
  index: number;
  isSelected: boolean;
  isPlayingTrack: boolean;
  isCurrentlyPlaying: boolean;
  visibleColumns: ColumnConfig[];
  gridTemplateColumns: string;
  tableWidth: number;
  virtualStart: number;
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
  onOpenArtist?: (artist: ArtistTarget) => void;
  onOpenAlbum?: (trackId: string) => void;
  onAlbumContextMenu?: (event: React.MouseEvent, trackId: string) => void;
  onRatingChange: (id: string, rating: number) => void;
};

const formatFileSize = (bytes: number) => {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  const unitIndex = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)) - 1, units.length - 1);
  const value = bytes / (1024 ** (unitIndex + 1));
  return `${value.toFixed(value >= 10 ? 1 : 2)} ${units[unitIndex]}`;
};

const getColumnDisplayValue = (track: Track, key: ColumnConfig["key"]) => {
  switch (key) {
    case "artists":
      return explicitAlbumArtistDisplay(track);
    case "trackNumber":
      return track.trackNumber === undefined || track.trackNumber === null
        ? ""
        : String(track.trackNumber);
    case "trackTotal":
      return track.trackTotal === undefined || track.trackTotal === null
        ? ""
        : String(track.trackTotal);
    case "discNumber":
      return track.discNumber === undefined || track.discNumber === null
        ? ""
        : String(track.discNumber);
    case "key":
      return track.key ?? "";
    case "bpm":
      return track.bpm === undefined || track.bpm === null
        ? ""
        : track.bpm.toFixed(1);
    case "sampleRate":
      return track.sampleRate && track.sampleRate > 0
        ? `${Number((track.sampleRate / 1000).toFixed(1))} kHz`
        : "";
    case "bitDepth":
      return track.bitDepth && track.bitDepth > 0 ? `${track.bitDepth}-bit` : "";
    case "fileSize":
      return track.fileSize === undefined || track.fileSize < 0
        ? ""
        : formatFileSize(track.fileSize);
    case "format": {
      const pathParts = track.sourcePath.split(/[\\/]/);
      const filename = pathParts[pathParts.length - 1] ?? "";
      const extensionParts = filename.split(".");
      const extension = filename.includes(".") ? extensionParts[extensionParts.length - 1] : "";
      return extension?.toUpperCase() ?? "";
    }
    case "year":
      return track.year === undefined || track.year === null
        ? ""
        : String(track.year);
    case "date":
      return track.date ?? "";
    case "dateAdded":
      return track.dateAdded ?? "";
    case "dateModified":
      return track.dateModified ?? "";
    case "lastPlayedAt": {
      if (!track.lastPlayedAt) return "";
      const parsed = new Date(track.lastPlayedAt);
      return Number.isNaN(parsed.valueOf())
        ? track.lastPlayedAt
        : parsed.toLocaleString([], { dateStyle: "medium", timeStyle: "short" });
    }
    default: {
      const value = track[key as keyof Track];
      return value === undefined || value === null ? "" : String(value);
    }
  }
};

export const TableRow = memo(
  ({
    track,
    index,
    isSelected,
    isPlayingTrack,
    isCurrentlyPlaying,
    visibleColumns,
    gridTemplateColumns,
    tableWidth,
    virtualStart,
    onRowSelect,
    onRowDragStart,
    onRowDrag,
    onRowDragEnd,
    onRowContextMenu,
    onRowDoubleClick,
    onOpenArtist,
    onOpenAlbum,
    onAlbumContextMenu,
    onRatingChange,
  }: TableRowProps) => {
    const dragStartedOnInteractiveControlRef = useRef(false);
    const coverPath = track.coverArtThumbPath || track.coverArtPath;
    const isActivelyPlaying = isPlayingTrack && isCurrentlyPlaying;
    const rowBaseClass = isActivelyPlaying
      ? "bg-[var(--color-row-playing)] hover:bg-[var(--color-row-playing-hover)]"
      : isSelected
        ? "bg-[var(--color-row-selected)] hover:bg-[var(--color-row-selected-hover)]"
        : "bg-[var(--color-bg-primary)] hover:bg-[var(--color-bg-hover)]";
    const stickyCellClass = isActivelyPlaying
      ? "bg-[var(--color-row-playing)] group-hover:bg-[var(--color-row-playing-hover)]"
      : isSelected
        ? "bg-[var(--color-row-selected)] group-hover:bg-[var(--color-row-selected-hover)]"
        : "bg-[var(--color-bg-primary)] group-hover:bg-[var(--color-bg-hover)]";

    return (
      <div
        className={`group grid select-none items-center border-b border-[var(--color-border-light)] text-[12px] text-[var(--color-text-secondary)] ${rowBaseClass}`}
        style={{
          gridTemplateColumns,
          height: "var(--table-row-height)",
          position: "absolute",
          top: virtualStart,
          left: 0,
          width: "100%",
          minWidth: tableWidth,
        }}
        onClick={(event) => {
          event.stopPropagation();
          onRowSelect(index, track.id, {
            isMetaKey: event.metaKey || event.ctrlKey,
            isShiftKey: event.shiftKey,
          });
        }}
        onDoubleClick={() => {
          onRowDoubleClick?.(track.id);
        }}
        draggable={!track.isMissing && Boolean(track.sourcePath)}
        onMouseDownCapture={(event) => {
          const target = event.target as HTMLElement | null;
          dragStartedOnInteractiveControlRef.current = Boolean(
            target?.closest("button, input, select, textarea, [contenteditable='true']")
          );
        }}
        onDragStart={(event) => {
          if (dragStartedOnInteractiveControlRef.current) {
            event.preventDefault();
            return;
          }
          onRowDragStart(event, track.id);
        }}
        onDrag={onRowDrag}
        onDragEnd={() => {
          dragStartedOnInteractiveControlRef.current = false;
          onRowDragEnd();
        }}
        onContextMenu={(event) =>
          onRowContextMenu(event, track.id, index, isSelected)
        }
        data-track-index={index}
        data-track-selected={isSelected ? "true" : "false"}
        data-track-playing={isPlayingTrack ? "true" : "false"}
        data-native-file-draggable={!track.isMissing && Boolean(track.sourcePath) ? "true" : "false"}
        role="row"
      >
        <div
          className={`sticky left-0 z-30 flex h-[var(--table-row-height)] items-center justify-center border-r border-[var(--color-border-light)] ${stickyCellClass}`}
          role="cell"
        >
          <span
            className={`flex h-[calc(var(--table-row-height)-8px)] w-[calc(var(--table-row-height)-8px)] max-h-10 max-w-10 items-center justify-center overflow-hidden rounded-[var(--radius-sm)] border bg-[var(--color-bg-tertiary)] text-[var(--color-text-muted)] ${isActivelyPlaying ? "border-[var(--color-danger)]" : isSelected ? "border-[var(--color-text-muted)]" : "border-[var(--color-border-light)]"}`}
            data-track-thumbnail
          >
            {coverPath ? (
              <img
                src={convertFileSrc(coverPath)}
                alt=""
                className="h-full w-full object-cover"
                draggable={false}
                data-track-thumbnail-image
              />
            ) : (
              <Music2 className="h-3.5 w-3.5" aria-hidden="true" />
            )}
          </span>
        </div>
        {visibleColumns.map((column) => {
          const value = getColumnDisplayValue(track, column.key);
          if (column.key === "rating") {
            const currentRating = Number(track.rating) || 0;
            return (
              <RatingCell
                key={column.key}
                trackId={track.id}
                title={track.title}
                rating={currentRating}
                onRate={onRatingChange}
              />
            );
          }
          const isTitleColumn = column.key === "title";
          const textColorClass = isTitleColumn && isPlayingTrack ? "text-[var(--color-accent)]" : "";
          const numericClass = column.key === "bpm" || column.key === "duration" || column.key === "bitrate" || column.key === "discNumber" || column.key === "playCount" || column.key === "sampleRate" || column.key === "bitDepth" || column.key === "fileSize" ? "tabular-nums" : "";
          const camelotColor = column.key === "key" ? getCamelotColor(value) : null;
          const keyClass = column.key === "key" && value && !camelotColor ? "font-semibold text-[var(--color-accent)]" : "";
          const isArtistLink = (
            column.key === "artist" || column.key === "artists"
          ) && Boolean(value) && Boolean(onOpenArtist);
          const isAlbumLink = column.key === "album" && Boolean(value) && Boolean(onOpenAlbum);
          return (
            <div
              key={column.key}
              className={`flex h-[var(--table-row-height)] items-center border-l border-[var(--color-border-light)] px-3 ${isTitleColumn ? "font-medium text-[var(--color-text-primary)]" : ""} ${numericClass} ${keyClass} ${textColorClass}`}
              data-column-key={column.key}
              role="cell"
              onContextMenu={column.key === "album" && onAlbumContextMenu
                ? (event) => {
                    event.preventDefault();
                    event.stopPropagation();
                    onAlbumContextMenu(event, track.id);
                  }
                : undefined}
            >
              {isTitleColumn && (
                track.isMissing
                  ? (
                    <FileWarning
                      aria-label={t("track.missing")}
                      className="mr-2 h-3 w-3 shrink-0 text-amber-500"
                      data-track-missing
                    >
                      <title>{t("track.missing")}</title>
                    </FileWarning>
                  )
                  : isPlayingTrack
                    ? <Play className={`mr-2 h-3 w-3 shrink-0 text-[var(--color-accent)] ${isCurrentlyPlaying ? "opacity-100" : "opacity-70"}`} fill="currentColor" />
                    : <Circle className="mr-2 h-2 w-2 shrink-0 text-[var(--color-text-muted)]" fill="currentColor" strokeWidth={0} />
              )}
              {camelotColor ? (
                <span
                  className="block min-w-[34px] truncate rounded-[var(--radius-sm)] px-2 py-0.5 text-center text-[10px] font-bold text-[#172126] shadow-[inset_0_0_0_1px_rgba(0,0,0,0.12)]"
                  style={{ backgroundColor: camelotColor }}
                  data-track-key-color={camelotColor}
                >
                  {value.trim()}
                </span>
              ) : isArtistLink ? (
                <ArtistCreditLinks
                  display={value}
                  credits={column.key === "artist"
                    ? trackArtistCredits(track)
                    : albumArtistCredits(track, { fallbackToTrack: false })}
                  kind={column.key === "artists" ? "album" : "track"}
                  onOpenArtist={onOpenArtist!}
                />
              ) : isAlbumLink ? (
                <button
                  type="button"
                  className="min-w-0 max-w-full truncate text-left transition-colors hover:text-[var(--color-accent)] hover:underline focus-visible:text-[var(--color-accent)] focus-visible:underline focus-visible:outline-none"
                  title={`Open album ${value}`}
                  onClick={(event) => {
                    event.stopPropagation();
                    onOpenAlbum?.(track.id);
                  }}
                  onDoubleClick={(event) => event.stopPropagation()}
                  data-track-album-link="true"
                >
                  {value}
                </button>
              ) : (
                <span
                  className="block truncate"
                  title={column.key === "sourcePath" || column.key === "comment" ? value : undefined}
                >
                  {value}
                </span>
              )}
            </div>
          );
        })}
      </div>
    );
  }
);
