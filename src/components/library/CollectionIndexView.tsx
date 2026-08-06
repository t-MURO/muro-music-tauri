import { ArrowRight, Badge, KeyRound, Tag } from "lucide-react";
import type { CSSProperties } from "react";
import type { Track } from "../../types";
import { getCamelotColor, toCamelotCode } from "../../utils/camelot";

export type CollectionIndexFacet = "genres" | "labels" | "keys";

export type CollectionIndexItem = {
  value: string;
  count: number;
  color: string | null;
};

const compareCollectionItems = (
  left: CollectionIndexItem,
  right: CollectionIndexItem,
  facet: CollectionIndexFacet,
) => {
  if (facet === "keys") {
    const leftCode = toCamelotCode(left.value);
    const rightCode = toCamelotCode(right.value);
    if (leftCode && rightCode) {
      const numberDifference = Number(leftCode.slice(0, -1)) - Number(rightCode.slice(0, -1));
      if (numberDifference !== 0) return numberDifference;
      return leftCode.localeCompare(rightCode);
    }
    if (leftCode) return -1;
    if (rightCode) return 1;
  }
  return left.value.localeCompare(right.value, undefined, { sensitivity: "base" });
};

export const buildCollectionIndexItems = (
  tracks: Track[],
  facet: CollectionIndexFacet,
): CollectionIndexItem[] => {
  const items = new Map<string, CollectionIndexItem>();

  tracks.forEach((track) => {
    const rawValue = facet === "genres"
      ? track.genre
      : facet === "labels"
        ? track.label
        : track.key;
    const trimmedValue = rawValue?.trim();
    if (!trimmedValue) return;

    const value = facet === "keys" ? toCamelotCode(trimmedValue) ?? trimmedValue : trimmedValue;
    const identity = value.toLocaleLowerCase();
    const existing = items.get(identity);
    if (existing) {
      existing.count += 1;
      return;
    }

    items.set(identity, {
      value,
      count: 1,
      color: facet === "keys" ? getCamelotColor(value) : null,
    });
  });

  return [...items.values()].sort((left, right) => compareCollectionItems(left, right, facet));
};

type CollectionIndexViewProps = {
  facet: CollectionIndexFacet;
  items: CollectionIndexItem[];
  onSelect: (value: string) => void;
};

export const CollectionIndexView = ({ facet, items, onSelect }: CollectionIndexViewProps) => {
  const Icon = facet === "keys" ? KeyRound : facet === "labels" ? Badge : Tag;
  const singularLabel = facet === "keys" ? "key" : facet === "labels" ? "release label" : "genre";

  return (
    <div
      className="collection-index min-h-0 flex-1 overflow-y-auto"
      data-collection-index={facet}
    >
      {items.length > 0 ? (
        <div className="collection-index-grid">
          {items.map((item) => (
            <button
              className={`collection-index-card collection-index-card--${facet}`}
              data-collection-color={item.color ?? undefined}
              data-collection-count={item.count}
              data-collection-value={item.value}
              key={item.value}
              onClick={() => onSelect(item.value)}
              style={
                item.color
                  ? ({ "--collection-key-color": item.color } as CSSProperties)
                  : undefined
              }
              type="button"
            >
              <span className="collection-index-icon" aria-hidden="true">
                <Icon />
              </span>
              <span className="min-w-0 flex-1 text-left">
                <strong>{item.value}</strong>
                <span>{item.count.toLocaleString()} {item.count === 1 ? "track" : "tracks"}</span>
              </span>
              <ArrowRight className="collection-index-arrow" aria-hidden="true" />
            </button>
          ))}
        </div>
      ) : (
        <div className="collection-index-empty">
          <Icon aria-hidden="true" />
          <strong>No {facet} found</strong>
          <span>Add {singularLabel} metadata to tracks to populate this collection.</span>
        </div>
      )}
    </div>
  );
};
