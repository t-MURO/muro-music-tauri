import { forwardRef } from "react";
import { Music2, X } from "lucide-react";
import { convertFileSrc } from "@muro/desktop/runtime";
import type { Track } from "../../types";

type QueueItemProps = {
  track: Track;
  index: number;
  isDragging: boolean;
  onMouseDown: (e: React.MouseEvent, index: number) => void;
  onRemove: (index: number) => void;
};

export const QueueItem = forwardRef<HTMLDivElement, QueueItemProps>(
  ({ track, index, isDragging, onMouseDown, onRemove }, ref) => {
    return (
      <div
        ref={ref}
        onMouseDown={(e) => onMouseDown(e, index)}
        className={`group flex cursor-grab items-center gap-2.5 px-[var(--spacing-lg)] py-1.5 transition-colors active:cursor-grabbing ${
          isDragging ? "opacity-30" : "hover:bg-[var(--color-bg-hover)]"
        }`}
      >
        <div className="h-10 w-10 flex-shrink-0 overflow-hidden rounded-[var(--radius-sm)] bg-[var(--color-bg-tertiary)]">
          {track.coverArtPath ? (
            <img
              src={convertFileSrc(track.coverArtPath)}
              alt=""
              className="h-full w-full object-cover"
            />
          ) : (
            <div className="flex h-full w-full items-center justify-center text-[var(--color-text-muted)]">
              <Music2 className="h-4 w-4" />
            </div>
          )}
        </div>
        <div className="min-w-0 flex-1">
          <div className="truncate text-[var(--font-size-sm)] font-medium text-[var(--color-text-primary)]">
            {track.title}
          </div>
          <div className="truncate text-[var(--font-size-xs)] font-light text-[var(--color-text-secondary)]">
            {track.artist}
          </div>
        </div>
        <button
          data-no-drag
          onClick={() => onRemove(index)}
          className="flex-shrink-0 rounded p-1 text-[var(--color-text-muted)] opacity-0 transition-all hover:bg-[var(--color-bg-tertiary)] hover:text-[var(--color-text-primary)] group-hover:opacity-100"
          title="Remove from queue"
        >
          <X className="h-4 w-4" />
        </button>
      </div>
    );
  }
);

QueueItem.displayName = "QueueItem";
