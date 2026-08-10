import type { ColumnConfig, Track } from "../types";
import { explicitAlbumArtistDisplay } from "./artistCredits";
import { formatPlaylistMembership, type TrackPlaylistMembership } from "./playlistMembership";

/**
 * Gets a sortable value from a track based on the column key.
 * Handles special cases like dates, optional fields, and composite fields.
 */
export const getSortableValue = (
  track: Track,
  key: ColumnConfig["key"],
  playlistMembershipByTrackId?: ReadonlyMap<string, readonly TrackPlaylistMembership[]>,
): string | number | null => {
  switch (key) {
    case "duration":
      return track.durationSeconds;
    case "rating":
      return track.rating;
    case "trackNumber":
      return track.trackNumber ?? null;
    case "trackTotal":
      return track.trackTotal ?? null;
    case "discNumber":
      return track.discNumber ?? null;
    case "year":
      return track.year ?? null;
    case "bpm":
      return track.bpm ?? null;
    case "artists":
      return explicitAlbumArtistDisplay(track) || null;
    case "playlists":
      return formatPlaylistMembership(playlistMembershipByTrackId?.get(track.id)) || null;
    case "key":
      return track.key ?? null;
    case "format": {
      const pathParts = track.sourcePath.split(/[\\/]/);
      const filename = pathParts[pathParts.length - 1] ?? "";
      const extensionParts = filename.split(".");
      return filename.includes(".")
        ? (extensionParts[extensionParts.length - 1]?.toUpperCase() ?? null)
        : null;
    }
    case "date":
    case "dateAdded":
    case "dateModified":
    case "lastPlayedAt": {
      const raw =
        key === "date"
          ? track.date
          : key === "dateAdded"
            ? track.dateAdded
            : key === "dateModified"
              ? track.dateModified
              : track.lastPlayedAt;
      if (!raw) {
        return null;
      }
      const parsed = Date.parse(raw);
      return Number.isNaN(parsed) ? raw : parsed;
    }
    default: {
      const value = track[key as keyof Track];
      return typeof value === "string" || typeof value === "number" ? value : null;
    }
  }
};

/**
 * Compares two sortable values for ordering.
 * Handles both numeric and string comparisons with locale-aware string sorting.
 */
export const compareSortValues = (
  left: string | number,
  right: string | number
): number => {
  if (typeof left === "number" && typeof right === "number") {
    return left - right;
  }
  return String(left).localeCompare(String(right), undefined, {
    numeric: true,
    sensitivity: "base",
  });
};
