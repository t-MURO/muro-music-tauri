import { Star } from "lucide-react";
import { memo, useState } from "react";

type RatingCellProps = {
  trackId: string;
  title: string;
  rating: number;
  onRate: (id: string, rating: number) => void;
  compact?: boolean;
};

export const RatingCell = memo(
  ({ trackId, title, rating, onRate, compact = false }: RatingCellProps) => {
    const [hoverValue, setHoverValue] = useState<number | null>(null);
    const displayRating = hoverValue ?? rating;

    return (
      <div
        className={compact
          ? "flex min-w-0 items-center"
          : "flex h-[var(--table-row-height)] min-w-0 items-center overflow-hidden border-l border-[var(--color-border-light)] px-1"}
        title={`Rating: ${rating} / 5`}
        onMouseLeave={() => setHoverValue(null)}
        data-rating-cell={compact ? undefined : true}
        data-player-rating={compact ? true : undefined}
        role={compact ? undefined : "cell"}
      >
        <div
          className={`flex min-w-0 items-center rounded-[var(--radius-sm)] ${compact ? "justify-start" : "w-full justify-center"}`}
          aria-label={`Rating for ${title}`}
          role="slider"
          tabIndex={0}
          aria-valuemin={0}
          aria-valuemax={5}
          aria-valuenow={rating}
          aria-valuetext={`${rating} out of 5`}
          onKeyDown={(event) => {
            const step = 0.5;
            if (event.key === "ArrowRight" || event.key === "ArrowUp") {
              event.preventDefault();
              onRate(trackId, rating + step);
            }
            if (event.key === "ArrowLeft" || event.key === "ArrowDown") {
              event.preventDefault();
              onRate(trackId, rating - step);
            }
            if (
              event.key === "Home" ||
              event.key === "0" ||
              event.key === "Backspace" ||
              event.key === "Delete"
            ) {
              event.preventDefault();
              setHoverValue(null);
              onRate(trackId, 0);
            }
            if (event.key === "End") {
              event.preventDefault();
              onRate(trackId, 5);
            }
          }}
        >
          {[1, 2, 3, 4, 5].map((star) => {
            const fill = Math.max(0, Math.min(1, displayRating - (star - 1)));
            return (
              <button
                key={star}
                aria-label={rating === star ? "Clear rating" : `Set rating to ${star} stars`}
                className="relative h-3.5 w-3.5 shrink-0 select-none text-[var(--color-text-muted)] focus:outline-none"
                data-rating-star={star}
                tabIndex={-1}
                onClick={(event) => {
                  event.stopPropagation();
                  if (rating === star) {
                    setHoverValue(null);
                    onRate(trackId, 0);
                    return;
                  }
                  const rect = event.currentTarget.getBoundingClientRect();
                  const isHalf = event.clientX - rect.left < rect.width / 2;
                  const nextRating = isHalf ? star - 0.5 : star;
                  const resolvedRating = nextRating === rating ? 0 : nextRating;
                  if (resolvedRating === 0) setHoverValue(null);
                  onRate(trackId, resolvedRating);
                }}
                onMouseMove={(event) => {
                  const rect = event.currentTarget.getBoundingClientRect();
                  const isHalf = event.clientX - rect.left < rect.width / 2;
                  setHoverValue(isHalf ? star - 0.5 : star);
                }}
                type="button"
              >
                <Star className="absolute inset-0 h-3.5 w-3.5" strokeWidth={1.5} />
                <span className="absolute inset-0 overflow-hidden text-[var(--color-rating-star)]" data-rating-fill style={{ width: `${fill * 100}%` }}>
                  <Star className="h-3.5 w-3.5 max-w-none" fill="currentColor" strokeWidth={1.5} />
                </span>
              </button>
            );
          })}
        </div>
      </div>
    );
  }
);
